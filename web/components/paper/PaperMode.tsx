"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PaperRound, PLAYER_ID, type Standing, type Trade } from "@/lib/paper/engine";
import { ARCH_LABEL, DIFFICULTIES, LOBBY_MIX, START_CASH, type Difficulty } from "@/lib/paper/config";
import { curveCsv, roundJson, roundSummary, tradesCsv } from "@/lib/paper/export";
import { seedOf } from "@/lib/sim/run";

/** PAPER TRADING prototype screen: lobby → round → results. Deliberately plain (SITE designs the real UI from
 *  web/docs/paper-trading-plan.md). Everything is simulated in this tab; nothing here talks to a wallet, RPC or API. */
const mono: React.CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };
const card: React.CSSProperties = { background: "rgba(8,10,24,.9)", border: "1px solid rgba(143,216,255,.3)", borderRadius: 10, padding: 12 };
const btn = (c = "#8fd8ff", on = false): React.CSSProperties => ({ ...mono, cursor: "pointer", padding: "6px 10px", borderRadius: 8, fontSize: 12, fontWeight: 700, border: `1px solid ${c}`, background: on ? c : "transparent", color: on ? "#0a0c1c" : c });
const $ = (v: number) => (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clock = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;
const SPEEDS = [1, 10, 60];
const DIFF_LABEL: Record<Difficulty, string> = { easy: "Easy", medium: "Medium", hard: "Hard" };

function download(name: string, body: string, type: string) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([body], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function Chart({ path, w = 560, h = 180 }: { path: number[]; w?: number; h?: number }) {
  const step = Math.max(1, Math.floor(path.length / 400)), pts = path.filter((_, i) => i % step === 0 || i === path.length - 1);
  const lo = Math.min(...pts) * 0.98, hi = Math.max(...pts, 3500) * 1.02, n = Math.max(2400 / step, pts.length);
  const d = pts.map((m, i) => `${i ? "L" : "M"}${(i / n * w).toFixed(1)},${(h - (m - lo) / (hi - lo) * h).toFixed(1)}`).join("");
  return <svg data-testid="paper-chart" width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: "rgba(0,0,0,.25)", borderRadius: 8 }}><path d={d} fill="none" stroke="#7CFFB2" strokeWidth={2} /></svg>;
}

export default function PaperMode({ initial }: { initial: { difficulty?: string; seed?: string; speed?: number; autostart?: boolean; endAt?: number } }) {
  const [difficulty, setDifficulty] = useState<Difficulty>(DIFFICULTIES.includes(initial.difficulty as Difficulty) ? (initial.difficulty as Difficulty) : "medium");
  const [seedText, setSeedText] = useState(initial.seed || "");
  const [speed, setSpeed] = useState(SPEEDS.includes(initial.speed || 0) ? initial.speed! : 1);
  const [screen, setScreen] = useState<"lobby" | "round" | "results">("lobby");
  const [quitOpen, setQuitOpen] = useState(false);
  const round = useRef<PaperRound | null>(null);
  const [, force] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = () => { if (timer.current) clearInterval(timer.current); timer.current = null; };
  const start = useCallback((seedOverride?: number) => {
    stop();
    const seed = seedOverride ?? (seedText.trim() ? seedOf(/^\d+$/.test(seedText.trim()) ? +seedText.trim() : seedText.trim()) : (Math.random() * 2 ** 31) >>> 0);
    setSeedText(String(seed));
    const r = new PaperRound(difficulty, seed); round.current = r; setScreen("round"); setQuitOpen(false);
    let last = performance.now(), acc = 0;
    timer.current = setInterval(() => {
      const now = performance.now(); acc += (now - last) * speedRef.current; last = now;
      while (acc >= r.cfg.tickMs && !r.ended) { r.step(); acc -= r.cfg.tickMs; if (initial.endAt && r.t >= initial.endAt) r.endSession(); }
      if (r.ended) { stop(); setScreen("results"); }
      force((x) => x + 1);
    }, 100);
  }, [difficulty, seedText, initial.endAt]);
  const speedRef = useRef(speed); useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { if (initial.autostart) start(); return stop; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const r = round.current;
  const page: React.CSSProperties = { ...mono, minHeight: "100vh", background: "radial-gradient(ellipse at top, #141a3a, #05060f)", color: "#e8ecff", padding: 20, fontSize: 13 };
  const banner = <div style={{ ...mono, fontSize: 11, color: "#ffcf6b", marginBottom: 10 }} data-testid="paper-simulated">PAPER TRADING · SIMULATED DATA · 200 NPC BOTS · NO REAL MONEY, NO WALLET, NO TRANSACTIONS</div>;

  if (screen === "lobby" || !r) {
    return <div style={page} data-testid="paper-lobby">{banner}
      <h1 style={{ fontSize: 22, fontWeight: 800, margin: "4px 0 14px" }}>Paper Trading: 1 vs 200 bots</h1>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {DIFFICULTIES.map((d) => { const mx = LOBBY_MIX[d]; return (
          <button key={d} data-testid={`paper-diff-${d}`} onClick={() => setDifficulty(d)} style={{ ...card, ...mono, cursor: "pointer", width: 220, textAlign: "left", color: "#e8ecff", borderColor: d === difficulty ? "#7CFFB2" : "rgba(143,216,255,.3)" }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: d === difficulty ? "#7CFFB2" : "#e8ecff" }}>{DIFF_LABEL[d]}</div>
            <div>Start: {$(START_CASH[d])} each</div>
            <div style={{ opacity: .75 }}>Bots: {mx.easy} easy · {mx.medium} medium · {mx.hard} hard</div>
          </button>); })}
      </div>
      <div style={{ ...card, marginTop: 14, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", width: "fit-content" }}>
        <label>Seed <input data-testid="paper-seed" value={seedText} onChange={(e) => setSeedText(e.target.value)} placeholder="random" style={{ ...mono, width: 120, background: "#0a0c1c", color: "#e8ecff", border: "1px solid #345", borderRadius: 6, padding: 4 }} /></label>
        <span>Speed {SPEEDS.map((s) => <button key={s} onClick={() => setSpeed(s)} style={{ ...btn("#8fd8ff", s === speed), marginLeft: 4 }}>{s}x</button>)}</span>
        <button data-testid="paper-start" onClick={() => start()} style={btn("#7CFFB2", true)}>START 10:00 ROUND</button>
      </div>
      <p style={{ opacity: .7, maxWidth: 640, marginTop: 14 }}>Winner = most money at the end: cash + your tokens at the final price, minus what it would cost to sell them (fee, gas, slippage). The round ends at 10:00 or when the coin ascends. Same curve, 1% fee, $0.25 sample gas, sniper tax and holding cap as a real Easy coin.</p>
    </div>;
  }

  const st = r.standings(), me = st.find((s) => s.walletId === PLAYER_ID)!, p = r.player, nw = me.finalNetWorth;
  const ahead = me.rank > 1 ? st[me.rank - 2] : null;
  const tradeName = (t: Trade) => { const w = r.wallets[t.walletId]; return w.kind === "human" ? "YOU" : w.displayName; };
  const row = (s: Standing, hl = false) => <tr key={s.walletId} style={{ color: hl ? "#7CFFB2" : undefined }}><td>{s.rank}</td><td>{s.displayName}{s.kind === "bot" && <span style={{ fontSize: 9, marginLeft: 4, padding: "0 3px", border: "1px solid #ffcf6b", color: "#ffcf6b", borderRadius: 3 }}>BOT</span>}</td><td style={{ opacity: .7 }}>{s.paperRating ?? ""}</td><td style={{ textAlign: "right" }}>{$(s.finalNetWorth)}</td></tr>;

  if (screen === "results") {
    const sum = roundSummary(r), mine = r.trades.filter((t) => t.walletId === PLAYER_ID && t.side === "sell");
    const best = mine.reduce<Trade | null>((a, t) => (!a || t.pnl > a.pnl ? t : a), null), worst = mine.reduce<Trade | null>((a, t) => (!a || t.pnl < a.pnl ? t : a), null);
    const win = st[0], ww = r.wallets[win.walletId], wBuys = r.trades.filter((t) => t.walletId === win.walletId && t.side === "buy");
    const avgEntry = (ts: Trade[]) => { const c = ts.reduce((a, t) => a + t.cashAmount, 0), k = ts.reduce((a, t) => a + t.tokenAmount, 0); return k ? c / k * 1e6 : 0; };
    const tableEntry = avgEntry(r.trades.filter((t) => t.side === "buy"));
    const base = `paper-${r.cfg.difficulty}-${r.seed}`;
    return <div style={page} data-testid="paper-results">{banner}
      <h1 style={{ fontSize: 22, fontWeight: 800, margin: "4px 0 6px" }}>Round over · {r.ended === "graduation" ? `ASCENDED at ${clock(r.gradT!)}` : r.ended === "player_ended" ? "you ended the session" : "time"}</h1>
      <div style={{ marginBottom: 12, opacity: .8 }}>{DIFF_LABEL[r.cfg.difficulty]} · seed {r.seed} · final mcap {$(r.mcap)} · {sum.trades.toLocaleString()} trades</div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ ...card, width: 340 }}><b>PODIUM</b><table style={{ width: "100%", marginTop: 6 }}><tbody>{st.slice(0, 3).map((s) => row(s))}{me.rank > 3 && row(me, true)}</tbody></table>
          <div style={{ marginTop: 8, fontSize: 18, fontWeight: 800, color: "#7CFFB2" }} data-testid="paper-my-rank">You: #{me.rank} / {st.length} · {$(nw)}</div></div>
        <div style={{ ...card, width: 300 }}><b>YOUR ROUND</b>
          <div>Start {$(r.cfg.startCash)} → {$(nw)} ({((nw / r.cfg.startCash - 1) * 100).toFixed(1)}%)</div>
          <div>Realized PnL {$(p.realizedPnl)} · trades {p.trades}</div>
          <div>Trade fees {$(p.feesPaid)} · gas {$(p.gasPaid)}{p.snipeTaxPaid > 0 && ` · sniper tax ${$(p.snipeTaxPaid)}`}</div>
          <div>Crew tips paid {$(p.tipsPaid)} · received {$(p.tipsReceived)}</div>
          <div>Best sell {best ? $(best.pnl) : "none"} · worst {worst ? $(worst.pnl) : "none"}</div></div>
        <div style={{ ...card, width: 300 }}><b>WINNER: {win.displayName}</b>
          <div>{win.kind === "bot" ? `${ARCH_LABEL[ww.archetype!]} · ${ww.tier} bot · rating ${win.paperRating}` : "that's you"}</div>
          <div>Entries {wBuys.length} · avg entry mcap {$(avgEntry(wBuys))} vs table {$(tableEntry)}</div>
          <div>Sells {ww.sells} · realized {$(ww.realizedPnl)} · fees+gas {$(ww.feesPaid + ww.gasPaid)}</div></div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <button data-testid="paper-rematch" onClick={() => start((Math.random() * 2 ** 31) >>> 0)} style={btn("#7CFFB2", true)}>REMATCH (new seed)</button>
        <button onClick={() => { setScreen("lobby"); }} style={btn()}>CHANGE DIFFICULTY</button>
        <span style={{ width: 20 }} />
        <button data-testid="paper-dl-json" onClick={() => download(`${base}.json`, JSON.stringify(roundJson(r), null, 1), "application/json")} style={btn("#ffcf6b")}>DOWNLOAD ROUND DATA (JSON)</button>
        <button onClick={() => download(`${base}-trades.csv`, tradesCsv(r), "text/csv")} style={btn("#ffcf6b")}>TRADES CSV</button>
        <button onClick={() => download(`${base}-curve.csv`, curveCsv(r), "text/csv")} style={btn("#ffcf6b")}>CURVE CSV</button>
      </div>
      <div style={{ ...card, marginTop: 14, maxWidth: 900 }}><b>TUNING SNAPSHOT</b> (simulated)
        <div>graduated {String(sum.graduated)}{sum.graduationSec != null && ` at ${sum.graduationSec.toFixed(0)}s`} · peak mcap {$(sum.peakMcap)} · fees {$(sum.fees)} · gas {$(sum.gas)} · sniper tax {$(sum.sniperTax)} ({sum.sniperTaxHits} hits) · crew tips {$(sum.crewTipsTotal)} ({sum.crewTipSells} sells) · capped buys {sum.cappedBuys} · leader changes {sum.leaderChanges}</div>
        <div style={{ opacity: .8 }}>{Object.entries(sum.byArchetype).map(([k, v]) => `${k === "player" ? "you" : ARCH_LABEL[k as keyof typeof ARCH_LABEL]} ${v.avgPnlPct >= 0 ? "+" : ""}${v.avgPnlPct.toFixed(1)}%`).join(" · ")}</div></div>
    </div>;
  }

  // ---- round ----
  const left = r.cfg.durationSec - r.t, pct = Math.min(100, r.m.g * 100);
  const feed = r.trades.slice(-14).reverse();
  return <div style={page} data-testid="paper-round">{banner}
    <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
      <span style={{ fontSize: 26, fontWeight: 800, color: left < 60 ? "#ff7a7a" : "#fff" }} data-testid="paper-timer">{clock(left)}</span>
      <span>{DIFF_LABEL[r.cfg.difficulty]} · seed {r.seed} · {speed}x</span>
      <span>MCAP <b>{$(r.mcap)}</b></span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>to ASCEND <span style={{ display: "inline-block", width: 160, height: 8, background: "#223", borderRadius: 4 }}><span style={{ display: "block", width: `${pct}%`, height: 8, background: "#7CFFB2", borderRadius: 4 }} /></span>{pct.toFixed(1)}%</span>
      <span>Speed {SPEEDS.map((s) => <button key={s} onClick={() => setSpeed(s)} style={{ ...btn("#8fd8ff", s === speed), marginLeft: 4, padding: "2px 6px" }}>{s}x</button>)}</span>
      <button data-testid="paper-quit" onClick={() => setQuitOpen(true)} style={btn("#ff7a7a")}>QUIT</button>
    </div>
    {quitOpen && <div style={{ ...card, borderColor: "#ff7a7a", marginBottom: 10, width: "fit-content" }}>
      <div style={{ marginBottom: 6 }}>Quit this round?</div>
      <button onClick={() => { r.leave(); setQuitOpen(false); }} style={{ ...btn("#ffcf6b"), marginRight: 8 }}>QUIT AND LEAVE (round runs on, your wallet freezes, still scored)</button>
      <button data-testid="paper-end-session" onClick={() => { r.endSession(); }} style={{ ...btn("#ff7a7a"), marginRight: 8 }}>QUIT AND END SESSION (score everyone now)</button>
      <button onClick={() => setQuitOpen(false)} style={btn()}>CANCEL</button></div>}
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
      <div style={{ ...card, width: 580 }}><Chart path={r.path} />
        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          {[10, 25, 50, 100].map((u) => <button key={u} data-testid={`paper-buy-${u}`} disabled={!!p.frozen || p.cash < 0.5} onClick={() => r.intent({ kind: "buy", amountUsd: u })} style={btn("#7CFFB2")}>BOOST ${u}</button>)}
          <span style={{ width: 10 }} />
          {[10, 25, 50, 100].map((q) => <button key={q} data-testid={`paper-sell-${q}`} disabled={!!p.frozen || p.tokens <= 0} onClick={() => r.intent({ kind: "sell", pct: q })} style={btn("#ff7a7a")}>DUMP {q}%</button>)}
        </div>
        {p.frozen && <div style={{ color: "#ffcf6b", marginTop: 6 }}>You left: wallet frozen, the round runs on.</div>}
      </div>
      <div style={{ ...card, width: 270 }} data-testid="paper-your-run"><b>YOUR RUN</b>
        <div style={{ fontSize: 18, fontWeight: 800, color: "#7CFFB2", margin: "4px 0" }}>#{me.rank} / {st.length}</div>
        <div>Net worth {$(nw)}</div>
        <div>Cash {$(p.cash)} · bag {$(me.holdingsMarked)}</div>
        <div>Gap to next {ahead ? $(ahead.finalNetWorth - nw) : "-"} · to 1st {me.rank > 1 ? $(st[0].finalNetWorth - nw) : "-"}</div>
        <div style={{ opacity: .8 }}>Trade fees {$(p.feesPaid)}</div>
        <div style={{ opacity: .8 }}>Gas {$(p.gasPaid)}</div>
        {p.snipeTaxPaid > 0 && <div style={{ opacity: .8 }}>Sniper tax {$(p.snipeTaxPaid)}</div>}
        <div style={{ opacity: .8 }}>Crew tips -{$(p.tipsPaid)} / +{$(p.tipsReceived)}</div>
        <div style={{ opacity: .8 }}>Hold cap now {(r.capTokensNow() / 1e4).toFixed(2)}% of supply</div></div>
      <div style={{ ...card, width: 280 }} data-testid="paper-leaderboard"><b>LEADERBOARD</b>
        <table style={{ width: "100%", marginTop: 4 }}><tbody>{st.slice(0, 5).map((s) => row(s, s.walletId === PLAYER_ID))}{me.rank > 5 && row(me, true)}</tbody></table></div>
      <div style={{ ...card, width: 300 }}><b>TRADES</b>
        {feed.map((t) => <div key={t.id} style={{ color: t.side === "buy" ? "#7CFFB2" : "#ff7a7a", whiteSpace: "nowrap", overflow: "hidden" }}>{t.side === "buy" ? "BOOST" : "DUMP"} {$(t.cashAmount)} · {tradeName(t)}{t.walletId !== PLAYER_ID && <span style={{ opacity: .6 }}> ({r.wallets[t.walletId].paperRating})</span>}</div>)}</div>
    </div>
  </div>;
}
