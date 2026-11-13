"use client";
/**
 * Daily flight result (the approved ResultPhone board): the multiple, practice cash, today's rank, the three goals, the
 * flight chart (boarded, your best exit, the peak, the dump after it) and Challenge a friend / Fly it again / Practice Hard.
 * Numbers are the server's verdict; the chart is drawn from a local replay of the same input log (lib/sim/daily dailyRecap).
 * The XP card: a signed-in pilot's daily is saved to their level at once (POST /api/freeplay/xp); a signed-out pilot sees
 * the XP waiting and SAVE XP signs them in, then saves it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import LevelRing from "@/components/xp/LevelRing";
import { freePlayXp, FREE_PLAY_XP } from "@/lib/xp";
import { nextLevelUnlock } from "@/lib/unlocks";
import { fetchXp, usePilotWallet, XP_CHANGED_EVENT } from "@/lib/xpClient";
import { privyLogin, privyReady } from "@/lib/aa/sessionState";
import { dailyRecap, fmtMultiple as mult, type DailyScore } from "@/lib/sim/daily";
import { claimFreePlayXp, deviceId, refreshRank, type DailyVerdict, type FreePlayXpResult } from "@/lib/sim/dailyClient";
import { fmt, type PlayerInput } from "@/lib/sim/run";

const game: React.CSSProperties = { fontFamily: "var(--dsc-font-game)" };
const GOLD = "#F2C14E";
const money = (v: number) => (v < 0 ? "−$" : "+$") + Math.abs(Math.round(v)).toLocaleString("en-US");
const secs = (n: number) => `${n} second${n === 1 ? "" : "s"}`;

function Goal({ on, label }: { on: boolean; label: string }) {
  return (
    <div data-testid={`daily-goal-${on ? "on" : "off"}`} style={{ height: 58, boxSizing: "border-box", borderRadius: 12, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
      ...(on ? { background: "rgba(242,193,78,0.12)", border: "1px solid rgba(242,193,78,0.5)" } : { border: "1px dashed rgba(215,217,228,0.35)" }) }}>
      {on ? <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden><circle cx="12" cy="12" r="10" fill={GOLD} /><path d="M7.5 12.5l3 3 6-6.5" stroke="#121327" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(215,217,228,0.55)" strokeWidth="1.6" aria-hidden><circle cx="12" cy="12" r="9.5" /></svg>}
      <span style={{ ...game, fontWeight: 700, fontSize: 13, color: on ? "#F2F3F7" : "#D7D9E4" }}>{label}</span>
    </div>
  );
}

/** the line under the chart: when the peak came against your exit, and who dumped after */
function storyLine(s: DailyScore, dumper: string | null) {
  if (s.invested <= 0) return "You never boarded. Tap BOOST to get on.";
  let a: string;
  if (s.outAtS == null) a = "You held to the end.";
  else { const d = Math.round(s.peakAtS - s.outAtS); a = d > 0 ? `The peak came ${secs(d)} after you left.` : d === 0 ? "You sold the top." : `You got out ${secs(-d)} after the peak.`; }
  return dumper ? `${a} Then ${dumper} dumped.` : a;
}

export interface DailyGhost { name: string; multiple: number; outAtS: number | null }

export default function DailyResult({ id, seed, label, inputs, verdict, error, ghost, onClose, onAgain, onPractice }: {
  id: number; seed: number; label: string; inputs: PlayerInput[]; verdict: DailyVerdict | null; error?: string | null; ghost?: DailyGhost | null;
  onClose: () => void; onAgain: () => void; onPractice: () => void;
}) {
  const rc = useMemo(() => dailyRecap(seed, inputs), [seed, inputs]);
  const s = verdict?.score ?? rc.score;
  const [rank, setRank] = useState(verdict ? { rank: verdict.rank, count: verdict.count, topPct: verdict.topPct } : null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { if (verdict) refreshRank(id, verdict.runId).then((r) => { if (r) setRank(r); }); }, [id, verdict]);

  // XP: saved as soon as there is a scored run and a signed-in pilot
  const pilot = usePilotWallet(), waiting = freePlayXp("daily", s);
  const [xp, setXp] = useState<FreePlayXpResult | { ok: false; reason: string } | null>(null);
  const [mine, setMine] = useState<{ total: number; prestige: number } | null>(null);
  const claimed = useRef<string | null>(null);
  const save = async () => {
    if (!verdict || !pilot) return; claimed.current = pilot; setXp(null);
    const r = await claimFreePlayXp(pilot, { daily: { id, device: deviceId() } });
    if (r) { setXp(r); if (r.ok) dispatchEvent(new CustomEvent(XP_CHANGED_EVENT)); }
  };
  useEffect(() => { if (verdict && pilot && claimed.current !== pilot && waiting > 0) save(); }, [verdict, pilot]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!pilot) { setMine(null); return; } fetchXp(pilot).then((x) => { if (x) setMine({ total: x.totalXp, prestige: x.level.prestige }); }); }, [pilot]);
  const saved = xp && xp.ok ? xp : null;
  const unlock = saved ? nextLevelUnlock(saved.totalXp, saved.level.prestige) : nextLevelUnlock(mine?.total ?? 0, mine?.prestige ?? 0, waiting);
  const unlockLine = unlock ? ` ${unlock.more.toLocaleString("en-US")} more unlocks the ${unlock.name} ${unlock.part}.` : "";
  const xpHead = saved ? `+${saved.xp} XP` : pilot ? `+${waiting} XP` : `+${waiting} XP waiting`;
  const xpSub = saved ? (saved.already ? "Already saved to your level." : saved.xp < waiting ? `Saved. Free play XP stops at ${FREE_PLAY_XP.perDay} a day.` : "Saved to your level.") + unlockLine
    : xp && !xp.ok ? xp.reason : pilot ? (verdict ? "Saving to your level…" : "Saves once your score is in.") : `Sign in to keep it.${unlockLine}`;

  // chart: 330×98, log scale, markers at boarded / your best exit / the peak, a tick where the dump hit
  const W = 330, H = 98, P = rc.path, lo = Math.min(...P), hi = Math.max(...P), span = Math.max(1e-6, Math.log(hi / lo));
  const X = (t: number) => (Math.max(0, Math.min(P.length - 1, t)) / (P.length - 1)) * W, Y = (v: number) => H - 6 - (Math.log(v / lo) / span) * (H - 16);
  const at = (t: number) => P[Math.max(0, Math.min(P.length - 1, Math.round(t)))];
  const d = P.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(" ");
  const head = s.invested <= 0 ? "NEVER BOARDED" : s.outAtS == null ? "HELD TO THE END" : "CASHED OUT";
  const peakX = s.boardedMcap ? s.peakMcap / s.boardedMcap : null;

  const login = () => { try { if (privyReady()) privyLogin(); else setNote("Sign-in is still loading, try again in a second."); } catch (e) { setNote((e as Error).message); } };
  const challenge = async () => {
    if (!verdict) return;
    const url = `${location.origin}/d/${id}?c=${verdict.runId}`, text = `I cashed out at ${mult(s.multiple)} on Daily flight #${id}. Beat it.`;
    try { if (navigator.share) { await navigator.share({ title: "DISCIPLE Daily flight", text, url }); return; } } catch { return; }
    try { await navigator.clipboard.writeText(`${text} ${url}`); setNote("Challenge link copied."); } catch { setNote(url); }
  };

  return (
    <div data-testid="daily-result" style={{ position: "fixed", inset: 0, zIndex: 40, overflow: "auto", color: "#F2F3F7", fontFamily: "var(--dsc-font-ui)",
      background: "radial-gradient(420px 360px at 50% 8%, rgba(243,223,168,0.22) 0%, rgba(242,193,78,0.06) 40%, rgba(18,19,39,0) 70%), radial-gradient(520px 420px at 70% -6%, #26274B 0%, #121327 52%, #0B0C0E 100%)" }}>
      <div style={{ maxWidth: 390, minHeight: "100%", margin: "0 auto", padding: "calc(env(safe-area-inset-top, 0px) + 52px) 16px calc(env(safe-area-inset-bottom, 0px) + 28px)", boxSizing: "border-box", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ ...game, fontWeight: 700, fontSize: 15, letterSpacing: 1.5, color: "#F3DFA8" }}>DAILY FLIGHT #{id} · <span style={{ color: "#FFB48F" }}>{label}</span></span>
          <button type="button" data-testid="daily-close" aria-label="Close and go to Free play" onClick={onClose} style={{ width: 44, height: 44, boxSizing: "border-box", borderRadius: 12, background: "rgba(18,19,39,0.78)", border: "1px solid #2E323A", display: "grid", placeItems: "center", cursor: "pointer" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F2F3F7" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg></button>
        </div>

        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
          <span style={{ ...game, fontWeight: 700, fontSize: 16, letterSpacing: 3, color: "#D7D9E4" }}>{head}</span>
          <span data-testid="daily-multiple" style={{ ...game, fontWeight: 800, fontSize: 104, lineHeight: 0.9, color: GOLD }}>{mult(s.multiple)}</span>
          <span style={{ ...game, fontWeight: 700, fontSize: 22 }}>{money(s.pnl)} <span style={{ fontWeight: 600, fontSize: 16, color: "#D7D9E4" }}>practice cash</span></span>
          {rank ? <span data-testid="daily-rank" style={{ marginTop: 6, padding: "5px 12px", borderRadius: 999, background: "rgba(95,240,160,0.12)", border: "1px solid rgba(95,240,160,0.5)", fontSize: 13, color: "#BFF8D8" }}>
            Top {rank.topPct}% today · #{rank.rank.toLocaleString("en-US")} of {rank.count.toLocaleString("en-US")}</span>
            : <span data-testid="daily-rank-error" style={{ marginTop: 6, padding: "5px 12px", borderRadius: 999, border: "1px solid #2E323A", fontSize: 13, color: "#D7D9E4" }}>{error || "Saving your score…"}</span>}
        </div>

        <div style={{ marginTop: 20, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
          <Goal on={s.goals.green} label="GREEN" /><Goal on={s.goals.cash2x} label="CASH OUT 2×" /><Goal on={s.goals.orbit} label="REACH ORBIT" />
        </div>

        <div style={{ marginTop: 16, padding: "12px 14px", borderRadius: 16, background: "rgba(22,24,28,0.85)", border: "1px solid #2E323A" }}>
          <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Flight chart: ${storyLine(s, rc.dumper)}`} style={{ display: "block" }}>
            <path d={d} fill="none" stroke="#5FF0A0" strokeWidth="2" strokeLinejoin="round" />
            {rc.dumpAtS != null && <line x1={X(rc.dumpAtS)} y1={Y(at(rc.dumpAtS))} x2={X(rc.dumpAtS)} y2={Y(at(rc.dumpAtS)) - 16} stroke="#F0307F" strokeWidth="2" />}
            {s.boardedAtS != null && <circle cx={X(s.boardedAtS)} cy={Y(at(s.boardedAtS))} r="5" fill="#F2F3F7" />}
            {s.outAtS != null && <circle cx={X(s.outAtS)} cy={Y(at(s.outAtS))} r="6" fill={GOLD} />}
            <circle cx={X(s.peakAtS)} cy={Y(at(s.peakAtS))} r="5" fill="none" stroke="#FF7FB2" strokeWidth="2" />
            {ghost?.outAtS != null && <circle data-testid="daily-ghost-mark" cx={X(ghost.outAtS)} cy={Y(at(ghost.outAtS))} r="6" fill="none" stroke={GOLD} strokeWidth="2" strokeDasharray="3 2" />}
          </svg>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 12, gap: 6 }}>
            <span style={{ color: "#D7D9E4" }}><b style={{ color: "#F2F3F7", fontWeight: 600 }}>●</b> {s.boardedMcap ? `Boarded ${fmt(s.boardedMcap)}` : "Never boarded"}</span>
            <span style={{ color: "#F3DFA8" }}><b style={{ fontWeight: 600 }}>●</b> {s.outAtS != null ? `You out ${mult(s.multiple)}` : "No exit"}</span>
            <span style={{ color: "#FF9CC4" }}>○ Peak {peakX ? mult(peakX) : fmt(s.peakMcap)}</span>
          </div>
          <div data-testid="daily-story" style={{ marginTop: 4, fontSize: 12, color: "#D7D9E4" }}>{storyLine(s, rc.dumper)}</div>
          {ghost && <div data-testid="daily-ghost-line" style={{ marginTop: 4, fontSize: 12, color: "#F3DFA8" }}>{ghost.name} {ghost.outAtS != null ? `cashed out at ${mult(ghost.multiple)}, ${Math.round(ghost.outAtS)} s in` : `finished at ${mult(ghost.multiple)}`}. {s.multiple > ghost.multiple ? "You beat them." : s.multiple === ghost.multiple ? "Dead even." : "They beat you."}</div>}
        </div>

        {waiting > 0 && <div data-testid="daily-xp" style={{ marginTop: 14, minHeight: 72, boxSizing: "border-box", padding: "10px 14px", borderRadius: 16, background: "rgba(243,223,168,0.08)", border: "1px solid rgba(243,223,168,0.4)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span data-testid="daily-xp-head" style={{ ...game, fontWeight: 800, fontSize: 22, color: "#F3DFA8" }}>{xpHead}</span>
            <span data-testid="daily-xp-sub" style={{ fontSize: 12, color: "#D7D9E4" }}>{xpSub}</span>
          </span>
          {saved ? <LevelRing info={saved.level} size={44} />
            : !pilot ? <button type="button" data-testid="daily-xp-save" onClick={login} style={{ ...game, height: 44, boxSizing: "border-box", padding: "0 14px", borderRadius: 12, border: `1px solid ${GOLD}`, background: "transparent", color: GOLD, cursor: "pointer", fontWeight: 800, fontSize: 17, whiteSpace: "nowrap" }}>SAVE XP</button>
            : xp && !xp.ok ? <button type="button" data-testid="daily-xp-retry" onClick={save} style={{ ...game, height: 44, padding: "0 14px", borderRadius: 12, border: `1px solid ${GOLD}`, background: "transparent", color: GOLD, cursor: "pointer", fontWeight: 800, fontSize: 17 }}>RETRY</button> : null}
        </div>}

        <div style={{ marginTop: "auto", paddingTop: 20, display: "flex", flexDirection: "column", gap: 8 }}>
          <button type="button" data-testid="daily-challenge-friend" onClick={challenge} disabled={!verdict} style={{ ...game, height: 60, borderRadius: 16, background: GOLD, color: "#121327", border: 0, cursor: verdict ? "pointer" : "default", opacity: verdict ? 1 : 0.55, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, fontWeight: 800, fontSize: 24, letterSpacing: 1 }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#121327" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 12v7h16v-7M12 3v12M7 8l5-5 5 5" /></svg>CHALLENGE A FRIEND</button>
          {note && <span data-testid="daily-note" style={{ textAlign: "center", fontSize: 12, color: "#BFF8D8", wordBreak: "break-all" }}>{note}</span>}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
            <button type="button" data-testid="daily-again" onClick={onAgain} style={{ ...game, height: 52, borderRadius: 14, background: "rgba(18,19,39,0.78)", border: "1px solid #2E323A", color: "#F2F3F7", cursor: "pointer", fontWeight: 800, fontSize: 20, letterSpacing: 0.5 }}>FLY IT AGAIN</button>
            <button type="button" data-testid="daily-practice" onClick={onPractice} style={{ ...game, height: 52, borderRadius: 14, background: "rgba(18,19,39,0.78)", border: "1px solid rgba(255,122,61,0.55)", color: "#FFB48F", cursor: "pointer", fontWeight: 800, fontSize: 20, letterSpacing: 0.5 }}>PRACTICE {label}</button>
          </div>
          <span style={{ textAlign: "center", fontSize: 12, color: "#D7D9E4" }}>Replays are practice. Your daily score is locked in.</span>
        </div>
      </div>
    </div>
  );
}
