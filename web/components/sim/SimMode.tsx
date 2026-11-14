"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FlightCanvas from "@/components/FlightCanvas";
import PnlHud from "@/components/PnlHud";
import TradeBridge from "@/components/TradeBridge";
import SnipeChip from "@/components/flight/SnipeChip";
import { snipeState } from "@/lib/snipe";
import { SIM_LAUNCH_TS } from "@/lib/game/snipeCountdown";
import Icon from "@/components/ui/Icon";
import TrampWallPanel from "@/components/trampwalls/TrampWallPanel";
import { TRAMP_WALLS_ENABLED } from "@/lib/features";
import { PLAYER, cloneConfig, mergeTune, resetSimStorage, SIM_STORAGE, type ArchetypeId, type DifficultyId, type SimConfig } from "@/lib/sim/config";
import { SIM_POS_EVENT, SimDriver } from "@/lib/sim/driver";
import { createSimTrampWallAdapter, SIM_ME } from "@/lib/sim/twAdapter";
import { seedOf } from "@/lib/sim/run";
import type { PlayerInput, SimEvent } from "@/lib/sim/run";
import { dailyToday, fmtMultiple, DAILY } from "@/lib/sim/daily";
import { claimFreePlayXp, saveDaily, savedDaily, startDaily, submitDaily, type DailyVerdict, type FreePlayXpResult } from "@/lib/sim/dailyClient";
import { usePilotWallet, XP_CHANGED_EVENT } from "@/lib/xpClient";
import DailyResult from "@/components/sim/DailyResult";
import { FreePlayHub, FreePlayStrip, PracticeResult, savePracticeBest, type StripAlert } from "@/components/sim/FreePlay";
import { scoreRun } from "@/lib/sim/daily";

/** a challenger's run on a daily (GET /api/daily?run=): flown as a ghost when this run is that exact flight */
type Ghost = { day: number; /** null for today (the seed comes with the start ticket) */ seed: number | null; name: string; multiple: number; boardedAtS: number | null; outAtS: number | null };
const ghostEvent = (detail: Record<string, unknown>) => dispatchEvent(new CustomEvent("disciple:ghost", { detail }));

type Summary = ReturnType<SimDriver["run"]["summary"]>;
const DIFFS: DifficultyId[] = ["pve", "pvp", "trench"];
const SPEEDS = [1, 2, 4];
const mono: React.CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };
const panel: React.CSSProperties = { ...mono, background: "rgba(8,10,24,.86)", border: "1px solid rgba(143,216,255,.35)", borderRadius: 12, color: "#e8ecff", boxShadow: "0 10px 40px rgba(0,0,0,.45)" };
const btn = (on = false, c = "#8fd8ff"): React.CSSProperties => ({ ...mono, cursor: "pointer", padding: "5px 10px", borderRadius: 8, fontSize: 12, fontWeight: 700,
  border: `1px solid ${c}`, background: on ? c : "transparent", color: on ? "#0a0c1c" : c });
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** saved tuning merged per key onto the current defaults; launch params always come from lib/config (never a stale save) */
function loadTune(): SimConfig { try { const s = localStorage.getItem(SIM_STORAGE.tune); if (s) return mergeTune(JSON.parse(s)); } catch { /* ignore */ } return cloneConfig(); }

/** SIMULATOR — free paper-trading mode on a fully local market (lib/sim). Never touches wallets or real profiles. */
export default function SimMode({ initial }: { initial: { difficulty?: string; seed?: string; tune?: boolean; autostart?: boolean; speed?: number; minutes?: number; balance?: number; daily?: boolean; challenge?: string; challengeDay?: number } }) {
  const [cfg, setCfg] = useState<SimConfig>(() => cloneConfig());
  // phones (mobile plan, one overlay at a time): the run panel folds into a small SIM chip in the top-right corner
  const [phone, setPhone] = useState(false);
  useEffect(() => { const mq = matchMedia("(max-width: 760px)"); const f = () => setPhone(mq.matches); f(); mq.addEventListener("change", f); return () => mq.removeEventListener("change", f); }, []);
  useEffect(() => { setCfg(loadTune()); }, []);
  const [difficulty, setDifficulty] = useState<DifficultyId>(DIFFS.includes(initial.difficulty as DifficultyId) ? (initial.difficulty as DifficultyId) : "pve");
  const [seedText, setSeedText] = useState(initial.seed || "");
  const [speed, setSpeed] = useState(SPEEDS.includes(initial.speed || 0) ? initial.speed! : 1);
  const [minutes, setMinutes] = useState(initial.minutes || PLAYER.defaultMinutes);
  const [phase, setPhase] = useState<"select" | "run" | "summary" | "daily">("select");
  // Daily flight: today's fixed seed on the default config (never the tuning panel's), Hard, 2 min, 1×; one scored run per device
  const [dailyRun, setDailyRun] = useState(false);
  const dailyId = useMemo(() => dailyToday(), []);
  const [dailyRes, setDailyRes] = useState<{ seed: number; inputs: PlayerInput[]; verdict: DailyVerdict | null; error: string | null } | null>(null);
  // today's seed and start ticket (POST /api/daily/start): the seed is secret until a run starts, the ticket scores it
  const ticketRef = useRef<{ seed: number; ticket: string } | null>(null), todaySeed = useRef<number | null>(null);
  const [dailyMsg, setDailyMsg] = useState<string | null>(null);
  // the challenger's ghost (a /d/ challenge link): loaded once, flown on any run of that day's exact seed
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const ghostOn = useRef<{ g: Ghost; joined: boolean; out: boolean } | null>(null);
  const ghostRef = useRef<Ghost | null>(null), ghostFor = useRef<SimDriver | null>(null);   // the run the ghost was armed for
  useEffect(() => { ghostRef.current = ghost; ghostFor.current = null; }, [ghost]);
  useEffect(() => {
    const c = initial.challenge, day = initial.challengeDay || dailyId; if (!c || !/^[0-9a-f]{16}$/.test(c)) return;
    fetch(`/api/daily?id=${day}&run=${c}`).then((r) => (r.ok ? r.json() : null)).then((j) => { const r = j?.run; if (r) setGhost({ day, seed: typeof j.seed === "number" ? j.seed : null, name: r.name, multiple: r.multiple, boardedAtS: r.boardedAtS ?? null, outAtS: r.outAtS ?? null }); }).catch(() => {});
  }, [initial.challenge, initial.challengeDay, dailyId]);
  // practice XP (signed-in pilots): the server re-flies the run; shown on the summary
  const pilot = usePilotWallet();
  const [practiceXp, setPracticeXp] = useState<FreePlayXpResult | { ok: false; reason: string } | null>(null);
  const [runN, setRunN] = useState(0);
  const [tuneOpen, setTuneOpen] = useState(!!initial.tune);
  const drv = useRef<SimDriver | null>(null);
  const [, force] = useState(0);
  const [banner, setBanner] = useState<SimEvent | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [paused, setPaused] = useState(false);
  const [alert, setAlert] = useState<StripAlert>(null);
  const alertT = useRef(0);
  const showAlert = useCallback((a: { text: string; good?: boolean }) => { setAlert(a); window.clearTimeout(alertT.current); alertT.current = window.setTimeout(() => setAlert((x) => (x === a ? null : x)), 4500); }, []);
  // tramps/walls: the panel talks to the live SimRun (re-created every run), never to the live/mock store
  const twAdapter = useMemo(() => (runN > 0 ? createSimTrampWallAdapter(() => drv.current?.run ?? null, typeof window !== "undefined" ? localStorage : undefined) : undefined), [runN]);

  const start = useCallback((seedOverride?: number, o: { daily?: boolean; difficulty?: DifficultyId; minutes?: number } = {}) => {
    drv.current?.stop();
    const seed = o.daily ? seedOverride! : seedOverride ?? (seedText.trim() ? seedOf(/^\d+$/.test(seedText.trim()) ? +seedText.trim() : seedText.trim()) : (Math.random() * 2 ** 31) >>> 0);
    if (!o.daily) setSeedText(String(seed));
    const c: SimConfig = o.daily ? cloneConfig() : JSON.parse(JSON.stringify(cfg));
    if (!o.daily && initial.balance && initial.balance > 0) c.player.startBalanceUsd = initial.balance;
    // fresh SIMULATOR ledger + tramps/walls (own namespace) for every run
    try { resetSimStorage(localStorage); } catch { /* ignore */ }
    const diff = o.daily ? DAILY.difficulty : o.difficulty ?? difficulty, mins = o.daily ? PLAYER.dailyMinutes : o.minutes ?? minutes;
    if (o.difficulty || o.daily) setDifficulty(diff);
    if (o.minutes || o.daily) setMinutes(mins);
    setDailyRun(!!o.daily);
    const d = new SimDriver(c, diff, seed, mins); d.speed = o.daily ? 1 : speed; d.start(); drv.current = d;
    ghostEvent({ op: "clear" }); ghostOn.current = null; ghostFor.current = null;
    setPracticeXp(null);
    setAlert(null);
    d.onEvent((e) => {
      if (e.kind === "tell" || e.kind === "graduate" || e.kind === "rug" || e.kind === "cto") showAlert({ text: e.text, good: e.kind === "graduate" || e.kind === "cto" });
      if (e.kind === "rug" || e.kind === "cto" || e.kind === "graduate" || e.kind === "whale") { if (e.kind === "rug" || e.kind === "cto" || e.kind === "graduate" || e.kind === "whale") { setBanner(e); window.setTimeout(() => setBanner((b) => (b === e ? null : b)), e.kind === "whale" ? 2500 : 5000); } } });
    setSummary(null); setPaused(false); setRunN((n) => n + 1); setPhase("run");
  }, [cfg, difficulty, minutes, seedText, speed, initial.balance, showAlert]);
  /** open today's daily: its result if this device already flew it, otherwise the scored flight */
  const openDaily = useCallback(async () => {
    setDailyMsg(null);
    const have = savedDaily(dailyId);
    if (have?.verdict) { drv.current?.stop(); todaySeed.current = have.seed; setDailyRes({ seed: have.seed, inputs: have.inputs, verdict: have.verdict, error: null }); setPhase("daily"); return; }
    const t = await startDaily(dailyId);
    if (!t.ok) { setDailyMsg(t.error); setPhase("select"); return; }
    todaySeed.current = t.seed;
    if (t.already) {   // flown on this device before (local data cleared): the board has the scored run
      const r = await submitDaily(dailyId, [], "");
      if (r.ok) { const v = r.verdict, ins = v.inputs ?? []; saveDaily({ id: dailyId, seed: t.seed, inputs: ins, verdict: { ...v, inputs: undefined } }); setDailyRes({ seed: t.seed, inputs: ins, verdict: v, error: null }); setPhase("daily"); }
      else setDailyMsg(r.error);
      return;
    }
    ticketRef.current = { seed: t.seed, ticket: t.ticket };
    start(t.seed, { daily: true });
  }, [dailyId, start]);
  const finishDaily = useCallback(async (inputs: PlayerInput[]) => {
    const tk = ticketRef.current, seed = tk?.seed ?? todaySeed.current ?? 0; ticketRef.current = null;
    setDailyRes({ seed, inputs, verdict: null, error: null }); setPhase("daily");
    saveDaily({ id: dailyId, seed, inputs, verdict: null });
    const r = await submitDaily(dailyId, inputs, tk?.ticket ?? "");
    if (!r.ok) { setDailyRes({ seed, inputs, verdict: null, error: r.error }); return; }
    const scored = r.verdict.inputs ?? inputs;   // already flown on this device: the first run is the scored one
    saveDaily({ id: dailyId, seed, inputs: scored, verdict: { ...r.verdict, inputs: undefined } });
    setDailyRes({ seed, inputs: scored, verdict: r.verdict, error: null });
  }, [dailyId]);

  useEffect(() => () => drv.current?.stop(), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (initial.daily) openDaily(); else if (initial.autostart) start(); }, []);   // once, on mount
  // HUD refresh 4×/s (not per tick) + end-of-run summary
  useEffect(() => {
    if (phase !== "run") return;
    const iv = window.setInterval(() => {
      const d = drv.current; if (!d) return; force((x) => x + 1);
      if (ghostFor.current !== d) {   // arm the ghost once per run (it may load after the run started): only on that day's exact flight
        ghostFor.current = d; const g = ghostRef.current;
        ghostOn.current = g && g.boardedAtS != null && d.difficulty === DAILY.difficulty && d.minutes === PLAYER.dailyMinutes && d.seed === (g.day === dailyId ? todaySeed.current : g.seed) ? { g, joined: false, out: false } : null; }
      const go = ghostOn.current;   // the ghost boards and cashes out at the challenger's own times
      if (go && !go.joined && d.run.t >= go.g.boardedAtS!) { go.joined = true; ghostEvent({ op: "join", name: go.g.name });
        showAlert({ text: `${go.g.name}'s ghost boarded`, good: true }); }
      if (go && go.joined && !go.out && go.g.outAtS != null && d.run.t >= go.g.outAtS) { go.out = true; ghostEvent({ op: "out", tag: `CASHED OUT ${fmtMultiple(go.g.multiple)}` });
        showAlert({ text: `${go.g.name}'s ghost cashed out at ${fmtMultiple(go.g.multiple)}`, good: true }); }
      if (d.ended && dailyRun) { d.stop(); finishDaily(d.run.inputs.slice()); return; }
      if (d.ended) { const s = d.run.summary(); setSummary(s); setPhase("summary"); savePracticeBest(d.difficulty, scoreRun(d.run).multiple);
        // practice XP: only a default run (no tuning, $250, 2 min) can match the server's replay
        if (pilot && !initial.balance && minutes === PLAYER.defaultMinutes && !localStorage.getItem(SIM_STORAGE.tune))
          claimFreePlayXp(pilot, { practice: { difficulty: d.difficulty, seed: d.seed, inputs: d.run.inputs.slice() } }).then((r) => { setPracticeXp(r); if (r?.ok) dispatchEvent(new CustomEvent(XP_CHANGED_EVENT)); });
        try { const all = JSON.parse(localStorage.getItem(SIM_STORAGE.runs) || "[]"); all.unshift({ ...s, at: Date.now(), events: undefined }); localStorage.setItem(SIM_STORAGE.runs, JSON.stringify(all.slice(0, 20))); } catch { /* ignore */ } }
    }, 250);
    return () => window.clearInterval(iv);
  }, [phase, dailyRun, finishDaily, pilot, minutes, initial.balance, dailyId, showAlert]);
  useEffect(() => { if (drv.current) drv.current.speed = speed; }, [speed]);
  useEffect(() => { if (drv.current) drv.current.paused = paused; }, [paused]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.code === "Backquote" && !e.repeat) setTuneOpen((o) => !o); };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }, []);

  const endNow = () => { const d = drv.current; if (d) { d.ended = true; } };
  const exportRun = () => {
    const d = drv.current; if (!d) return;
    const blob = new Blob([JSON.stringify({ summary: d.run.summary(), leaderboard: d.run.leaderboard(), trades: d.run.trades, config: d.run.cfg }, null, 1)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `disciple-sim-${d.difficulty}-${d.seed}.json`; a.click(); URL.revokeObjectURL(a.href);
  };
  const search = useMemo(() => `source=sim&render=main&simrun=${runN}`, [runN]);
  const d = drv.current, run = d?.run;
  const D = cfg.difficulties[difficulty];
  // SNIPER TAX chip: sim launch = run t 0 (SIM_LAUNCH_TS epoch: snipeState needs launchTs > 0); params = the run's launch config (lib/config CURVE.antiSnipe* via lib/sim/config), incl. the
  // per-second table bpsBySec (0 from 7s), so it matches what SimMarket.antiSnipe() charges; run.t follows speed / pause. Curve phase only (buys after graduation pay none).
  const snipe = run && phase === "run" && run.m.phase === "curve"
    ? snipeState({ launchTs: SIM_LAUNCH_TS, nowSec: SIM_LAUNCH_TS + run.t, startPct: run.cfg.launch.antiSnipeStartBps / 100, windowSec: run.cfg.launch.antiSnipeDurationS, bpsBySec: run.cfg.launch.antiSnipeBpsBySec })
    : null;

  return (
    <>
      {(phase === "run" || phase === "summary") && (
        <>
          <FlightCanvas key={runN} search={search} />
          <PnlHud coin={`run-${runN}`} storagePrefix={SIM_STORAGE.pnlPrefix} modeLabel="FREE PLAY" syncEvent={SIM_POS_EVENT} />
          {TRAMP_WALLS_ENABLED && !dailyRun && <TrampWallPanel key={runN} token="SIMULATOR" adapter={twAdapter} owner={SIM_ME} supply={run?.m.S} simulator />}
          <TradeBridge token="SIMULATOR" storagePrefix={SIM_STORAGE.swapPrefix} />
          <SnipeChip state={snipe} />
        </>
      )}
      {phase === "run" && run && (
        <FreePlayStrip mode={dailyRun ? `DAILY #${dailyId}` : "PRACTICE"} left={clock(Math.max(0, minutes * 60 - run.t))} difficulty={difficulty} goals={scoreRun(run).goals} alert={alert} phone={phone}
          tune={tuneOpen && !dailyRun ? <>
            {SPEEDS.map((s) => <button key={s} type="button" data-testid={`sim-speed-${s}`} aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s}×</button>)}
            <button type="button" aria-pressed={paused} onClick={() => setPaused((p) => !p)}>{paused ? "▶" : "⏸"}</button>
            <button type="button" data-testid="sim-restart" onClick={() => start(d!.seed)} title="Restart with the same seed">⟲</button>
            <button type="button" data-testid="sim-end" onClick={endNow} title="End the run">■</button>
            <span style={{ font: "500 11px var(--dsc-font-ui)", color: "#D7D9E4", alignSelf: "center" }}>seed {d!.seed} · {run.bots.length} bots</span>
          </> : undefined} />
      )}
      {banner && phase === "run" && (
        <div data-testid={`sim-banner-${banner.kind}`} style={{ ...panel, position: "fixed", left: "50%", top: 150, transform: "translateX(-50%)", padding: "10px 18px", zIndex: 32, fontSize: banner.kind === "whale" ? 13 : 18, fontWeight: 800, letterSpacing: 1,
          borderColor: banner.kind === "rug" ? "#ff6b7d" : banner.kind === "cto" ? "#8ff0c0" : "#ffd24a", color: banner.kind === "rug" ? "#ff8f9f" : banner.kind === "cto" ? "#8ff0c0" : "#ffe7a3" }}>
          <Icon name={banner.kind === "rug" ? "rug" : banner.kind === "cto" ? "cto" : banner.kind === "graduate" ? "graduation" : "whale"} size={banner.kind === "whale" ? 14 : 18} />{" "}{banner.text}
        </div>
      )}
      {phase === "select" && (
        <FreePlayHub dailyId={dailyId} msg={dailyMsg} onDaily={openDaily}
          onPractice={(id) => { setDifficulty(id); start(tuneOpen && seedText.trim() ? undefined : (Math.random() * 2 ** 31) >>> 0, { difficulty: id }); }}
          tune={tuneOpen ? (
            <div className={"fp-tune"} style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", fontSize: 12, color: "#D7D9E4", padding: "12px 14px", border: "1px dashed #2E323A", borderRadius: 12 }}>
              <b style={{ color: "#F3DFA8" }}>Tuning</b>
              <label>seed <input data-testid="sim-seed" value={seedText} placeholder="random" onChange={(e) => setSeedText(e.target.value)} style={{ width: 110, background: "#0d1030", color: "#F2F3F7", border: "1px solid #2E323A", borderRadius: 6, padding: "4px 6px" }} /></label>
              <label>minutes <input type="number" min={1} max={60} value={minutes} onChange={(e) => setMinutes(Math.max(1, Math.min(60, +e.target.value || PLAYER.defaultMinutes)))} style={{ width: 56, background: "#0d1030", color: "#F2F3F7", border: "1px solid #2E323A", borderRadius: 6, padding: "4px 6px" }} /></label>
              <span>speed {SPEEDS.map((s) => <button key={s} type="button" style={{ ...btn(speed === s), marginLeft: 4 }} onClick={() => setSpeed(s)}>{s}×</button>)}</span>
              <span>balance ${(initial.balance || cfg.player.startBalanceUsd).toLocaleString()}</span>
              <button type="button" data-testid="sim-start" onClick={() => start()} style={{ ...btn(true, D.color), padding: "6px 14px", marginLeft: "auto" }}>START {D.label.toUpperCase()}</button>
            </div>) : undefined} />
      )}
      {phase === "daily" && dailyRes && (
        <DailyResult id={dailyId} seed={dailyRes.seed} label={cfg.difficulties[DAILY.difficulty].label.toUpperCase()} inputs={dailyRes.inputs} verdict={dailyRes.verdict} error={dailyRes.error}
          ghost={ghost && ghost.day === dailyId ? { name: ghost.name, multiple: ghost.multiple, outAtS: ghost.outAtS } : null}
          onClose={() => { drv.current?.stop(); setDailyRun(false); setPhase("select"); }}
          onAgain={() => start(dailyRes.seed, { difficulty: DAILY.difficulty, minutes: PLAYER.dailyMinutes })}
          onPractice={() => { setSeedText(""); start((Math.random() * 2 ** 31) >>> 0, { difficulty: DAILY.difficulty }); }} />
      )}
      {phase === "summary" && summary && d && (() => { const sc = scoreRun(d.run); return (
        <PracticeResult difficulty={summary.difficulty} score={sc} rank={summary.you.rank} of={summary.you.of}
          xp={practiceXp?.ok ? (practiceXp.already ? "XP for this flight is already saved." : practiceXp.xp > 0 ? `+${practiceXp.xp} XP saved to your level${practiceXp.capped ? ` (Free play XP stops at ${practiceXp.perDay} a day)` : ""}.` : practiceXp.capped ? `Free play XP is capped at ${practiceXp.perDay} a day. Come back tomorrow.` : "Board a flight to earn XP.")
            : practiceXp && !practiceXp.ok ? practiceXp.reason : pilot ? "Saving XP…" : "Sign in to earn XP from Free play."}
          onAgain={() => start(summary.seed)} onNew={() => { setSeedText(""); start((Math.random() * 2 ** 31) >>> 0); }} onHub={() => { drv.current?.stop(); setPhase("select"); }}
          extra={tuneOpen ? <button type="button" style={{ ...btn(false, "#ffd24a"), alignSelf: "flex-start" }} onClick={exportRun}>export JSON · seed {summary.seed}</button> : undefined} />); })()}
      {tuneOpen && <TunePanel cfg={cfg} difficulty={difficulty} onApply={(c) => { setCfg(c); try { localStorage.setItem(SIM_STORAGE.tune, JSON.stringify(c)); } catch { /* ignore */ } }}
        onReset={() => { const c = cloneConfig(); setCfg(c); try { localStorage.removeItem(SIM_STORAGE.tune); } catch { /* ignore */ } }} onExport={exportRun} live={!!run} onClose={() => setTuneOpen(false)} />}
    </>
  );
}


/** Dev tuning panel (?tune=1 or the ` key): live-edit difficulty + archetype knobs; full config as JSON. Applies to the NEXT start/restart. */
function TunePanel({ cfg, difficulty, onApply, onReset, onExport, live, onClose }: { cfg: SimConfig; difficulty: DifficultyId; onApply: (c: SimConfig) => void; onReset: () => void; onExport: () => void; live: boolean; onClose: () => void }) {
  const [json, setJson] = useState(() => JSON.stringify(cfg, null, 1));
  const [err, setErr] = useState("");
  useEffect(() => setJson(JSON.stringify(cfg, null, 1)), [cfg]);
  const D = cfg.difficulties[difficulty];
  const set = (path: (c: SimConfig) => void) => { const c: SimConfig = JSON.parse(JSON.stringify(cfg)); path(c); onApply(c); };
  const num = (label: string, v: number, f: (c: SimConfig, x: number) => void, step = 0.1) => (
    <label style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>{label}<input type="number" step={step} value={v} onChange={(e) => set((c) => f(c, +e.target.value))}
      style={{ ...mono, width: 70, background: "#0d1030", color: "#e8ecff", border: "1px solid #334", borderRadius: 4, fontSize: 11 }} /></label>);
  return (
    <div data-testid="sim-tune" style={{ ...panel, position: "fixed", right: 12, bottom: 12, width: 340, maxHeight: "72vh", overflow: "auto", padding: 10, zIndex: 45, fontSize: 11, borderColor: "#ffd24a" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}><b style={{ color: "#ffd24a" }}>TUNING · lib/sim/config.ts</b><button style={btn(false, "#ffd24a")} onClick={onClose}>×</button></div>
      <div style={{ opacity: 0.7, marginBottom: 6 }}>Edits apply on the next Start / ⟲ restart (same seed = A/B compare). Saved locally under {SIM_STORAGE.tune}.</div>
      <div style={{ color: D.color, fontWeight: 700, margin: "4px 0" }}>{D.label}</div>
      <div style={{ display: "grid", gap: 3 }}>
        {num("arrivals / min", D.arrivalsPerMin, (c, x) => { c.difficulties[difficulty].arrivalsPerMin = x; }, 0.5)}
        {num("activity ×", D.activity, (c, x) => { c.difficulties[difficulty].activity = x; })}
        {num("trade size ×", D.size, (c, x) => { c.difficulties[difficulty].size = x; })}
        {num("hype σ (variance)", D.hypeSigma, (c, x) => { c.difficulties[difficulty].hypeSigma = x; }, 0.05)}
        {num("max bots", D.maxBots, (c, x) => { c.difficulties[difficulty].maxBots = x; }, 5)}
        {D.rug && num("rug chance", D.rug.chance, (c, x) => { c.difficulties[difficulty].rug!.chance = x; }, 0.05)}
        {D.rug && num("CTO chance", D.rug.ctoChance, (c, x) => { c.difficulties[difficulty].rug!.ctoChance = x; }, 0.05)}
        {num("start balance $", cfg.player.startBalanceUsd, (c, x) => { c.player.startBalanceUsd = x; }, 100)}
        {num("points / tier", cfg.points.perTier, (c, x) => { c.points.perTier = x; }, 10)}
        {num("points / $ PnL", cfg.points.perPnlUsd, (c, x) => { c.points.perPnlUsd = x; }, 0.5)}
      </div>
      <div style={{ opacity: 0.7, margin: "8px 0 2px" }}>archetypes (cash $ · rate/min · TP · SL)</div>
      {(Object.keys(cfg.archetypes) as ArchetypeId[]).map((a) => { const A = cfg.archetypes[a]; return (
        <div key={a} style={{ display: "grid", gridTemplateColumns: "78px repeat(4, 1fr)", gap: 3, alignItems: "center", marginBottom: 2 }}>
          <span title={A.blurb}>{A.label}</span>
          {(["cash", "rate", "tp", "sl"] as const).map((k) => <input key={k} type="number" step={k === "cash" ? 50 : 0.05} value={A[k]} onChange={(e) => set((c) => { c.archetypes[a][k] = +e.target.value; })}
            style={{ ...mono, width: "100%", background: "#0d1030", color: "#e8ecff", border: "1px solid #334", borderRadius: 4, fontSize: 10 }} />)}
        </div>); })}
      <details style={{ marginTop: 6 }}><summary style={{ cursor: "pointer" }}>full config JSON</summary>
        <textarea value={json} onChange={(e) => setJson(e.target.value)} style={{ ...mono, width: "100%", height: 160, background: "#0d1030", color: "#e8ecff", fontSize: 10 }} />
        <button style={btn()} onClick={() => { try { onApply(JSON.parse(json)); setErr(""); } catch (e) { setErr(String(e)); } }}>apply JSON</button> {err && <span style={{ color: "#ff9fb8" }}>{err}</span>}
      </details>
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <button style={btn(false, "#ffb0c8")} onClick={onReset}>reset defaults</button>
        <button style={btn(false, "#ffd24a")} disabled={!live} onClick={onExport}>export run JSON</button>
      </div>
    </div>
  );
}
