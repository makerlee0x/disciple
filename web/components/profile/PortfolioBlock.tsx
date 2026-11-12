"use client";
/**
 * Profile r5 portfolio block (own and public profiles): total, change over the picked range, the line chart, and the
 * Cash / Rockets split under it. Numbers are live (components/profile/LiveHoldings → lib/portfolio). The line is the
 * current holdings priced over the range (lib/portfolioHistory; no stored portfolio history exists). No gold here.
 */
import { useEffect, useMemo, useState } from "react";
import { withBase } from "@/lib/base-path";
import { CURVE } from "@/lib/config";
import { TOTAL_SUPPLY_TOKENS, type Fill } from "@/lib/trades";
import { PF_RANGES, portfolioSeries, seriesChange, type PfRange, type PricePoint } from "@/lib/portfolioHistory";
import type { LivePortfolio } from "./LiveHoldings";
import { moneyParts, signedUsd2, usd2 } from "./money";

const LAUNCH_PRICE = CURVE.startMcap / TOTAL_SUPPLY_TOKENS;
const fillsCache = new Map<string, Promise<PricePoint[]>>();
function coinFills(coin: string): Promise<PricePoint[]> {
  const k = coin.toLowerCase();
  let p = fillsCache.get(k);
  if (!p) {
    p = fetch(withBase(`/api/trades?coin=${k}&order=desc&limit=2000`)).then((r) => (r.ok ? r.json() : {}))
      .then((j: { fills?: Fill[] }) => (j.fills ?? []).map((f) => ({ ts: f.ts, priceUsd: f.priceUsd })))
      .catch(() => []);
    fillsCache.set(k, p);
  }
  return p;
}

const W = 1000;
function path(vals: number[], H: number): { d: string; end: { x: number; y: number } } {
  const pad = 10;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pts = vals.map((v, i) => ({ x: (W * i) / (vals.length - 1), y: pad + (H - 2 * pad) * (1 - (v - lo) / (hi - lo)) }));
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) { // Catmull-Rom → cubic Bézier
    const p0 = pts[Math.max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(i + 2, pts.length - 1)];
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 }, c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C${c1.x.toFixed(1)},${c1.y.toFixed(1)} ${c2.x.toFixed(1)},${c2.y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return { d, end: pts[pts.length - 1] };
}

function Chart({ vals, up, H }: { vals: number[]; up: boolean; H: number }) {
  const { d, end } = useMemo(() => path(vals, H), [vals, H]);
  const tint = up ? "95,240,160" : "240,48,127", gid = `p5g${up ? "u" : "d"}`;
  return (
    <div className="p5-chart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="none" aria-hidden>
        <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={`rgba(${tint},.10)`} /><stop offset=".45" stopColor="rgba(201,206,214,.05)" /><stop offset="1" stopColor="rgba(201,206,214,0)" />
        </linearGradient></defs>
        <path d={`${d} L${W},${H} L0,${H} Z`} fill={`url(#${gid})`} />
        <path d={d} fill="none" stroke="rgba(226,229,234,.82)" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} stroke="rgba(201,206,214,.10)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="p5-dot" style={{ left: `calc(${(end.x / W) * 100}% - 4px)`, top: `calc(${(end.y / H) * 100}% - 4px)` }} />
    </div>
  );
}

function Ranges({ value, onChange, className }: { value: PfRange; onChange: (r: PfRange) => void; className: string }) {
  return (
    <div className={`p5-rtabs ${className}`} role="tablist" aria-label="Chart range">
      {PF_RANGES.map((r) => (
        <button key={r} type="button" role="tab" aria-selected={value === r} className={value === r ? "on" : ""} onClick={() => onChange(r)}>{r}</button>
      ))}
    </div>
  );
}

/** With `title` (the Hangar): a panel of just the chart, its change and the ranges; the totals live in the service record. */
export default function PortfolioBlock({ pf, isPrivate, title }: { pf: LivePortfolio | null; isPrivate: boolean; title?: string }) {
  const [range, setRange] = useState<PfRange>("24H");
  const [fills, setFills] = useState<Record<string, PricePoint[]> | null>(null);
  const coins = pf?.rows.map((r) => r.coin.toLowerCase()).join(",") ?? "";
  useEffect(() => {
    setFills(null);
    if (!pf || !pf.ok) return;
    const list = coins ? coins.split(",") : [];
    let alive = true;
    Promise.all(list.map((c) => coinFills(c).then((f) => [c, f] as const))).then((rows) => { if (alive) setFills(Object.fromEntries(rows)); });
    return () => { alive = false; };
  }, [coins, pf]);

  const total = pf && pf.ok ? pf.cashUsd + pf.rows.reduce((s, r) => s + r.usd, 0) : null;
  const rocketsUsd = pf && pf.ok ? pf.rows.reduce((s, r) => s + r.usd, 0) : null;
  const series = useMemo(() => {
    if (!pf || !pf.ok || !fills) return null;
    return portfolioSeries(pf.cashUsd, pf.rows.map((r) => ({ tokens: r.tokens, priceNow: r.priceNow, fills: fills[r.coin.toLowerCase()] ?? [] })), range, Date.now(), LAUNCH_PRICE);
  }, [pf, fills, range]);
  const chg = series ? seriesChange(series) : 0;
  const zero = total != null && total < 0.005;
  const cls = !series || Math.abs(chg) < 0.005 ? "muted" : chg > 0 ? "up" : "down";
  const { whole, cents } = moneyParts(total ?? 0);
  const rangeLabel = range === "ALL" ? "all time" : range.toLowerCase();

  const chart = zero ? (
    <div className="p5-chart p5-flat">
      {isPrivate && <span className="p5-note">Your chart starts with your first BOOST.</span>}
    </div>
  ) : series ? <Chart vals={series.map((p) => p.v)} up={chg >= 0} H={150} /> : <div className="p5-chart" />;
  if (title) return (
    <section className="dsc3-panel hg-panel hg-alt" aria-label={title}>
      <header className="hg-panelh">
        <div><h2>{title}</h2><span data-testid="portfolio-change">{series ? <b className={cls}>{signedUsd2(chg)}</b> : null} {rangeLabel === "all time" ? "all time" : `over ${rangeLabel}`}</span></div>
        <Ranges value={range} onChange={setRange} className="hg-ranges" />
      </header>
      {chart}
    </section>
  );
  return (
    <section className="p5-pf" aria-label="Portfolio" data-testid="profile-portfolio">
      <div className="p5-pf-top">
        <div className="p5-pf-val">
          <span className="p5-l">Portfolio</span>
          {total == null ? <span className="p5-big zero" aria-busy={!pf}>{pf ? "—" : <span className="p5-skel" />}</span> : (
            <span className={`p5-big ${zero ? "zero" : ""}`} data-testid="portfolio-total"><span className="s">$</span><span className="w">{whole}</span><span className="c">.{cents}</span></span>
          )}
          <span className="p5-chg" data-testid="portfolio-change">
            {series ? <span className={cls}>{signedUsd2(chg)}</span> : <span className="muted">{total == null ? "" : "…"}</span>}
            <span className="muted">{rangeLabel}</span>
          </span>
        </div>
        <Ranges value={range} onChange={setRange} className="p5-desk" />
      </div>
      {zero ? (
        <div className="p5-chart p5-flat">
          {isPrivate && <span className="p5-note">Your chart starts with your first BOOST.</span>}
        </div>
      ) : series ? <Chart vals={series.map((p) => p.v)} up={chg >= 0} H={150} /> : <div className="p5-chart" />}
      <Ranges value={range} onChange={setRange} className="p5-phone" />
      <div className="p5-figs">
        <div><span className="p5-l">Cash</span><span className={`p5-v ${zero ? "muted" : ""}`} data-testid="portfolio-cash">{pf && pf.ok ? usd2(pf.cashUsd) : "—"}</span></div>
        <div><span className="p5-l">Rockets</span><span className={`p5-v ${zero ? "muted" : ""}`} data-testid="portfolio-rockets">{rocketsUsd != null ? usd2(rocketsUsd) : "—"}</span></div>
      </div>
    </section>
  );
}
