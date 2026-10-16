"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FlightCanvas from "@/components/FlightCanvas";
import PnlHud from "@/components/PnlHud";
import TradeBridge from "@/components/TradeBridge";
import TrampWallPanel from "@/components/trampwalls/TrampWallPanel";
import { ARCHETYPES, cloneConfig, SIM_STORAGE, type ArchetypeId, type DifficultyId, type SimConfig } from "@/lib/sim/config";
import { SimDriver } from "@/lib/sim/driver";
import { fmt, seedOf } from "@/lib/sim/run";
import type { SimEvent } from "@/lib/sim/run";

type Summary = ReturnType<SimDriver["run"]["summary"]>;
const DIFFS: DifficultyId[] = ["pve", "pvp", "trench"];
const SPEEDS = [1, 2, 4];
const mono: React.CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };
const panel: React.CSSProperties = { ...mono, background: "rgba(8,10,24,.86)", border: "1px solid rgba(143,216,255,.35)", borderRadius: 12, color: "#e8ecff", boxShadow: "0 10px 40px rgba(0,0,0,.45)" };
const btn = (on = false, c = "#8fd8ff"): React.CSSProperties => ({ ...mono, cursor: "pointer", padding: "5px 10px", borderRadius: 8, fontSize: 12, fontWeight: 700,
  border: `1px solid ${c}`, background: on ? c : "transparent", color: on ? "#0a0c1c" : c });
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const usd = (v: number) => (v < 0 ? "−$" : "+$") + Math.abs(v).toFixed(2);

function loadTune(): SimConfig { try { const s = localStorage.getItem(SIM_STORAGE.tune); if (s) return { ...cloneConfig(), ...JSON.parse(s) }; } catch { /* ignore */ } return cloneConfig(); }

/** SIMULATOR — free paper-trading mode on a fully local market (lib/sim). Never touches wallets or real profiles. */
export default function SimMode({ initial }: { initial: { difficulty?: string; seed?: string; tune?: boolean; autostart?: boolean; speed?: number; minutes?: number; balance?: number } }) {
  const [cfg, setCfg] = useState<SimConfig>(() => cloneConfig());
  useEffect(() => { setCfg(loadTune()); }, []);
  const [difficulty, setDifficulty] = useState<DifficultyId>(DIFFS.includes(initial.difficulty as DifficultyId) ? (initial.difficulty as DifficultyId) : "pve");
  const [seedText, setSeedText] = useState(initial.seed || "");
  const [speed, setSpeed] = useState(SPEEDS.includes(initial.speed || 0) ? initial.speed! : 1);
  const [minutes, setMinutes] = useState(initial.minutes || 10);
  const [phase, setPhase] = useState<"select" | "run" | "summary">("select");
  const [runN, setRunN] = useState(0);
  const [tuneOpen, setTuneOpen] = useState(!!initial.tune);
  const drv = useRef<SimDriver | null>(null);
  const [, force] = useState(0);
  const [banner, setBanner] = useState<SimEvent | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [paused, setPaused] = useState(false);

  const start = useCallback((seedOverride?: number) => {
    drv.current?.stop();
    const seed = seedOverride ?? (seedText.trim() ? seedOf(/^\d+$/.test(seedText.trim()) ? +seedText.trim() : seedText.trim()) : (Math.random() * 2 ** 31) >>> 0);
    setSeedText(String(seed));
    const c: SimConfig = JSON.parse(JSON.stringify(cfg));
    if (initial.balance && initial.balance > 0) c.player.startBalanceUsd = initial.balance;
    // fresh SIMULATOR ledger (own namespace) for every run
    try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k?.startsWith(SIM_STORAGE.pnlPrefix)) localStorage.removeItem(k); } } catch { /* ignore */ }
    const d = new SimDriver(c, difficulty, seed, minutes); d.speed = speed; d.start(); drv.current = d;
    d.onEvent((e) => { if (e.kind === "rug" || e.kind === "cto" || e.kind === "graduate" || e.kind === "whale") { setBanner(e); window.setTimeout(() => setBanner((b) => (b === e ? null : b)), e.kind === "whale" ? 2500 : 5000); } });
    setSummary(null); setPaused(false); setRunN((n) => n + 1); setPhase("run");
  }, [cfg, difficulty, minutes, seedText, speed, initial.balance]);

  useEffect(() => () => drv.current?.stop(), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (initial.autostart) start(); }, []);   // once, on mount
  // HUD refresh 4×/s (not per tick) + end-of-run summary
  useEffect(() => {
    if (phase !== "run") return;
    const iv = window.setInterval(() => {
      const d = drv.current; if (!d) return; force((x) => x + 1);
      if (d.ended) { const s = d.run.summary(); setSummary(s); setPhase("summary");
        try { const all = JSON.parse(localStorage.getItem(SIM_STORAGE.runs) || "[]"); all.unshift({ ...s, at: Date.now(), events: undefined }); localStorage.setItem(SIM_STORAGE.runs, JSON.stringify(all.slice(0, 20))); } catch { /* ignore */ } }
    }, 250);
    return () => window.clearInterval(iv);
  }, [phase]);
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
  const lb = run && phase !== "select" ? run.leaderboard() : [];
  const me = lb.findIndex((r) => r.arch === "you");
  const D = cfg.difficulties[difficulty];

  return (
    <>
      {phase !== "select" && (
        <>
          <FlightCanvas key={runN} search={search} />
          <PnlHud coin={`run-${runN}`} storagePrefix={SIM_STORAGE.pnlPrefix} modeLabel="SIMULATOR" />
          <TrampWallPanel token="SIMULATOR" />
          <TradeBridge token="SIMULATOR" />
        </>
      )}
      {phase === "run" && run && (
        <div data-testid="sim-bar" style={{ ...panel, position: "fixed", left: "calc(var(--ap-rail-w, 64px) + 12px)", top: 430, width: 236, padding: "8px 10px", zIndex: 31, fontSize: 11 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <b style={{ color: "#8fd8ff", letterSpacing: 1 }}>SIMULATOR</b>
            <span style={{ color: D.color, fontWeight: 700 }}>{D.label}</span>
          </div>
          <div style={{ opacity: 0.8, margin: "2px 0 6px" }}>seed {d!.seed} · {clock(run.t)} / {clock(minutes * 60)} · {run.bots.length} bots · {run.m.phase === "curve" ? `curve ${(run.m.sold / run.m.sC * 100).toFixed(0)}%` : "pool"}</div>
          <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
            {SPEEDS.map((s) => <button key={s} data-testid={`sim-speed-${s}`} style={btn(speed === s)} onClick={() => setSpeed(s)}>{s}×</button>)}
            <button style={btn(paused, "#ffd24a")} onClick={() => setPaused((p) => !p)}>{paused ? "▶" : "⏸"}</button>
            <button data-testid="sim-restart" style={btn(false, "#ffb0c8")} onClick={() => start(d!.seed)} title="restart with the same seed">⟲</button>
            <button data-testid="sim-end" style={btn(false, "#ffb0c8")} onClick={endNow} title="end run → summary">■</button>
          </div>
          <div style={{ opacity: 0.7, marginBottom: 2 }}>PnL LEADERBOARD · peak {fmt(run.peak)}</div>
          {lb.slice(0, 3).map((r, i) => <Row key={r.name} i={i} name={r.name} arch={r.arch} total={r.total} me={r.arch === "you"} />)}
          {me >= 3 && <Row i={me} name="you" arch="you" total={lb[me].total} me />}
        </div>
      )}
      {banner && phase === "run" && (
        <div data-testid={`sim-banner-${banner.kind}`} style={{ ...panel, position: "fixed", left: "50%", top: 150, transform: "translateX(-50%)", padding: "10px 18px", zIndex: 32, fontSize: banner.kind === "whale" ? 13 : 18, fontWeight: 800, letterSpacing: 1,
          borderColor: banner.kind === "rug" ? "#ff6b7d" : banner.kind === "cto" ? "#8ff0c0" : "#ffd24a", color: banner.kind === "rug" ? "#ff8f9f" : banner.kind === "cto" ? "#8ff0c0" : "#ffe7a3" }}>
          {banner.kind === "rug" ? "☠ " : banner.kind === "cto" ? "✊ " : banner.kind === "graduate" ? "✦ " : "🐋 "}{banner.text}
        </div>
      )}
      {phase === "select" && (
        <div data-testid="sim-select" style={{ position: "fixed", inset: 0, left: "var(--ap-rail-w, 64px)", display: "grid", placeItems: "center", background: "radial-gradient(ellipse at 50% 30%, #1a1f4a 0%, #070814 70%)", zIndex: 30, overflow: "auto" }}>
          <div style={{ ...mono, width: "min(980px, 94vw)", color: "#e8ecff", padding: 20 }}>
            <div style={{ fontSize: 13, color: "#8fd8ff", letterSpacing: 3 }}>DISCIPLE</div>
            <div style={{ fontSize: 34, fontWeight: 900, letterSpacing: 2, margin: "2px 0 4px" }}>SIMULATOR</div>
            <div style={{ opacity: 0.8, marginBottom: 18, fontSize: 13 }}>Free paper trading on a fully local market. A fresh coin launches on the real Launchpad curve ($7K → graduates at $33K) and bots trade it. Same ammo, sells, bombs and tramps as the real game. No wallet, no transactions.</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
              {DIFFS.map((id) => { const x = cfg.difficulties[id]; const on = id === difficulty; return (
                <button key={id} data-testid={`sim-diff-${id}`} onClick={() => setDifficulty(id)} style={{ ...panel, textAlign: "left", padding: 16, cursor: "pointer", borderColor: on ? x.color : "rgba(255,255,255,.15)", boxShadow: on ? `0 0 0 2px ${x.color}55, 0 10px 40px rgba(0,0,0,.45)` : panel.boxShadow }}>
                  <div style={{ color: x.color, fontWeight: 900, fontSize: 18 }}>{x.label}</div>
                  <div style={{ fontSize: 11, letterSpacing: 2, opacity: 0.8, marginBottom: 8 }}>{x.tag}</div>
                  <div style={{ fontSize: 12, lineHeight: 1.5, opacity: 0.9, minHeight: 90 }}>{x.blurb}</div>
                  <div style={{ fontSize: 11, opacity: 0.65, marginTop: 8 }}>bots: {Object.entries(x.mix).map(([a]) => ARCHETYPES[a as ArchetypeId].label).join(", ")}{x.rug ? ", sniper, bundler, dev, CTO" : ""}</div>
                </button>); })}
            </div>
            <div style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 18, flexWrap: "wrap", fontSize: 12 }}>
              <label>seed <input data-testid="sim-seed" value={seedText} placeholder="random" onChange={(e) => setSeedText(e.target.value)} style={{ ...mono, width: 110, background: "#0d1030", color: "#e8ecff", border: "1px solid #334", borderRadius: 6, padding: "4px 6px" }} /></label>
              <label>minutes <input type="number" min={1} max={60} value={minutes} onChange={(e) => setMinutes(Math.max(1, Math.min(60, +e.target.value || 10)))} style={{ ...mono, width: 56, background: "#0d1030", color: "#e8ecff", border: "1px solid #334", borderRadius: 6, padding: "4px 6px" }} /></label>
              <span>speed {SPEEDS.map((s) => <button key={s} style={{ ...btn(speed === s), marginLeft: 4 }} onClick={() => setSpeed(s)}>{s}×</button>)}</span>
              <span style={{ opacity: 0.75 }}>balance ${(initial.balance || cfg.player.startBalanceUsd).toLocaleString()} paper</span>
              <button data-testid="sim-start" onClick={() => start()} style={{ ...btn(true, D.color), padding: "10px 26px", fontSize: 15, marginLeft: "auto" }}>START ▸</button>
            </div>
            <div style={{ fontSize: 11, opacity: 0.55, marginTop: 14 }}>Keys in flight: Space buy · Z/X/C/V sell · Shift bomb · W boost · A/D lane · ` tuning panel. Same seed = same bots and market.</div>
          </div>
        </div>
      )}
      {phase === "summary" && summary && (
        <div data-testid="sim-summary" style={{ position: "fixed", inset: 0, left: "var(--ap-rail-w, 64px)", display: "grid", placeItems: "center", background: "rgba(4,5,14,.78)", zIndex: 40 }}>
          <div style={{ ...panel, width: "min(760px, 94vw)", padding: 22 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}><b style={{ color: "#8fd8ff", letterSpacing: 2 }}>SIMULATOR · RUN SUMMARY</b><span style={{ color: cfg.difficulties[summary.difficulty].color, fontWeight: 800 }}>{cfg.difficulties[summary.difficulty].label} · seed {summary.seed}</span></div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, margin: "16px 0" }}>
              <Stat k="PEAK MCAP" v={fmt(summary.peakMcap)} sub={summary.peakTier} />
              <Stat k="YOUR PnL" v={usd(summary.you.total)} sub={`realized ${usd(summary.you.realized)} · fees $${summary.you.fees.toFixed(2)}`} c={summary.you.total >= 0 ? "#8ff0c0" : "#ff9fb8"} />
              <Stat k="RANK" v={`#${summary.you.rank}`} sub={`of ${summary.you.of} traders`} />
              <Stat k="POINTS" v={String(summary.points)} sub={`${summary.achievements.length} achievements`} c="#ffd24a" />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, fontSize: 12 }}>
              <div>
                <div style={{ opacity: 0.7, marginBottom: 4 }}>ACHIEVEMENTS</div>
                {summary.achievements.length ? summary.achievements.map((a) => <div key={a}>★ {a}</div>) : <div style={{ opacity: 0.6 }}>none this run</div>}
                <div style={{ opacity: 0.7, margin: "10px 0 4px" }}>EVENTS</div>
                {summary.events.filter((e) => e.kind !== "whale").slice(0, 8).map((e, i) => <div key={i} style={{ color: e.kind === "rug" ? "#ff8f9f" : e.kind === "cto" ? "#8ff0c0" : undefined }}>{clock(e.t)} {e.text}</div>)}
              </div>
              <div>
                <div style={{ opacity: 0.7, marginBottom: 4 }}>TOP TRADERS (PnL)</div>
                {summary.top.slice(0, 8).map((r, i) => <Row key={r.name} i={i} name={r.name} arch={r.arch} total={r.total} me={r.arch === "you"} />)}
                <div style={{ opacity: 0.6, marginTop: 8 }}>final {fmt(summary.finalMcap)} · {summary.bots} bots · {summary.trades} trades{summary.graduatedAtS != null ? ` · graduated at ${clock(summary.graduatedAtS)}` : ""}</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
              <button data-testid="sim-again" style={btn(true)} onClick={() => start(summary.seed)}>⟲ same seed</button>
              <button style={btn()} onClick={() => { setSeedText(""); start(); }}>new seed</button>
              <button style={btn()} onClick={() => { drv.current?.stop(); setPhase("select"); }}>change mode</button>
              <button style={{ ...btn(false, "#ffd24a"), marginLeft: "auto" }} onClick={exportRun}>export JSON</button>
            </div>
            <div style={{ fontSize: 10, opacity: 0.5, marginTop: 10 }}>SIMULATOR stats are stored locally under their own key and never touch real or paper profiles or balances.</div>
          </div>
        </div>
      )}
      {tuneOpen && <TunePanel cfg={cfg} difficulty={difficulty} onApply={(c) => { setCfg(c); try { localStorage.setItem(SIM_STORAGE.tune, JSON.stringify(c)); } catch { /* ignore */ } }}
        onReset={() => { const c = cloneConfig(); setCfg(c); try { localStorage.removeItem(SIM_STORAGE.tune); } catch { /* ignore */ } }} onExport={exportRun} live={!!run} onClose={() => setTuneOpen(false)} />}
    </>
  );
}

function Row({ i, name, arch, total, me }: { i: number; name: string; arch: string; total: number; me: boolean }) {
  return <div style={{ display: "flex", justifyContent: "space-between", color: me ? "#8fd8ff" : undefined, fontWeight: me ? 800 : 400 }}>
    <span>{i + 1}. {name}{arch !== "you" && !name.toLowerCase().includes(arch.slice(0, 4)) ? <span style={{ opacity: 0.5 }}> ·{arch}</span> : null}</span>
    <span style={{ color: total >= 0 ? "#8ff0c0" : "#ff9fb8" }}>{usd(total)}</span></div>;
}
function Stat({ k, v, sub, c }: { k: string; v: string; sub?: string; c?: string }) {
  return <div style={{ background: "rgba(255,255,255,.04)", borderRadius: 10, padding: 10 }}><div style={{ fontSize: 10, opacity: 0.65, letterSpacing: 1 }}>{k}</div>
    <div style={{ fontSize: 22, fontWeight: 900, color: c || "#e8ecff" }}>{v}</div><div style={{ fontSize: 10, opacity: 0.65 }}>{sub}</div></div>;
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
