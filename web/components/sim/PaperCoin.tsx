"use client";

/**
 * PAPER TRADING on the real coin screen (/flight/sim?view=coin): the same FlightCanvas (rocket, HUD, holders + trades
 * cards, tramps/walls, tiers / ASCENDED), DexChart, PnlHud (YOUR POSITION), TradeBridge (BOOST / DUMP, sim scope),
 * SnipeChip and CardChrome snap-grid as /coin/[address], fed by the EXISTING simulated market (lib/sim SimRun via SimDriver
 * + window.__discipleSim, engine ?source=sim) with a 200-bot lobby (lib/sim/paper PaperBrain). Simulated data only: no
 * chain, wallet, RPC or transaction. Live coin pages don't render this component.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FlightCanvas from "@/components/FlightCanvas";
import PnlHud from "@/components/PnlHud";
import TradeBridge from "@/components/TradeBridge";
import SnipeChip from "@/components/flight/SnipeChip";
import DexChart from "@/components/flight/DexChart";
import CardChrome from "@/components/flight/CardChrome";
import TrampWallPanel from "@/components/trampwalls/TrampWallPanel";
import { snipeState } from "@/lib/snipe";
import { SIM_LAUNCH_TS } from "@/lib/game/snipeCountdown";
import { PAPER_CARDS } from "@/lib/game/cardLayout";
import { isPhoneUI, useDomCard } from "@/lib/game/cardLayoutStore";
import { resetSimStorage, SIM_STORAGE } from "@/lib/sim/config";
import { SIM_POS_EVENT, SimDriver } from "@/lib/sim/driver";
import { createSimTrampWallAdapter, SIM_ME } from "@/lib/sim/twAdapter";
import { fmt, seedOf } from "@/lib/sim/run";
import { LOBBY_MIX, PAPER_BLURB, PAPER_COLOR, PAPER_DIFFS, PAPER_LABEL, START_CASH, paperLobby, type PaperBrain, type PaperDifficulty } from "@/lib/sim/paper";
import { botDisplayName, feedNames, holdersSnapshot, PAPER_TRADE_EVENT, playerPoolStatus, roundJson, roundSummary, standings, tradesCsv, tradeTick, type Standing } from "@/lib/sim/paperRound";

const SPEEDS = [1, 2, 4, 10];
const mono: React.CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };
const panel: React.CSSProperties = { ...mono, background: "rgba(8,10,24,.9)", border: "1px solid rgba(143,216,255,.35)", borderRadius: 12, color: "#e8ecff", boxShadow: "0 10px 40px rgba(0,0,0,.45)" };
const btn = (on = false, c = "#8fd8ff"): React.CSSProperties => ({ ...mono, cursor: "pointer", padding: "5px 10px", borderRadius: 8, fontSize: 12, fontWeight: 700,
  border: `1px solid ${c}`, background: on ? c : "transparent", color: on ? "#0a0c1c" : c });
const clock = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;
const money = (v: number) => (v < 0 ? "−$" : "$") + Math.abs(v).toFixed(2);
const signed = (v: number) => (v < 0 ? "−$" : "+$") + Math.abs(v).toFixed(2);
type Results = ReturnType<typeof roundSummary>;

/** last BUY/SELL card rect from the engine (it only re-publishes on layout change, so listen from module load) */
let lastAmmo: { right: number } | null = null;
if (typeof window !== "undefined") addEventListener("disciple:hudcol", (e) => { const a = (e as CustomEvent).detail?.ammo; if (a) lastAmmo = { right: a.x + a.w }; });
export default function PaperCoin({ initial }: { initial: { difficulty?: string; seed?: string; speed?: number; minutes?: number; bots?: number; autostart?: boolean; dev?: boolean } }) {
  const dev = !!initial.dev || process.env.NODE_ENV !== "production";
  const [difficulty, setDifficulty] = useState<PaperDifficulty>(PAPER_DIFFS.includes(initial.difficulty as PaperDifficulty) ? (initial.difficulty as PaperDifficulty) : "easy");
  const [speed, setSpeed] = useState(SPEEDS.includes(initial.speed || 0) ? initial.speed! : 1);
  const [phase, setPhase] = useState<"pick" | "run" | "results">("pick");
  const [runN, setRunN] = useState(0);
  const [results, setResults] = useState<Results | null>(null);
  const drv = useRef<SimDriver | null>(null), brain = useRef<PaperBrain | null>(null), minutes = useRef(10);
  const [, force] = useState(0);
  const [phone, setPhone] = useState(false);
  // engine: paper coin ⇒ no SIM / paper disclaimers; status card only with ?dev=1
  if (typeof window !== "undefined") { const w = window as unknown as Record<string, unknown>; w.__paperCoin = true; w.__paperDev = !!initial.dev; }
  useEffect(() => () => { const w = window as unknown as Record<string, unknown>; delete w.__paperCoin; delete w.__paperDev; }, []);
  // desktop pill slot: just left of the site's wallet strip (TEST NETWORK pill) if it fits beside the trade panel, else tucked under it (no card overlap)
  const pillRef = useRef<HTMLDivElement>(null), ammo = useRef<{ right: number } | null>(null);
  const [pillAt, setPillAt] = useState({ top: 10, right: 210 });
  useEffect(() => {
    const place = () => {
      const el = pillRef.current; if (!el) return;
      const tn = document.querySelector('[aria-label="wallet"]') as HTMLElement | null;   // site wallet strip (TEST NETWORK pill + Play)
      const t = tn?.getBoundingClientRect(), pr = ammo.current ?? lastAmmo, w = el.offsetWidth;   // pr: the canvas BUY/SELL card (engine disciple:hudcol)
      if (!t) return;
      const right = Math.round(innerWidth - t.left + 8), fits = pr ? innerWidth - right - w > pr.right + (Number((window as unknown as { __wrapL?: number }).__wrapL) || 0) + 12 : innerWidth >= 1400;   // card rect not published yet ⇒ width heuristic
      const next = fits ? { top: Math.round(t.top + (t.height - el.offsetHeight) / 2), right } : { top: Math.round(t.bottom + 6), right: Math.round(innerWidth - t.right) };
      setPillAt((p) => (p.top === next.top && p.right === next.right ? p : next));
    };
    const onCol = (e: Event) => { const a = (e as CustomEvent).detail?.ammo; if (a) { ammo.current = { right: a.x + a.w }; place(); } };
    place(); const id = setInterval(place, 1000); addEventListener("resize", place); addEventListener("disciple:hudcol", onCol);
    return () => { clearInterval(id); removeEventListener("resize", place); removeEventListener("disciple:hudcol", onCol); };
  }, [phase, phone]);
  useEffect(() => { const f = () => setPhone(isPhoneUI()); f(); addEventListener("resize", f); return () => removeEventListener("resize", f); }, []);
  const twAdapter = useMemo(() => (runN > 0 ? createSimTrampWallAdapter(() => drv.current?.run ?? null, typeof window !== "undefined" ? localStorage : undefined) : undefined), [runN]);

  const start = useCallback((seedOverride?: number) => {
    drv.current?.stop();
    const s0 = initial.seed?.trim();
    const seed = seedOverride ?? (s0 ? seedOf(/^\d+$/.test(s0) ? +s0 : s0) : (Math.random() * 2 ** 31) >>> 0);
    const L = paperLobby(difficulty, initial.bots ?? 200); minutes.current = initial.minutes || L.minutes;
    try { resetSimStorage(localStorage); } catch { /* ignore */ }
    const d = new SimDriver(L.cfg, L.difficulty, seed, minutes.current, { brain: L.brain, endOnGraduate: true }); d.speed = speed;
    // coin-screen feeds: DexChart ticks (simulated time), Trades-card names (default names, like live wallets)
    let n = 0; const names = feedNames(d.run);
    d.run.on(({ trade }) => { if (trade) dispatchEvent(new CustomEvent(PAPER_TRADE_EVENT, { detail: tradeTick(trade, ++n) })); });
    d.start(); drv.current = d; brain.current = L.brain;
    dispatchEvent(new CustomEvent("disciple:feednames", { detail: names }));
    dispatchEvent(new CustomEvent(PAPER_TRADE_EVENT, { detail: { type: "Trade", token: "SIMULATOR", mcapUsd: d.run.m.mcap(), usd: 0, side: "buy", txHash: "sim-launch", logIndex: 0, ts: Date.UTC(2026, 0, 1) } }));
    setResults(null); setRunN((x) => x + 1); setPhase("run");
  }, [difficulty, speed, initial.seed, initial.minutes, initial.bots]);

  useEffect(() => () => drv.current?.stop(), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (initial.autostart) start(); }, []);
  useEffect(() => { if (drv.current) drv.current.speed = speed; }, [speed]);
  // HUD 4×/s: holders snapshot (engine 'disciple:holders-real'), names for late joiners, round end → results
  useEffect(() => {
    if (phase !== "run") return;
    let k = 0;
    const iv = window.setInterval(() => {
      const d = drv.current, b = brain.current; if (!d || !b) return; force((x) => x + 1);
      if (k++ % 4 === 0) { dispatchEvent(new CustomEvent("disciple:holders-real", { detail: holdersSnapshot(d.run) })); dispatchEvent(new CustomEvent("disciple:feednames", { detail: feedNames(d.run) })); }
      if (d.ended) { setResults(roundSummary(d.run, b)); setPhase("results"); }
    }, 250);
    return () => window.clearInterval(iv);
  }, [phase, runN]);

  const download = (name: string, body: string, type: string) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([body], { type })); a.download = name; a.click(); URL.revokeObjectURL(a.href); };
  const exportJson = () => { const d = drv.current, b = brain.current; if (d && b) download(`paper-${b.difficulty}-${d.seed}.json`, JSON.stringify(roundJson(d.run, b), null, 1), "application/json"); };
  const exportCsv = () => { const d = drv.current, b = brain.current; if (d && b) download(`paper-${b.difficulty}-${d.seed}-trades.csv`, tradesCsv(d.run, b), "text/csv"); };

  const search = useMemo(() => `source=sim&render=main&simrun=${runN}`, [runN]);
  const d = drv.current, run = d?.run, b = brain.current;
  const st = run && b && phase !== "pick" ? standings(run, b) : [];
  const snipe = run && phase === "run" && run.m.phase === "curve"
    ? snipeState({ launchTs: SIM_LAUNCH_TS, nowSec: SIM_LAUNCH_TS + run.t, startPct: run.cfg.launch.antiSnipeStartBps / 100, windowSec: run.cfg.launch.antiSnipeDurationS, bpsBySec: run.cfg.launch.antiSnipeBpsBySec })
    : null;
  const left = run ? minutes.current * 60 - run.t : 0;
  // paper-only ascension pool (lib/sim/paper ASCENSION_POOL): live top-3 race + your score / rank
  const ps = run && b && phase === "run" ? playerPoolStatus(run, b) : null;
  const raceName = (w: string) => (w === "you" ? "you" : botDisplayName(w));

  return (
    <>
      {phase !== "pick" && (
        <>
          <FlightCanvas key={runN} search={search} />
          {/* no mode tag by the cash on paper coin (TradeBridge untouched: trade code) */}
          <style>{`[title="paper trades — connect wallet to trade"]{display:none!important}`}</style>
          <PnlHud coin={`paper-${runN}`} storagePrefix={SIM_STORAGE.pnlPrefix} modeLabel="" syncEvent={SIM_POS_EVENT} />
          <DexChart key={`c${runN}`} coin="SIMULATOR" ticker="SIMULATOR" simEvent={PAPER_TRADE_EVENT} />
          <TrampWallPanel key={`tw${runN}`} token="SIMULATOR" adapter={twAdapter} owner={SIM_ME} supply={run?.m.S} simulator />
          <TradeBridge token="SIMULATOR" storagePrefix={SIM_STORAGE.swapPrefix} />
          <SnipeChip state={snipe} />
          {!phone && <LeaderboardCard rows={st}             pool={phase === "run" && b ? { size: b.pool, top: b.race.map((x, i) => `${i + 1}. ${raceName(x.wallet)} +${money(x.payout).slice(1)}`).join(" · "), rank: ps?.rank, est: ps?.est } : undefined} />}
          <CardChrome extraCards={PAPER_CARDS} />
        </>
      )}
      {phase === "run" && run && phone && (() => { const me = st.find((r) => r.kind === "human"), top = st[0]; return (
        <div data-testid="paper-countdown" style={{ ...panel, position: "fixed", left: 8, right: 8, bottom: 128, zIndex: 32, padding: "4px 8px", fontSize: 11, display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", borderColor: PAPER_COLOR[difficulty] }}>
          <span data-testid="paper-board" style={{ color: "#8fd8ff", fontWeight: 800 }}>#{me?.rank}/{st.length}</span>
          <span style={{ opacity: 0.75, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", flex: 1 }}>1. {top?.kind === "human" ? "YOU" : top?.name} {top ? signed(top.pnl) : ""}</span>
          {b && !!ps?.rank && <span data-testid="paper-pool" style={{ color: "#ffd24a", whiteSpace: "nowrap" }}>{ps?.rank ? (ps.rank <= 3 ? `#${ps.rank} · +${money(ps.est).slice(1)}` : `#${ps.rank}`) : ""}</span>}
          {dev && <button data-testid="paper-end" style={{ ...btn(false, "#ffb0c8"), padding: "1px 6px", fontSize: 11 }} onClick={() => { if (drv.current) drv.current.ended = true; }}>■</button>}
        </div>); })()}
      {phase === "run" && run && phone && <span style={{ position: "fixed", top: 18, left: 52, zIndex: 32, display: "flex", gap: 6, alignItems: "center" }}><span data-testid="paper-badge" style={{ ...mono, background: "linear-gradient(90deg, #ffd24a, #ff5c8a)", color: "#14121f", borderRadius: 999, padding: "2px 9px", fontSize: 10, fontWeight: 900, letterSpacing: 1.5, whiteSpace: "nowrap" }}>FLIGHT SIMULATOR</span><span data-testid="paper-clock" style={{ ...mono, fontSize: 11, fontWeight: 700, color: left < 30 ? "#ff9fb8" : "rgba(232,236,255,.55)" }}>{clock(left)}</span></span>}
      {phase === "run" && run && !phone && (
        <div ref={pillRef} style={{ position: "fixed", top: pillAt.top, right: pillAt.right, zIndex: 32, display: "flex", gap: 6, alignItems: "center" }}>
          <span data-testid="paper-badge" style={{ ...mono, background: "linear-gradient(90deg, #ffd24a, #ff5c8a)", color: "#14121f", borderRadius: 999, padding: "2px 10px", fontSize: 10, fontWeight: 900, letterSpacing: 1.5, whiteSpace: "nowrap" }}>FLIGHT SIMULATOR</span>
          <span data-testid="paper-clock" style={{ ...mono, fontSize: 11, fontWeight: 700, color: left < 30 ? "#ff9fb8" : "rgba(232,236,255,.55)" }}>{clock(left)}</span>
          {dev && <>
            {SPEEDS.map((s) => <button key={s} data-testid={`paper-speed-${s}`} style={{ ...btn(speed === s), padding: "1px 5px", fontSize: 10 }} onClick={() => setSpeed(s)}>{s}×</button>)}
            <button data-testid="paper-end" style={{ ...btn(false, "#ffb0c8"), padding: "1px 5px", fontSize: 10 }} title="end the round now" onClick={() => { if (drv.current) drv.current.ended = true; }}>■</button>
            <button style={{ ...btn(false, "#ffd24a"), padding: "1px 5px", fontSize: 10 }} onClick={exportJson}>JSON</button>
          </>}
        </div>
      )}
      {phase === "pick" && (
        <div data-testid="paper-pick" style={{ position: "fixed", inset: 0, left: "var(--ap-rail-w, 0px)", display: "grid", placeItems: "center", background: "radial-gradient(ellipse at 50% 30%, #1b1f4a, #05060f)", zIndex: 40, padding: 12 }}>
          <div style={{ ...panel, width: "min(620px, 96vw)", padding: 22 }}>
            <div style={{ fontSize: 11, letterSpacing: 3, color: "#8fd8ff" }}>PAPER TRADING</div>
            <div style={{ fontSize: 24, fontWeight: 900, margin: "4px 0 6px" }}>You vs 200 bots · 10 minutes</div>
            <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 14 }}>A coin on the real curve: fees, sniper tax, ASCEND into the pool, tramps &amp; walls. Everyone starts with the same cash; most money at the bell wins.</div>
            <div style={{ display: "grid", gap: 8 }}>
              {PAPER_DIFFS.map((x) => (
                <button key={x} data-testid={`paper-diff-${x}`} onClick={() => setDifficulty(x)} style={{ ...mono, textAlign: "left", cursor: "pointer", padding: "10px 12px", borderRadius: 10, color: "#e8ecff",
                  border: `1px solid ${difficulty === x ? PAPER_COLOR[x] : "rgba(255,255,255,.15)"}`, background: difficulty === x ? "rgba(255,255,255,.07)" : "transparent" }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}><b style={{ color: PAPER_COLOR[x], fontSize: 15 }}>{PAPER_LABEL[x]}</b><span style={{ fontWeight: 800 }}>{money(START_CASH[x])} start</span></div>
                  <div style={{ fontSize: 11, opacity: 0.75, marginTop: 3 }}>{PAPER_BLURB[x]}</div>
                  <div style={{ fontSize: 10, opacity: 0.5, marginTop: 2 }}>mix {LOBBY_MIX[x].easy}/{LOBBY_MIX[x].medium}/{LOBBY_MIX[x].hard} easy/medium/hard</div>
                </button>))}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14 }}>
              <span style={{ fontSize: 11, opacity: 0.7 }}>speed</span>
              {SPEEDS.map((s) => <button key={s} style={btn(speed === s)} onClick={() => setSpeed(s)}>{s}×</button>)}
              <button data-testid="paper-start" style={{ ...btn(true, PAPER_COLOR[difficulty]), padding: "10px 26px", fontSize: 15, marginLeft: "auto" }} onClick={() => start()}>PLAY ▸</button>
            </div>
            <div style={{ fontSize: 10, opacity: 0.5, marginTop: 10 }}>SPACE = BOOST (buy) · SHIFT = DUMP (sell) · same keys as a live coin.</div>
          </div>
        </div>
      )}
      {phase === "results" && results && (
        <div data-testid="paper-results" style={{ position: "fixed", inset: 0, left: "var(--ap-rail-w, 0px)", display: "grid", placeItems: "center", background: "rgba(4,5,14,.72)", zIndex: 40, padding: 12 }}>
          <div style={{ ...panel, width: "min(560px, 96vw)", padding: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}><b style={{ color: "#8fd8ff", letterSpacing: 2 }}>ROUND OVER</b><span style={{ color: PAPER_COLOR[results.difficulty], fontWeight: 800 }}>{PAPER_LABEL[results.difficulty]} · seed {results.seed}</span></div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, margin: "14px 0" }}>
              <Stat k="RANK" v={`#${results.player.rank}`} sub={`of ${results.player.of}`} c={results.player.rank <= 10 ? "#ffd24a" : undefined} />
              <Stat k="PnL" v={signed(results.player.pnl)} sub={results.player.bonus > 0 ? <>worth {money(results.player.worth)}<div data-testid="paper-bonus" style={{ color: "#ffd24a" }}>incl. +{money(results.player.bonus).slice(1)} ascension bonus</div></> : `worth ${money(results.player.worth)}`} c={results.player.pnl >= 0 ? "#8ff0c0" : "#ff9fb8"} />
              <Stat k="BEST TRADE" v={results.player.bestTrade ? signed(results.player.bestTrade.pnl) : "—"} sub={results.player.bestTrade ? `sell at ${clock(results.player.bestTrade.t)}` : "no sells"} />
            </div>
            <div style={{ fontSize: 12 }}>
              {st.slice(0, 5).map((r) => <BoardRow key={r.wallet} r={r} />)}
              {st.findIndex((r) => r.kind === "human") >= 5 && <BoardRow r={st.find((r) => r.kind === "human")!} />}
            </div>
            <div style={{ fontSize: 11, opacity: 0.6, marginTop: 8 }}>peak {fmt(results.peakMcap)} · {results.graduated ? `ASCENDED at ${clock(results.graduationSec!)}` : "never ascended"} · {results.trades} trades</div>
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button data-testid="paper-again" style={btn(true)} onClick={() => start()}>⟲ Play again</button>
              <button style={btn()} onClick={() => { drv.current?.stop(); setPhase("pick"); }}>change difficulty</button>
              {dev && <><button style={{ ...btn(false, "#ffd24a"), marginLeft: "auto" }} onClick={exportJson}>JSON</button><button style={btn(false, "#ffd24a")} onClick={exportCsv}>CSV</button></>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** LEADERBOARD snap-grid card (CardChrome extraCards "board"): top 8 + your rank, by cash + position value */
function LeaderboardCard({ rows, clock, low, pool }: { rows: Standing[]; clock?: string; low?: boolean; pool?: { size: number; top: string; rank?: number; est?: number } }) {
  const ref = useRef<HTMLDivElement | null>(null), card = useDomCard("board", ref);
  const me = rows.find((r) => r.kind === "human");
  if (!rows.length) return null;
  return (
    <div ref={ref} data-card="board" data-testid="paper-board" className="paper-board"
      style={{ ...panel, position: "fixed", left: "calc(var(--ap-rail-w, 64px) + 22px)", bottom: 150, width: 262, padding: "8px 10px", zIndex: 21, fontSize: 11,
        transform: card.transform, display: card.hidden ? "none" : undefined }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><b style={{ letterSpacing: 1, color: "#ffd24a" }}>LEADERBOARD</b><span style={{ opacity: 0.6 }}>{clock && <b data-testid="paper-clock" style={{ opacity: 1, color: low ? "#ff9fb8" : "#e8ecff", marginRight: 6 }}>⏱ {clock}</b>}{me ? `you #${me.rank}/${rows.length}` : ""}</span></div>
      {pool && <div data-testid="paper-pool" style={{ color: "#ffd24a", fontSize: 10, marginBottom: 4, lineHeight: "13px" }}>
        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>TOP 3 · {pool.top || "—"}</div>
        <div data-testid="paper-pool-me" style={{ color: "#8fd8ff" }}>You {pool.rank ? `#${pool.rank}` : "—"}{pool.est ? ` · est. +${money(pool.est).slice(1)}` : ""}</div></div>}
      {rows.slice(0, 8).map((r) => <BoardRow key={r.wallet} r={r} />)}
      {me && me.rank > 8 && <><div style={{ opacity: 0.4, textAlign: "center", lineHeight: "8px" }}>⋯</div><BoardRow r={me} /></>}
    </div>
  );
}
function BoardRow({ r }: { r: Standing }) {
  const you = r.kind === "human", z = Math.abs(r.pnl) < 0.005, up = r.pnl > 0;   // PnL (rank stays by worth)
  return <div style={{ display: "flex", justifyContent: "space-between", gap: 6, color: you ? "#8fd8ff" : undefined, fontWeight: you ? 800 : 400 }}>
    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.rank}. {you ? "YOU" : r.name}</span>
    <span style={{ color: z ? undefined : up ? "#8ff0c0" : "#ff9fb8" }}>{z ? "$0.00" : signed(r.pnl)}{!z && <> {up ? "▲" : "▼"}</>}</span></div>;
}
function Stat({ k, v, sub, c }: { k: string; v: string; sub?: import("react").ReactNode; c?: string }) {
  return <div style={{ background: "rgba(255,255,255,.04)", borderRadius: 10, padding: 10 }}><div style={{ fontSize: 10, opacity: 0.65, letterSpacing: 1 }}>{k}</div>
    <div style={{ fontSize: 20, fontWeight: 900, color: c || "#e8ecff" }}>{v}</div><div style={{ fontSize: 10, opacity: 0.65 }}>{sub}</div></div>;
}
