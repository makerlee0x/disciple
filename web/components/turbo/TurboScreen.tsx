"use client";
/**
 * DISCIPLE Turbo — live trade screen (hidden /turbo; not in the public nav).
 *
 * v2 (maker signed off the "Turbo mockups" canvas, Nov 13 2026): every position is a RUN.
 *  - Ready: market, GEAR tiles (leverage presets with 1–4 chevrons and a typical run length), FUEL chips, the H-BOMB
 *    distance, then BOOST ▲ (long) / DUMP ▼ (short) in one tap.
 *  - Run: cash out now + multiple, heat (share of the way to the H-BOMB), market flow, BANK HALF and CASH OUT.
 *    Desktop adds the Your run card. Space = cash out, Q = bank half.
 *  - Result: Cashed out (multiple, money, run chart, streak, best today) or H-BOMB'd (how long you lasted), each with
 *    RUN IT BACK (same fuel, gear and side; never raised) and Share.
 *  - Sky: zoomed to the run (lib/turbo/flight.ts skyAlt). The H-BOMB, break-even and boarding lines are drawn by the
 *    engine from __turboFx.lines. Market cap stays a number on the market tab.
 * The engine never places trades; every tap goes to the adapter first.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useTurbo } from "@/lib/turbo/useTurbo";
import type { ClosePct, Market, MarketInfo, MarketTrade, Position, Side, TurboEvent } from "@/lib/turbo";
import { RUN_COPY as R, TURBO_COPY as C } from "@/lib/turbo/copy";
import { lev as fmtLev, price as fmtPrice, signedUsd, usd } from "@/lib/turbo/format";
import { DEFAULT_PREFS, FUEL_PRESETS, LEVERAGE_PRESETS, fuelOf, leverageOf, loadPrefs, savePrefs, type TurboPrefs } from "@/lib/turbo/prefs";
import { breakEvenPrice, cashOutNowUsd, dangerLevel, dangerOf, liqDistance, marketCapUsd, multiplePrice, paceLabel, typicalRunSeconds } from "@/lib/turbo/flight";
import { ROUTES } from "@/lib/turbo/routes";
import { withBase } from "@/lib/base-path";
import { bestToday, clock, createRunStore, longestAt, multipleLabel, streak, type TurboRun } from "@/lib/turbo/runs";
import { SETTINGS_OPEN_EVENT } from "@/lib/walletCta";
import { isSampleLink, SAMPLE_FUEL_USD, SAMPLE_GIVEN_KEY } from "@/lib/turbo/flag";
import TurboFlight, { type TurboFlightHandle } from "./TurboFlight";
import TurboFundingSheet from "./TurboFundingSheet";
import TurboHowItWorks from "./TurboHowItWorks";
import TurboShareCard, { type TurboShare } from "./TurboShareCard";
import TurboHBomb from "./TurboHBomb";
import s from "./run.module.css";
import old from "./turbo.module.css";

const MARKETS: Market[] = ["BTC", "ETH"];
const sideWord = (side: Side) => (side === "long" ? "BOOST" : "DUMP");
/** Whole dollars on the big price labels ($97,250), cents under $10k ($3,420.50). */
const px0 = (v: number) => (!(v > 0) ? "—" : usd(v, v >= 10_000 ? 0 : 2));
/** Market tabs: whole dollars from $1,000 ($3,420). */
const pxTab = (v: number) => (!(v > 0) ? "—" : usd(v, v >= 1000 ? 0 : 2));
const capLabel = (v: number) => (!(v > 0) ? "" : v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T cap` : `$${(v / 1e9).toFixed(0)}B cap`);
const bigUsd = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}K`);
const pctMove = (f: number) => `${(f * 100).toFixed(f < 0.001 ? 3 : 2).replace(/0$/, "")}%`;
/** Smallest print that shows as Big buy / Big sell in the market-flow pills. */
const FLOW_MIN: Record<Market, number> = { BTC: 100_000, ETH: 50_000 };

const Chevrons = ({ n }: { n: number }) => (
  <svg width={4 + n * 9} height="12" viewBox={`0 0 ${4 + n * 9} 12`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={Array.from({ length: n }, (_, i) => `M${4 + i * 9} 2l4 4-4 4`).join("")} />
  </svg>
);
const MenuIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M4 7h16M4 12h16M4 17h16" /></svg>;
const XIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>;
const PlusIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>;

interface RunTrack { id: string; fuelUsd: number; startedAt: number; peak: number; path: number[]; lastSample: number; side: Side; market: Market; leverage: number }
type Result = { run: TurboRun; entry: number; exit: number; liqMove?: number };
/** v2.1 liftoff: the pad stays up for the 3-2-1 while the order fills; it never delays the order itself. */
type Launch = { t0: number; side: Side; market: Market; leverage: number; fuelUsd: number; entry: number; liq: number; leaving?: boolean };
const COUNT_MS = 1800;

function RunChart({ path }: { path: number[] }) {
  const pts = path.length >= 2 ? path : [1, ...(path.length ? path : [1])];
  const W = 358, H = 150, lo = 0.2, hi = Math.max(1.2, ...pts) * 1.08;
  const x = (i: number) => 24 + (i / (pts.length - 1)) * (W - 52);
  const y = (m: number) => H - 22 - ((m - lo) / (hi - lo)) * (H - 40);
  const peakI = pts.indexOf(Math.max(...pts)), last = pts.length - 1;
  const d = pts.map((m, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(m).toFixed(1)}`).join(" ");
  const pctX = (i: number) => `${(x(i) / W) * 100}%`, pctY = (m: number) => `${(y(m) / H) * 100}%`;
  return (
    <div className={s.chart}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" fill="none" role="img" aria-label={`Run chart: peak ${multipleLabel(pts[peakI])}, cashed out at ${multipleLabel(pts[last])}`}>
        <path d={`M0 ${y(lo)}H${W}`} stroke="#F0307F" strokeWidth="1.5" strokeDasharray="4 4" />
        <path d={`M0 ${y(1)}H${W}`} stroke="rgba(243,223,168,0.5)" strokeWidth="1" strokeDasharray="3 3" />
        <path d={d} stroke="#F2C14E" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <circle cx={x(0)} cy={y(pts[0])} r="5" fill="#F3DFA8" />
        {peakI !== last && <circle cx={x(peakI)} cy={y(pts[peakI])} r="4" fill="#F2F3F7" />}
        <circle cx={x(last)} cy={y(pts[last])} r="6" fill="#5FF0A0" stroke="#121327" strokeWidth="2" />
      </svg>
      <span style={{ left: 12, top: `calc(${pctY(pts[0])} + 8px)`, color: "#F3DFA8" }}>{R.boarded}</span>
      {peakI !== last && <span style={{ left: `calc(${pctX(peakI)} - 26px)`, top: `calc(${pctY(pts[peakI])} - 18px)`, color: "#F2F3F7" }}>{R.peak(multipleLabel(pts[peakI]))}</span>}
      <span style={{ right: 8, top: `calc(${pctY(pts[last])} + 8px)`, color: "#5FF0A0" }}>{R.you}</span>
      <span style={{ right: 10, bottom: 4, color: "#FF7FB2" }}>{R.bombLine}</span>
    </div>
  );
}

function DetailSheet({ p, onClose }: { p: Position; onClose: () => void }) {
  const rows: [string, string][] = [
    [C.size, usd(p.sizeUsd)], [C.fuelIn, usd(p.collateralUsd)], [C.entry, fmtPrice(p.entry)], [C.now, fmtPrice(p.markPrice ?? p.entry)],
    [C.liq, fmtPrice(p.liqPrice)], [C.feesPaid, usd(p.openFeeUsd)], [C.closeFee, usd(p.closeFeeUsdEst)],
    [C.funding, p.fundingUsd === 0 ? C.fundingOffMarket : p.fundingUsd < 0 ? C.fundingPaid(signedUsd(p.fundingUsd)) : C.fundingReceived(signedUsd(p.fundingUsd))],
    [p.pnlUsd >= 0 ? C.pnlBefore : "Loss before fees", signedUsd(p.pnlUsd)],
  ];
  return (
    <div className={old.dim} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={R.feesLink} className={old.sheet} data-testid="turbo-detail">
        <button type="button" className={old.x} aria-label={R.close} onClick={onClose}>×</button>
        <div className={old.sheetTitle}>{R.feesLink}</div>
        {rows.map(([k, v]) => <div key={k} className={old.row}><span className={old.k}>{k}</span><span className={old.v}>{v}</span></div>)}
        <p className={old.feeFooter}>{C.feeFooter}</p>
      </div>
    </div>
  );
}

export default function TurboScreen() {
  const { adapter, prices, fuel, positions, lastEvent, standIn } = useTurbo();
  const [prefs, setPrefsState] = useState<TurboPrefs>(DEFAULT_PREFS);
  useEffect(() => { setPrefsState(loadPrefs()); }, []);
  const setPrefs = useCallback((p: TurboPrefs) => { setPrefsState(p); savePrefs(p); }, []);
  const market = prefs.market;
  const markets: MarketInfo[] = useMemo(() => adapter.getMarkets?.() ?? MARKETS.map((m) => ({ market: m, maxLeverage: 1000 })), [adapter]);
  const info = markets.find((m) => m.market === market);
  const fuelUsd = fuelOf(prefs), leverage = leverageOf(prefs);
  const px = prices[market];
  const hasPx = !!px && px > 0;

  const runs = useMemo(() => createRunStore(), []);
  const [, bumpRuns] = useState(0);

  const mine = positions.filter((p) => p.market === market);
  const active = mine[mine.length - 1] ?? null;
  const open_ = active?.status === "open";

  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const flash = useCallback((txt: string) => { setToast(txt); setTimeout(() => setToast((t) => (t === txt ? null : t)), 3200); }, []);
  const [sheet, setSheet] = useState<null | "fund" | "how" | "detail">(null);
  const [share, setShare] = useState<TurboShare | null>(null);
  const [nova, setNova] = useState<null | { short: boolean; label: string; result: Result }>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [launch, setLaunch] = useState<Launch | null>(null);
  const [tick, setTick] = useState(0);
  const [flow, setFlow] = useState<{ id: number; side: "buy" | "sell"; usd: number }[]>([]);
  const flight = useRef<TurboFlightHandle>(null);
  const [engineReady, setEngineReady] = useState(0);
  const track = useRef<Record<string, RunTrack>>({});
  const lastMid = useRef<Partial<Record<Market, number>>>({});
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(id); }, []);

  /* play sample link: one-time sample fuel on a fresh device (stand-in adapter only; never on Nova) */
  const sample = useMemo(() => isSampleLink(), []);
  useEffect(() => {
    if (!sample || !standIn || fuel == null || fuel > 0 || !adapter.addFuel) return;
    try { if (localStorage.getItem(SAMPLE_GIVEN_KEY) === "1") return; localStorage.setItem(SAMPLE_GIVEN_KEY, "1"); } catch { /* still top up once this visit */ }
    adapter.addFuel(SAMPLE_FUEL_USD).catch(() => {});
  }, [sample, standIn, fuel, adapter]);

  useEffect(() => { document.body.classList.add("turbo-game"); return () => document.body.classList.remove("turbo-game"); }, []);

  /* ---- quotes per gear (pace labels, H-BOMB distance) ---- */
  const gearQuotes = useMemo(() => LEVERAGE_PRESETS.map((lv) => {
    if (!hasPx) return null;
    const q = adapter.quote({ market, side: "long", collateralUsd: fuelUsd, leverage: lv });
    return { lev: lv, liqDist: liqDistance(q.entryEst, q.liqPrice) };
  }), [adapter, market, fuelUsd, hasPx, px]); // eslint-disable-line react-hooks/exhaustive-deps
  const selQuote = hasPx ? adapter.quote({ market, side: "long", collateralUsd: fuelUsd, leverage }) : null;
  const selLiqDist = selQuote ? liqDistance(selQuote.entryEst, selQuote.liqPrice) : 0;
  const levBlocked = (v: number) => !!info && v > info.maxLeverage;

  /* ---- taps: adapter first, visuals after (never awaited) ---- */
  const openRun = useCallback(async (side: Side, o?: { fuelUsd: number; leverage: number; market: Market }) => {
    if (busy) return;
    const f = o?.fuelUsd ?? fuelUsd, lv = o?.leverage ?? leverage, m = o?.market ?? market;
    if (fuel != null && f > fuel) { setSheet("fund"); return; }
    setBusy(true);
    try {
      const q = (() => { try { return adapter.quote({ market: m, side, collateralUsd: f, leverage: lv }); } catch { return null; } })();
      setLaunch({ t0: Date.now(), side, market: m, leverage: lv, fuelUsd: f, entry: q?.entryEst ?? 0, liq: q?.liqPrice ?? 0 });
      const r = adapter.open({ market: m, side, collateralUsd: f, leverage: lv });
      flight.current?.ignite();
      const { id } = await r;
      track.current[id] = { id, fuelUsd: f, startedAt: Date.now(), peak: 0, path: [], lastSample: 0, side, market: m, leverage: lv };
    } catch (e) { setLaunch(null); flash(e instanceof Error ? e.message : C.failed); }
    finally { setBusy(false); }
  }, [adapter, busy, flash, fuel, fuelUsd, leverage, market]);
  const close = useCallback(async (p: Position, pct: ClosePct) => {
    if (busy || p.status !== "open") return;
    setBusy(true);
    try { await adapter.close(p.id, pct); } catch (e) { flash(e instanceof Error ? e.message : C.failed); } finally { setBusy(false); }
  }, [adapter, busy, flash]);

  /* ---- live run numbers ---- */
  const tr = active ? track.current[active.id] : undefined;
  const fuelIn = tr?.fuelUsd ?? active?.collateralUsd ?? 0;
  const cashNow = active && open_ ? cashOutNowUsd(active) : 0;
  const realized = active?.realizedUsd ?? 0;
  const multiple = fuelIn > 0 ? (realized + cashNow) / fuelIn : 0;
  const upUsd = realized + cashNow - fuelIn;
  const danger = active && open_ ? dangerOf(active) : 0;
  const level = dangerLevel(danger);
  const red = open_ && (level === "shudder" || level === "blow");
  const evenPx = active && open_ ? breakEvenPrice(active) : 0;
  const elapsed = tr ? now - tr.startedAt : 0;

  // peak + chart samples (twice a second, max 80 points)
  useEffect(() => {
    if (!active || !open_ || !tr) return;
    if (multiple > tr.peak) tr.peak = multiple;
    if (now - tr.lastSample >= 500) {
      tr.lastSample = now; tr.path.push(+multiple.toFixed(3));
      if (tr.path.length > 80) tr.path = tr.path.filter((_, i) => i % 2 === 0);
    }
  }, [active, open_, tr, multiple, now]);

  /* ---- events → toasts, H-BOMB, results ---- */
  const seen = useRef<TurboEvent | null>(null);
  useEffect(() => {
    const e = lastEvent; if (!e || e === seen.current) return; seen.current = e;
    const p = e.position;
    const t = track.current[p.id] ?? (track.current[p.id] = { id: p.id, fuelUsd: p.collateralUsd, startedAt: p.openedAt ?? Date.now(), peak: 0, path: [], lastSample: 0, side: p.side, market: p.market, leverage: p.leverage });
    if (e.type === "filled") { t.startedAt = Date.now(); t.path = [cashOutNowUsd(p) / t.fuelUsd]; return; }
    if (e.type === "pending") return;
    if (e.type === "failed") { setLaunch(null); flash(C.failed); delete track.current[p.id]; return; }
    if (e.type === "partial-closed") { flash(R.banked(usd(e.returnedUsd ?? 0))); return; }
    const back = p.realizedUsd ?? 0, mult = t.fuelUsd > 0 ? back / t.fuelUsd : 0;
    const path = [...t.path, +mult.toFixed(3)];
    const run: TurboRun = { id: p.id, kind: e.type === "liquidated" ? "hbomb" : "cashed", market: p.market, side: p.side, leverage: p.leverage, fuelUsd: t.fuelUsd, backUsd: back, multiple: mult, startedAt: t.startedAt, endedAt: Date.now(), peakMultiple: Math.max(t.peak, mult), path };
    const exit = p.markPrice ?? p.entry;
    runs.add(run); bumpRuns((n) => n + 1); delete track.current[p.id];
    if (e.type === "liquidated") {
      const bombs = (() => { try { return localStorage.getItem("disciple.bombs") !== "off"; } catch { return true; } })();
      flight.current?.supernova(bombs);
      setNova({ short: !bombs, label: C.liquidatedToast(fmtLev(p.leverage)), result: { run, entry: p.entry, exit, liqMove: Math.abs(exit / p.entry - 1) } });
      return;
    }
    if (e.type === "closed") setResult({ run, entry: p.entry, exit });
  }, [lastEvent, flash, runs]);

  /* ---- zoomed sky: anchor + scale, rocket mark, lines ---- */
  const anchor = useRef<{ px: number; t: number } | null>(null);
  useEffect(() => {
    const f = flight.current;
    if (!hasPx || !f) return;
    lastMid.current[market] = px!;
    const live = !!(active && (active.status === "open" || active.status === "pending"));
    let a: number, dist: number;
    if (live) { a = active!.entry; dist = liqDistance(active!.entry, active!.liqPrice) || selLiqDist; anchor.current = { px: a, t: Date.now() }; }
    else {
      const nowT = Date.now(), cur = anchor.current;
      if (!cur || cur.px <= 0) anchor.current = { px: px!, t: nowT };
      else { const k = Math.min(1, (nowT - cur.t) / 30_000); anchor.current = { px: cur.px + (px! - cur.px) * k, t: nowT }; }
      a = anchor.current.px; dist = selLiqDist;
    }
    if (!(dist > 0)) return;
    const sky = (price: number) => f.skyMcap(price, a, dist);
    const m = sky(px!); if (m) f.mark(m);
    const lines: NonNullable<Parameters<TurboFlightHandle["setFx"]>[0]["lines"]> = [];
    if (live && active) {
      const away = usd(Math.abs(px! - active.liqPrice), 0);
      const hb = sky(active.liqPrice); if (hb) lines.push({ mcap: hb, kind: "hbomb", label: red ? R.lineBombAway(px0(active.liqPrice), away) : R.lineBomb(px0(active.liqPrice)) });
      if (open_ && evenPx > 0) { const ev = sky(evenPx); if (ev) lines.push({ mcap: ev, kind: "even", label: R.lineEven }); }
      const twoPx = open_ ? multiplePrice(active, fuelIn, realized, 2) : 0;
      const two = twoPx > 0 ? sky(twoPx) : null; if (two) lines.push({ mcap: two, kind: "two", label: R.line2x(px0(twoPx)) });
    }
    (window as unknown as { __entryMcap?: number }).__entryMcap = 0;
    f.setFx({ open: open_, pending: active?.status === "pending", side: active?.side ?? null, lev: active?.leverage ?? leverage, danger, dive: false, lines, route: ROUTES[market].key });
  }, [active, open_, danger, red, evenPx, leverage, px, hasPx, market, selLiqDist, engineReady, fuelIn, realized]);

  /* ---- liftoff: 3-2-1 on the pad while the fill lands, then the pad fades into the flight ---- */
  useEffect(() => { if (!launch) return; const id = setInterval(() => setTick(Date.now()), 100); return () => clearInterval(id); }, [launch]);
  const cd = launch ? Math.max(0, (tick || launch.t0) - launch.t0) : 0;
  useEffect(() => {
    if (!launch || launch.leaving || cd < COUNT_MS) return;
    if (active && active.status === "open") setLaunch({ ...launch, leaving: true });
    else if (!active && !busy) setLaunch(null);
  }, [launch, cd, active, busy]);
  const leaving = !!launch?.leaving;
  useEffect(() => { if (!leaving) return; const id = setTimeout(() => setLaunch(null), 450); return () => clearTimeout(id); }, [leaving]);

  /* ---- live trades → engine boosts / bombs (on the zoomed sky) + market flow pills ---- */
  const skyRef = useRef({ a: 0, dist: 0 });
  skyRef.current = { a: anchor.current?.px ?? 0, dist: active && (active.status === "open" || active.status === "pending") ? liqDistance(active.entry, active.liqPrice) : selLiqDist };
  useEffect(() => {
    if (!adapter.subscribeTrades) return;
    let n = 0;
    return adapter.subscribeTrades(market, (t: MarketTrade) => {
      const f = flight.current; const pre = t.prePrice ?? lastMid.current[t.market];
      lastMid.current[t.market] = t.price;
      const { a, dist } = skyRef.current;
      const sky = f && a > 0 && dist > 0 ? f.skyMcap(t.price, a, dist) : null;
      const real = marketCapUsd(t.market, t.price);
      if (f && sky && real > 0) f.swap({ side: t.side, usd: t.usd * (sky / real), mcap: sky, price: t.price, prePrice: pre, ts: t.ts });
      if (t.usd >= FLOW_MIN[t.market]) setFlow((fl) => [{ id: ++n, side: t.side, usd: t.usd }, ...fl].slice(0, 2));
    });
  }, [adapter, market]);

  /* ---- desktop hotkeys: Space = cash out, Q = bank half ---- */
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (sheet || result || share || !active || !open_ || e.repeat || (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.code === "Space") { e.preventDefault(); close(active, 100); }
      else if (e.code === "KeyQ") { e.preventDefault(); close(active, 50); }
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [active, open_, close, sheet, result, share]);

  const all = runs.all();
  const route = ROUTES[market];
  const padOn = !result && !nova && (!active || !!launch);
  const digit = cd < 600 ? 3 : cd < 1200 ? 2 : cd < COUNT_MS ? 1 : 0;
  const noFuel = fuel != null && fuelUsd > fuel;
  const bestT = bestToday(all), longestG = longestAt(all, leverage);
  const routeCards = MARKETS.map((m) => {
    const r = ROUTES[m];
    return (
      <button key={m} role="tab" type="button" aria-selected={m === market} disabled={!!launch} className={`${s.route} ${m === market ? s.routeOn : ""}`}
        style={r.vars as CSSProperties} data-testid={`turbo-route-${m}`} onClick={() => setPrefs({ ...prefs, market: m })}>
        <img src={withBase(r.thumb)} alt="" />
        <span className={s.rn}><b>{r.name}</b><span>{m} {pxTab(prices[m] ?? NaN)}</span></span>
      </button>);
  });
  const menu = () => dispatchEvent(new Event(SETTINGS_OPEN_EVENT));
  const fuelChip = (
    <button type="button" className={s.fuel} data-testid="turbo-add-fuel" aria-label={`${C.fuel} ${fuel == null ? "" : usd(fuel)}, ${C.addFuel}`} onClick={() => setSheet("fund")}>
      <span className={`${s.fuelK} ${s.deskOnly}`}>{R.fuel}</span>
      <b data-testid="turbo-fuel">{fuel == null ? "—" : usd(fuel, fuel >= 100 || Number.isInteger(fuel) ? 0 : 2)}</b>
      <span className={s.plus}><PlusIcon /></span>
    </button>
  );
  const marketTabs = (
    <div className={`${s.mkts} ${s.deskOnly}`} role="tablist" aria-label="Market">
      {MARKETS.map((m) => <button key={m} role="tab" type="button" aria-selected={m === market} disabled={!!active} className={`${s.mkt} ${m === market ? s.mktOn : ""}`}
        data-testid={`turbo-market-${m}`} onClick={() => setPrefs({ ...prefs, market: m })}><b>{m}</b>{pxTab(prices[m] ?? NaN)}</button>)}
    </div>
  );
  const runTag = active && (
    <><span className={active.side === "long" ? s.boostTxt : s.dumpTxt}>{active.side === "long" ? R.boost : R.dump}</span>{" "}<span className={s.cream}>{active.market} · {fmtLev(active.leverage)}</span></>
  );

  return (
    <div className={s.page} style={ROUTES[market].vars as CSSProperties} data-testid="turbo-screen" data-adapter={adapter.kind} data-state={result ? "result" : active ? active.status : "ready"}>
      <TurboFlight ref={flight} ticker={market} onReady={() => setEngineReady((n) => n + 1)} />
      {red && <div className={s.vignette} />}
      {open_ && level === "hot" && <div className={`${s.vignette} ${s.vignetteHot}`} />}

      <header className={s.top}>
        <button type="button" className={`${s.iconBtn} ${s.phoneOnly}`} aria-label="Menu" onClick={menu}><MenuIcon /></button>
        {active && !padOn ? <>
          <span className={`${s.word} ${s.deskOnly}`}>TURBO</span>
          {marketTabs}
          <span className={`${s.spacer} ${s.phoneOnly}`} />
          <div className={`${s.runPill} ${s.runPillPhone}`} data-testid="turbo-run-pill">{runTag}<span className={s.sep} /><span className={s.clock}>{open_ ? clock(elapsed) : "0:00"}</span></div>
        </> : <>
          <span className={`${s.spacer} ${s.phoneOnly}`} />
          <span className={s.word}>TURBO</span>
          <span className={`${s.prelabel} ${s.deskOnly}`}>{R.preLaunch}</span>
        </>}
        <span className={s.spacer} />
        {fuelChip}
        <button type="button" className={`${s.iconBtn} ${s.deskOnly}`} aria-label="Menu" onClick={menu}><MenuIcon /></button>
        <Link href="/" className={`${s.iconBtn} ${s.deskOnly}`} aria-label="Leave Turbo"><XIcon /></Link>
      </header>

      {standIn && <div className={`${s.notice} ${active || padOn ? s.deskOnly : ""}`} data-testid="turbo-standin-notice">{sample ? C.sampleNotice : C.notConnected}</div>}

      {padOn && <section className={`${s.pad} ${launch ? s.igniting : ""} ${leaving ? s.padLeaving : ""}`} data-testid="turbo-pad" data-route={route.key}>
        <div className={s.stage}>
          <img className={s.plate} src={withBase(route.pad)} alt={`${route.name.toLowerCase()} launch pad`} />
          <i className={s.flame} />
          <img className={s.padRocket} src={withBase("/assets/rocket-hi.webp")} alt="" />
          <img className={s.padRing} src={withBase("/home/pad/pad-front.webp")} alt="" />
        </div>
        {route.key === "eth" && <i className={s.moon} />}
        <div className={s.padShade} />
        {!launch && <>
          <div className={s.heroR} data-testid="turbo-route-hero">
            <span className={s.no}>{R.routeNo(route.no, market)}</span>
            <span className={s.nm}>{route.name.split(" ").map((w) => <span key={w} style={{ display: "block" }}>{w}</span>)}</span>
            <span className={s.tg}>{route.tagline}</span>
            <span className={s.px}><b>{pxTab(px ?? NaN)}</b><small>{capLabel(marketCapUsd(market, px ?? NaN))}</small></span>
          </div>
          <div className={s.padStats}>
            <div className={s.pstat}><span>{R.streak}</span><b>{R.streakV(streak(all))}</b></div>
            <div className={s.pstat}><span>{R.bestTodayShort}</span><b>{bestT != null ? multipleLabel(bestT) : "—"}</b></div>
            <div className={s.pstat}><span>{R.longestAt(fmtLev(leverage))}</span><b>{longestG != null ? clock(longestG) : "—"}</b></div>
          </div>
        </>}
      </section>}

      {padOn && !launch && <div className={`${s.routes} ${s.routesPhone} ${s.phoneOnly}`} role="tablist" aria-label="Route">{routeCards}</div>}

      {padOn && <section className={`${s.plan} ${launch ? s.planGone : ""}`} data-testid="turbo-ready" aria-hidden={!!launch}>
        <span className={`${s.ttl} ${s.deskOnly}`}>{R.flightPlan}</span>
        <div className={`${s.head} ${s.deskOnly}`}><span className={s.label}>{R.stepRoute}</span></div>
        <div className={`${s.routes} ${s.deskOnly}`} role="tablist" aria-label="Route">{routeCards}</div>
        <div className={s.head}><span className={s.label}><span className={s.deskOnly}>{R.stepGear}</span><span className={s.phoneOnly}>{R.gear}</span></span><small>{R.gearHint}</small></div>
        <div className={s.gears}>
          {LEVERAGE_PRESETS.map((lv, i) => {
            const q = gearQuotes[i], blocked = levBlocked(lv);
            return (
              <button key={lv} type="button" className={`${s.gear} ${prefs.levIdx === i ? s.gearOn : ""}`} aria-pressed={prefs.levIdx === i} disabled={blocked || !!launch}
                title={blocked ? (info?.leverageNote ?? C.leverageMax(info!.maxLeverage, market)) : undefined} data-testid={`turbo-lev-chip-${i}`}
                onClick={() => setPrefs({ ...prefs, levIdx: i })}>
                <span className={s.x}>{lv}×</span><Chevrons n={i + 1} /><span className={s.pace}>{q ? paceLabel(typicalRunSeconds(market, q.liqDist)) : "—"}</span>
              </button>);
          })}
        </div>
        <div className={s.head}><span className={s.label}><span className={s.deskOnly}>{R.stepFuel}</span><span className={s.phoneOnly}>{R.fuel}</span></span><small>{R.inPlay(usd(fuelUsd * leverage, 0))}</small></div>
        <div className={s.chips}>
          {FUEL_PRESETS.map((v, i) => <button key={v} type="button" className={`${s.chip} ${prefs.fuelIdx === i ? s.chipOn : ""}`} aria-pressed={prefs.fuelIdx === i} disabled={!!launch}
            data-testid={`turbo-fuel-chip-${i}`} onClick={() => setPrefs({ ...prefs, fuelIdx: i })}>${v}</button>)}
        </div>
        <div className={s.bombNote} data-testid="turbo-bomb-note">
          <svg viewBox="0 0 24 24" fill="none" stroke="#FF7FB2" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="12" cy="13" r="7" /><path d="M12 6V3M15 4l-1.5 2" /></svg>
          <span>{selLiqDist > 0 ? <>H-BOMB if {market} moves <b>{pctMove(selLiqDist)}</b> against you</> : C.waitingPrice}</span>
        </div>
        {standIn && <p className={`${s.planNotice} ${s.phoneOnly}`} data-testid="turbo-standin-notice">{sample ? C.sampleNotice : C.notConnected}</p>}
        {noFuel
          ? <button type="button" className={s.noFuel} data-testid="turbo-add-fuel-fire" onClick={() => setSheet("fund")}>
              <span className={s.big}>{R.addFuelToFire}</span><span className={s.sub}>{R.needFuelSub(usd(fuel ?? 0, 0), usd(fuelUsd, 0))}</span></button>
          : <div className={s.fire}>
              <button type="button" className={s.boost} data-testid="turbo-boost" disabled={busy || !hasPx || !!launch} onClick={() => openRun("long")}><span className={s.big}>{R.boost}</span><span className={s.sub}>{R.boostSub}</span></button>
              <button type="button" className={s.dump} data-testid="turbo-dump" disabled={busy || !hasPx || !!launch} onClick={() => openRun("short")}><span className={s.big}>{R.dump}</span><span className={s.sub}>{R.dumpSub}</span></button>
            </div>}
      </section>}

      {padOn && launch && !leaving && <>
        <div className={s.count} role="status" data-testid="turbo-countdown">
          <span>{digit ? R.liftoffIn : "\u00a0"}</span>
          {digit ? <b key={digit}>{digit}</b> : <b key="go" className={s.go}>{R.liftoff}</b>}
        </div>
        <div className={s.boarding}>
          <div className={s.runPill}><span className={launch.side === "long" ? s.boostTxt : s.dumpTxt}>{launch.side === "long" ? R.boost : R.dump}</span>
            <span>{ROUTES[launch.market].name} · {fmtLev(launch.leverage)}</span><span className={s.sep} /><span>{usd(launch.fuelUsd, 0)} {R.fuel.toLowerCase()}</span></div>
          {launch.entry > 0 && launch.liq > 0 && <small>{R.boardingAt(px0(launch.entry), px0(launch.liq))}</small>}
        </div>
      </>}

      {active && !padOn && <>
        <section className={`${s.hud} ${red ? s.hudRed : ""}`} data-testid="turbo-hud" data-danger={level}>
          <div className={s.hudTop}><span>{runTag}</span><span className={s.clock}>{open_ ? clock(elapsed) : "0:00"}</span></div>
          {active.status === "pending" ? <div className={s.pending}>{R.opening}</div> : <>
            <div className={s.hudMain}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}><span className={s.k}>{R.cashNow}</span>
                <span className={`${s.money} ${upUsd >= 0 ? s.up : s.pinkTxt}`} data-testid="turbo-cash-now">{usd(cashNow, 2)}</span></div>
              <span className={s.hudMulti}><span className={s.mult} data-testid="turbo-multiple">{multipleLabel(multiple)}</span>
                <span className={s.hudSub}>{R.best} {multipleLabel(Math.max(tr?.peak ?? 0, multiple))} · {R.heat} {Math.round(danger * 100)}%</span></span>
            </div>
            {!red && <div className={s.hudLine}><span>{R.putIn} <b>{usd(fuelIn, Number.isInteger(fuelIn) ? 0 : 2)}</b> · {upUsd >= 0 ? R.up : R.down} <b className={upUsd >= 0 ? s.up : s.pinkTxt}>{signedUsd(upUsd)}</b> {R.afterFees}</span>
              <span>{R.best} <b>{multipleLabel(Math.max(tr?.peak ?? 0, multiple))}</b></span></div>}
            <div className={s.heat}><span className={s.hk}>{R.heat.toUpperCase()}</span><span className={s.bar}><i style={{ width: `${Math.round(danger * 100)}%` }} /></span><span className={s.hv} data-testid="turbo-heat">{Math.round(danger * 100)}%</span></div>
          </>}
        </section>

        {red && <div className={s.blow} role="status">{R.aboutToBlow}</div>}

        {!red && flow.length > 0 && <div className={s.flow} aria-live="off">
          <span className={s.label} style={{ fontSize: 12 }}>{R.marketFlow}</span>
          {flow.map((f, i) => <div key={f.id} className={`${s.flowItem} ${f.side === "buy" ? s.flowBuy : s.flowSell} ${i ? s.flowOld : ""}`}><i /><span>{f.side === "buy" ? R.bigBuy : R.bigSell}</span><b>{bigUsd(f.usd)}</b><em className={s.ago}>{R.justNow}</em></div>)}
        </div>}

        {open_ && <aside className={s.runCard} data-testid="turbo-run-card">
          <span className={s.label}>{R.yourRun}</span>
          <div className={s.r}><span>{R.inPlayK}</span><b>{usd(active.sizeUsd, 0)}</b></div>
          <div className={s.r}><span>{R.boardedAt}</span><b>{px0(active.entry)}</b></div>
          <div className={s.r}><span>{R.evenAt}</span><b className={s.up}>{px0(evenPx)}</b></div>
          <div className={s.r}><span>{R.bombAt}</span><b className={s.pinkTxt}>{px0(active.liqPrice)}</b></div>
          <div className={s.r}><span>{R.feesSoFar}</span><b>{usd(active.openFeeUsd + Math.max(0, -active.fundingUsd), 2)}</b></div>
          <button type="button" className={s.link} onClick={() => setSheet("detail")}>{R.feesLink}</button>
        </aside>}

        <div className={s.act} data-testid="turbo-act">
          <button type="button" className={s.bank} data-testid="turbo-bank" disabled={busy || !open_} onClick={() => close(active, 50)}>
            <span className={s.big}>{R.bankHalf}</span><span className={s.sub}>≈ {usd(cashNow / 2, 2)}<span className={s.kbd}> · Q</span></span></button>
          <button type="button" className={`${s.cash} ${red ? s.cashRed : ""}`} data-testid="turbo-cashout" disabled={busy || !open_} onClick={() => close(active, 100)}>
            <span className={s.big}>{R.cashOut}</span><span className={s.sub}>{red ? R.save(usd(cashNow, 2)) : R.backToFuel(usd(cashNow, 2))}<span className={s.kbd}> · Space</span></span></button>
        </div>
      </>}

      {toast && <div className={s.toast} role="status" data-testid="turbo-toast">{toast}</div>}

      {result && <ResultScreen r={result} all={all} busy={busy} adapter={adapter}
        onClose={() => setResult(null)}
        onAgain={() => { const run = result.run; setResult(null); setPrefs({ ...prefs, market: run.market }); openRun(run.side, { fuelUsd: run.fuelUsd, leverage: run.leverage, market: run.market }); }}
        onShare={() => setShare({ kind: result.run.kind === "hbomb" ? "liquidated" : "win", market: result.run.market, side: result.run.side, leverage: result.run.leverage,
          profitUsd: result.run.backUsd - result.run.fuelUsd, fuelUsd: result.run.fuelUsd, entry: result.entry, exit: result.exit, multiple: result.run.multiple, lastedMs: result.run.endedAt - result.run.startedAt })} />}

      {sheet === "fund" && <TurboFundingSheet adapter={adapter} fuel={fuel} onClose={() => setSheet(null)} />}
      {sheet === "how" && <TurboHowItWorks onClose={() => setSheet(null)} />}
      {sheet === "detail" && active && <DetailSheet p={active} onClose={() => setSheet(null)} />}
      {nova && <TurboHBomb short={nova.short} label={nova.label} onDone={() => { setResult(nova.result); setNova(null); }} />}
      {share && <TurboShareCard data={share} onClose={() => setShare(null)} />}
    </div>
  );
}

function ResultScreen({ r, all, busy, adapter, onClose, onAgain, onShare }: {
  r: Result; all: TurboRun[]; busy: boolean; adapter: ReturnType<typeof useTurbo>["adapter"];
  onClose: () => void; onAgain: () => void; onShare: () => void;
}) {
  const run = r.run, bomb = run.kind === "hbomb", lasted = clock(run.endedAt - run.startedAt), levL = fmtLev(run.leverage);
  const tag = <span className={s.tag}><span className={run.side === "long" ? s.boostTxt : s.dumpTxt}>{run.side === "long" ? R.boost : R.dump}</span>{" "}<span className={s.cream}>{run.market} · {levL}</span></span>;
  const fuelL = usd(run.fuelUsd, Number.isInteger(run.fuelUsd) ? 0 : 2);
  const again = (
    <button type="button" className={s.again} disabled={busy} data-testid="turbo-run-back" onClick={onAgain}>
      <span className={s.big}>{R.runItBack}</span><span className={s.sub}>{R.runSub(fuelL, levL, sideWord(run.side))}</span></button>
  );
  const head = (
    <div className={s.resHead}>{tag}<button type="button" className={s.iconBtn} aria-label={R.close} data-testid="turbo-result-close" onClick={onClose}><XIcon /></button></div>
  );
  if (bomb) {
    const prev = all.filter((x) => x.id !== run.id);
    const longest = longestAt(prev, run.leverage);
    const move = r.liqMove ?? 0;
    // highest lower gear that would have survived this move (same fuel, quoted at the exit price)
    const lower = LEVERAGE_PRESETS.filter((lv) => lv < run.leverage).reverse().find((lv) => {
      try { const q = adapter.quote({ market: run.market, side: run.side, collateralUsd: run.fuelUsd, leverage: lv }); return liqDistance(q.entryEst, q.liqPrice) > move; } catch { return false; }
    });
    return (
      <div className={`${s.result} ${s.resultBomb}`} role="dialog" aria-modal="true" aria-label={R.hbombed} data-testid="turbo-result" data-kind="hbomb">
        <div className={s.res}>
          {head}
          <div className={`${s.hero} ${s.heroBomb}`}>
            <span className={s.title}>{R.hbombed}</span>
            <span className={s.over}>{R.lasted}</span>
            <span className={s.num} data-testid="turbo-result-lasted">{lasted}</span>
            <span className={s.line}>{R.lastedLine(levL, run.market, fuelL)}</span>
          </div>
          <div className={s.fact}>
            <svg viewBox="0 0 24 24" fill="none" stroke="#F3DFA8" strokeWidth="1.8" strokeLinecap="round" aria-hidden><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2M9 2h6" /></svg>
            <span>{longest != null ? <>Your longest at {levL} is <b>{clock(longest)}</b>.</> : R.firstAt(levL)}</span>
          </div>
          {move > 0 && <div className={s.fact}>
            <svg viewBox="0 0 24 24" fill="none" stroke="#F3DFA8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 14l4-4 4 4 8-8" /><path d="M14 6h6v6" /></svg>
            <span>{R.wentWrong(run.market, pctMove(move))}{lower ? ` ${R.stillFlying(fmtLev(lower))}` : ""}</span>
          </div>}
          <span className={s.grow} />
          <div className={s.resBtns}>
            {again}
            <div className={s.row2}>
              <button type="button" className={s.sec} data-testid="turbo-share" onClick={onShare}>{R.share(lasted)}</button>
              <button type="button" className={`${s.sec} ${s.ghost}`} onClick={onClose}>{R.changeSetup}</button>
            </div>
          </div>
        </div>
      </div>
    );
  }
  const green = run.multiple >= 1, profit = run.backUsd - run.fuelUsd;
  const today = all.filter((x) => new Date(x.endedAt).toDateString() === new Date().toDateString());
  const bankedToday = today.reduce((a, x) => a + (x.backUsd - x.fuelUsd), 0);
  const best = bestToday(all);
  return (
    <div className={s.result} role="dialog" aria-modal="true" aria-label={R.cashedOut} data-testid="turbo-result" data-kind="cashed">
      <div className={s.res}>
        {head}
        <div className={s.hero}>
          <span className={s.over}>{R.cashedOut}</span>
          <span className={s.num} style={green ? undefined : { color: "#FF7FB2" }} data-testid="turbo-result-multiple">{multipleLabel(run.multiple)}</span>
          <span className={`${s.usd} ${green ? s.up : s.pinkTxt}`}>{signedUsd(profit)}</span>
          <span className={s.line}>{R.inBack(usd(run.fuelUsd, 2), usd(run.backUsd, 2), lasted)}</span>
        </div>
        <RunChart path={run.path ?? [1, run.multiple]} />
        <div className={s.stats}>
          <div className={s.stat}><span className={s.k}>{R.streak}</span><span className={s.v}>{R.streakV(streak(all))}</span></div>
          <div className={s.stat}><span className={s.k}>{R.bestToday}</span><span className={s.v}>{best != null ? multipleLabel(best) : "—"}</span></div>
          <div className={`${s.stat} ${s.statGold}`}><span className={s.k}>{R.bankedToday}</span><span className={s.v}>{signedUsd(bankedToday)}</span></div>
        </div>
        <span className={s.grow} />
        <div className={s.resBtns}>
          {again}
          <div className={s.row2}>
            <button type="button" className={s.sec} data-testid="turbo-share" onClick={onShare}>{R.share(multipleLabel(run.multiple))}</button>
            <button type="button" className={`${s.sec} ${s.ghost}`} onClick={onClose}>{R.changeSetup}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
