"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { CURVE, fmtUsd, gradProgress, verifiedLevel } from "@/lib/config";
import VerifiedBadge from "@/components/VerifiedBadge";
import PairArt from "@/components/pairart/PairArt";
import { BASE_PAIRS, basePair } from "@/lib/pairArt";
import DsSelect from "@/components/ui/DsSelect";
import { fmtAge, sparkPoints, type Rocket } from "@/lib/launchpad";

type Tab = "altitude" | "new" | "active" | "near" | "graduated";
const TABS: { k: Tab; label: string; hint: string }[] = [
  { k: "altitude", label: "Altitude", hint: "Highest market cap first" },
  { k: "new", label: "New", hint: "Freshest launches" },
  { k: "active", label: "Active", hint: "Most 24h volume" },
  { k: "near", label: "Near orbit", hint: "≥60% of the way to graduation" },
  { k: "graduated", label: "Graduated", hint: "Past Outer Space" },
];
const PAIRS = [
  { value: "any", label: "Any pair" },
  ...BASE_PAIRS.map((p) => ({ value: p.tk, label: p.sym, hint: p.tk === "strategy" ? "default" : p.tk === "usdg" ? "stable" : undefined })),
  { value: "other", label: "Other" },
];
const baseOf = (c: Rocket) => basePair(c.pairSym ?? (c.pair === "USDG" ? "USDG" : c.pair === "OTHER" ? null : "STRATEGY"))?.tk ?? "other";
const CHUNK = 40;
const VIEW_KEY = "disciple.launchpad.view";
const WATCH_KEY = "disciple.watchlist";

const isGrad = (c: Rocket) => c.graduated || (c.mcap != null && c.mcap >= CURVE.graduationMcap);
const tierOf = (c: Rocket) => verifiedLevel({ ...c.stats, mcapUsd: c.mcap ?? 0 });

function useWatchlist() {
  const [w, setW] = useState<Set<string>>(new Set());
  useEffect(() => { try { setW(new Set(JSON.parse(localStorage.getItem(WATCH_KEY) || "[]"))); } catch { /* ignore */ } }, []);
  const toggle = (id: string) => setW((s) => {
    const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id);
    try { localStorage.setItem(WATCH_KEY, JSON.stringify(Array.from(n))); } catch { /* ignore */ }
    return n;
  });
  return [w, toggle] as const;
}

function Avatar({ c, size = 40 }: { c: Rocket; size?: number }) {
  return (
    <span className="lp-av2">
      <PairArt src={c.icon} pair={c.pairSym ?? "STRATEGY"} tk={c.tk} tint={c.c} size={size <= 32 ? "icon" : "list"} px={size} />
      <span className="lp-av-check"><VerifiedBadge tier={tierOf(c)} size={13} /></span>
    </span>
  );
}

const Spark = memo(function Spark({ seed, chg, w = 96, h = 26 }: { seed?: number; chg: number | null; w?: number; h?: number }) {
  const pts = sparkPoints(seed, chg);
  const d = pts.map((p, i) => `${((i / (pts.length - 1)) * w).toFixed(1)},${(h - 2 - p * (h - 4)).toFixed(1)}`).join(" ");
  const col = seed == null ? "rgba(232,234,238,.35)" : (chg ?? 0) >= 0 ? "#8ff0c0" : "#ff9fb8";
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="lp-spark"><polyline points={d} fill="none" stroke={col} strokeWidth="1.6" strokeLinejoin="round" /></svg>;
});

function Chg({ v }: { v: number | null }) {
  if (v == null) return <span className="lp-dim">—</span>;
  return <span className={v >= 0 ? "lp-up" : "lp-down"}>{v >= 0 ? "▲" : "▼"} {Math.abs(v).toFixed(1)}%</span>;
}

function Tag({ c }: { c: Rocket }) {
  return <span className={c.live ? "rc-live" : "rc-sample"}>{c.live ? "LIVE" : "SAMPLE"}</span>;
}

function Star({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={"lp-star" + (on ? " on" : "")} aria-pressed={on} aria-label={on ? "Remove from watchlist" : "Add to watchlist"}
      onClick={(e) => { e.stopPropagation(); onClick(); }} onKeyDown={(e) => e.stopPropagation()}>{on ? "★" : "☆"}</button>
  );
}

function Carousel({ items, onPick }: { items: Rocket[]; onPick: (c: Rocket) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const by = (d: number) => ref.current?.scrollBy({ left: d * (ref.current.clientWidth * 0.8), behavior: "smooth" });
  return (
    <section className="lp-trend" aria-label="Trending rockets">
      <div className="lp-trend-head">
        <h2>Trending</h2>
        <span className="lp-dim">by 24h volume</span>
        <div className="lp-arrows">
          <button type="button" className="ds-btn" aria-label="Previous" onClick={() => by(-1)}>‹</button>
          <button type="button" className="ds-btn" aria-label="Next" onClick={() => by(1)}>›</button>
        </div>
      </div>
      <div className="lp-trend-row" ref={ref}>
        {items.map((c, i) => (
          <button key={c.id} type="button" className="lp-tcard" onClick={() => onPick(c)}>
            <span className="lp-tart">
              <PairArt src={c.icon} pair={c.pairSym ?? "STRATEGY"} tk={c.tk} tint={c.c} size="grid" fluid eager={i < 6} />
              <span className="lp-rank">{i + 1}</span>
              <Tag c={c} />
            </span>
            <span className="lp-tname">{c.name} <VerifiedBadge tier={tierOf(c)} size={13} /></span>
            <span className="lp-tmeta"><b>${c.tk}</b></span>
            <span className="lp-tmeta"><b className="lp-mc">{c.mcap ? fmtUsd(c.mcap) : "…"}</b> <Chg v={c.chg} /></span>
          </button>
        ))}
      </div>
    </section>
  );
}

const Row = memo(function Row({ c, rank, starred, onStar, onPick }: { c: Rocket; rank: number; starred: boolean; onStar: (id: string) => void; onPick: (c: Rocket) => void }) {
  const p = gradProgress(c.mcap);
  return (
    <div role="link" tabIndex={0} className="lp-row" onClick={() => onPick(c)} onKeyDown={(e) => { if (e.key === "Enter") onPick(c); }}>
      <span className="lp-c-rank"><Star on={starred} onClick={() => onStar(c.id)} />{rank}</span>
      <span className="lp-c-token">
        <Avatar c={c} />
        <span className="lp-tok-txt">
          <span className="lp-tok-name">{c.name} <span className="lp-tk">${c.tk}</span> <Tag c={c} /></span>
          <span className="lp-tok-sub">{c.creator ?? "—"} · {c.live && !c.stats.ageHours ? "live" : fmtAge(c.stats.ageHours)}</span>
        </span>
      </span>
      <span className="lp-c-pair"><i className={"lp-pdot " + (c.pair ?? "STRATEGY").toLowerCase()} />{c.pairSym ?? "STRATEGY"}</span>
      <span className="lp-c-graph"><Spark seed={c.seed} chg={c.chg} /></span>
      <span className="lp-c-mc">
        <b>{c.mcap ? fmtUsd(c.mcap) : "…"}</b>
        <i className="lp-bar"><i style={{ width: `${isGrad(c) ? 100 : p || 0}%` }} /></i>
      </span>
      <span className="lp-c-chg"><Chg v={c.chg} /></span>
      <span className="lp-c-crew">{c.stats.holders.toLocaleString()}</span>
    </div>
  );
});

const Card = memo(function Card({ c, starred, onStar, onPick }: { c: Rocket; starred: boolean; onStar: (id: string) => void; onPick: (c: Rocket) => void }) {
  const p = gradProgress(c.mcap);
  const grad = isGrad(c);
  return (
    <div role="link" tabIndex={0} className="rocket-card lp-card" onClick={() => onPick(c)} onKeyDown={(e) => { if (e.key === "Enter") onPick(c); }}
      style={{ border: c.live ? "1px solid rgba(143,240,192,.6)" : undefined }}>
      <div className="lp-card-art"><PairArt src={c.icon} pair={c.pairSym ?? "STRATEGY"} tk={c.tk} tint={c.c} size="grid" fluid /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="lp-card-top"><Tag c={c} /><Star on={starred} onClick={() => onStar(c.id)} /></div>
        <div className="lp-card-name">{c.name} <VerifiedBadge tier={tierOf(c)} size={14} /></div>
        <div className="lp-card-sub">${c.tk} · {c.pairSym ?? "STRATEGY"} · {c.stats.holders} crew</div>
        <div className="lp-card-mc">{c.mcap ? fmtUsd(c.mcap) : "…"} <Chg v={c.chg} /></div>
        <i className="lp-bar"><i style={{ width: `${grad ? 100 : p || 0}%` }} /></i>
        <div className="lp-card-sub">{grad ? "GRADUATED · past Outer Space" : p == null ? "…" : `${p.toFixed(0)}% to orbit`}</div>
      </div>
    </div>
  );
});

function Rail({ coins, watch, onPick }: { coins: Rocket[]; watch: Set<string>; onPick: (c: Rocket) => void }) {
  const [t, setT] = useState<"trending" | "held" | "watch">("trending");
  const list = useMemo(() => {
    if (t === "watch") return coins.filter((c) => watch.has(c.id)).slice(0, 12);
    const s = [...coins];
    if (t === "trending") s.sort((a, b) => (b.chg ?? -1e9) - (a.chg ?? -1e9));
    else s.sort((a, b) => b.stats.holders - a.stats.holders);
    return s.slice(0, 12);
  }, [coins, watch, t]);
  return (
    <aside className="lp-rail" aria-label="Quick lists">
      <div className="ds-seg">
        {([["trending", "Rising"], ["held", "Most crewed"], ["watch", "★ Watchlist"]] as const).map(([k, l]) => (
          <button key={k} type="button" className={t === k ? "on" : ""} onClick={() => setT(k)}>{l}</button>
        ))}
      </div>
      {list.length === 0 && <p className="lp-dim" style={{ fontSize: 12, padding: "8px 4px" }}>Star a rocket (☆) to keep it here.</p>}
      {list.map((c) => (
        <button key={c.id} type="button" className="lp-rrow" onClick={() => onPick(c)}>
          <Avatar c={c} size={32} />
          <span className="lp-rr-txt"><b>{c.tk}</b><span className="lp-dim">{c.stats.holders} crew</span></span>
          <span className="lp-rr-num"><b>{c.mcap ? fmtUsd(c.mcap) : "…"}</b><Chg v={c.chg} /></span>
        </button>
      ))}
    </aside>
  );
}

export default function Launchpad({ coins, onPick, defaultVerified }: { coins: Rocket[]; onPick: (c: Rocket) => void; defaultVerified: "all" | "verified" }) {
  const [tab, setTab] = useState<Tab>("altitude");
  const [pair, setPair] = useState("any");
  const [q, setQ] = useState("");
  const [verified, setVerified] = useState(defaultVerified);
  const [view, setView] = useState<"list" | "grid">("list");
  const [shown, setShown] = useState(CHUNK);
  const [watch, toggleWatch] = useWatchlist();
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => { const v = localStorage.getItem(VIEW_KEY); if (v === "list" || v === "grid") setView(v); }, []);
  const pickView = (v: "list" | "grid") => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ } };

  const visible = useMemo(() => coins.filter((c) => !c.hidden), [coins]);
  const trending = useMemo(() => [...visible].sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || b.stats.volume24hUsd - a.stats.volume24hUsd).slice(0, 12), [visible]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^\$/, "");
    let r = visible.filter((c) => {
      if (pair !== "any" && baseOf(c) !== pair) return false;
      if (needle && !(c.name.toLowerCase().includes(needle) || c.tk.toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle))) return false;
      if (verified === "verified" && tierOf(c).level === "UNVERIFIED") return false;
      if (tab === "graduated") return isGrad(c);
      if (tab === "near") { const p = gradProgress(c.mcap); return !isGrad(c) && p != null && p >= 60; }
      return true;
    });
    const mc = (c: Rocket) => c.mcap ?? 0;
    r = [...r];
    if (tab === "new") r.sort((a, b) => (b.born ?? 0) - (a.born ?? 0));
    else if (tab === "active") r.sort((a, b) => b.stats.volume24hUsd - a.stats.volume24hUsd);
    else r.sort((a, b) => mc(b) - mc(a));
    // LIVE rockets stay pinned on top of every sort.
    return [...r.filter((c) => c.live), ...r.filter((c) => !c.live)];
  }, [visible, q, pair, verified, tab]);

  useEffect(() => setShown(CHUNK), [q, pair, verified, tab]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) setShown((s) => s + CHUNK); }, { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [rows.length, view]);

  const page = rows.slice(0, shown);
  const liveN = visible.filter((c) => c.live).length;

  return (
    <div className="lp">
      <Carousel items={trending} onPick={onPick} />
      <div className="lp-body">
        <div className="lp-main">
          <div className="lp-bar-top">
            <div className="lp-tabs" role="tablist" aria-label="Sort rockets">
              {TABS.map((t) => (
                <button key={t.k} role="tab" type="button" aria-selected={tab === t.k} title={t.hint} className={tab === t.k ? "on" : ""} onClick={() => setTab(t.k)}>{t.label}</button>
              ))}
            </div>
            <div className="lp-tools">
              <input className="ds-input lp-search" type="search" placeholder="Search name, $TICKER or 0x…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search rockets" />
              <DsSelect value={pair} options={PAIRS} onChange={setPair} ariaLabel="Pair filter" className="lp-pair" />
              <button type="button" className={"ds-btn lp-vchip" + (verified === "verified" ? " on" : "")} aria-pressed={verified === "verified"} onClick={() => setVerified(verified === "verified" ? "all" : "verified")}>✓ Verified</button>
              <div className="ds-seg lp-view" role="group" aria-label="View">
                <button type="button" className={view === "list" ? "on" : ""} aria-pressed={view === "list"} onClick={() => pickView("list")} title="List">☰</button>
                <button type="button" className={view === "grid" ? "on" : ""} aria-pressed={view === "grid"} onClick={() => pickView("grid")} title="Grid">▦</button>
              </div>
            </div>
          </div>
          <div className="lp-count lp-dim">
            {rows.length.toLocaleString()} rockets · showing {Math.min(shown, rows.length)} · {liveN} LIVE · the rest are SAMPLE data (MOCK stats)
          </div>
          {view === "list" ? (
            <div className="lp-table" role="table">
              <div className="lp-row lp-head" role="row">
                <span className="lp-c-rank">#</span><span className="lp-c-token">Rocket</span><span className="lp-c-pair">Pair</span>
                <span className="lp-c-graph">24h</span><span className="lp-c-mc">Altitude</span><span className="lp-c-chg">Change</span><span className="lp-c-crew">Crew</span>
              </div>
              {page.map((c, i) => <Row key={c.id} c={c} rank={i + 1} starred={watch.has(c.id)} onStar={toggleWatch} onPick={onPick} />)}
            </div>
          ) : (
            <div className="lp-grid">
              {page.map((c) => <Card key={c.id} c={c} starred={watch.has(c.id)} onStar={toggleWatch} onPick={onPick} />)}
            </div>
          )}
          {rows.length === 0 && <p className="lp-empty">No rockets match. Try another pair or clear the search.</p>}
          {shown < rows.length && (
            <div ref={sentinel} className="lp-more">
              <button type="button" className="ds-btn" onClick={() => setShown((s) => s + CHUNK)}>Load {Math.min(CHUNK, rows.length - shown)} more</button>
            </div>
          )}
        </div>
        <Rail coins={visible} watch={watch} onPick={onPick} />
      </div>
    </div>
  );
}
