"use client";
/**
 * Free play, built to the approved boards (Free play canvas, 2026-11-13): the hub ("Free play hub", phone + desktop), the thin
 * layer a run adds on top of the flight HUD ("Daily flight, mid-run") and the practice result.
 * Seed, minutes and speed are off the screen; they come back with the tuning panel (?tune=1 or the ` key).
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import type { DifficultyId } from "@/lib/sim/config";
import { dailyEndsAt, fmtMultiple, type DailyScore } from "@/lib/sim/daily";
import { refreshRank, savedDaily } from "@/lib/sim/dailyClient";
import { usePilotWallet } from "@/lib/xpClient";
import s from "./freePlay.module.css";

export const FP_DIFFS: { id: DifficultyId; label: string; c: string; c2?: string; n: number; desk: string; phone: string }[] = [
  { id: "pve", label: "EASY", c: "#5FF0A0", n: 1, desk: "The crew has your back. Dips get bought, bombs stay small.", phone: "The crew has your back. Dips get bought." },
  { id: "pvp", label: "HARD", c: "#FF7A3D", n: 2, desk: "Everyone plays for themselves. Your boost is someone's exit.", phone: "Everyone plays for themselves. Your boost is an exit." },
  { id: "trench", label: "EXPERT", c: "#F0307F", c2: "#FF7FB2", n: 3, desk: "Snipers, bundles and a dev who might rug. Read the tells.", phone: "Snipers, bundles, a dev who might rug." },
];
export const fpDiff = (id: DifficultyId) => FP_DIFFS.find((d) => d.id === id) ?? FP_DIFFS[0];

/* ---- local records: best practice multiple per mode, and the daily streak ---- */
const BEST_KEY = "disciple.sim.best";
export function practiceBests(): Partial<Record<DifficultyId, number>> {
  try { return JSON.parse(localStorage.getItem(BEST_KEY) || "{}"); } catch { return {}; }
}
export function savePracticeBest(id: DifficultyId, multiple: number) {
  try { const b = practiceBests(); if (multiple > (b[id] ?? 0)) { b[id] = multiple; localStorage.setItem(BEST_KEY, JSON.stringify(b)); } } catch { /* ignore */ }
}
/** days in a row with a scored daily on this device, counting today or ending yesterday */
export function dailyStreak(today: number): number {
  let d = savedDaily(today)?.verdict ? today : today - 1, n = 0;
  while (d >= 1 && savedDaily(d)?.verdict) { n++; d--; }
  return n;
}

const Flame = ({ size = 18 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden><defs><linearGradient id="fpFlame" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stopColor="#FF7A3D" /><stop offset="1" stopColor="#F2C14E" /></linearGradient></defs><path d="M12 2.5c1.2 3.6 5.5 5.4 5.5 10.6A5.5 5.5 0 0 1 6.5 13c0-3 1.8-4.4 2.2-7.2 1.9 1 3 2.6 3.1 4.6.9-1.6 1-4.6.2-7.9z" fill="url(#fpFlame)" /><path d="M12 21a2.6 2.6 0 0 1-2.6-2.6c0-1.9 1.6-2.6 2.1-4.4 1.6 1.2 3.1 2.4 3.1 4.4A2.6 2.6 0 0 1 12 21z" fill="#FFF1C9" /></svg>;

export type Board = { count: number; top: { runId: string; name: string; multiple: number }[] } | null;
/** today's board (GET /api/daily): the top 10 and how many pilots are on it */
export const fetchDailyBoard = (id: number): Promise<NonNullable<Board>> =>
  fetch(`/api/daily?id=${id}`).then((r) => (r.ok ? r.json() : null)).then((j) => (j && Array.isArray(j.top) ? { count: j.count ?? 0, top: j.top } : { count: 0, top: [] })).catch(() => ({ count: 0, top: [] }));
const untilText = (ms: number) => { const m = Math.max(0, Math.floor(ms / 60000)); return `${Math.floor(m / 60)}H ${m % 60}M`; };

export function FreePlayHub({ dailyId, msg, onDaily, tune }: {
  dailyId: number; msg: string | null; onDaily: () => void; tune?: React.ReactNode;
}) {
  const [board, setBoard] = useState<Board>(null);
  const [streak, setStreak] = useState(0);
  const [mine, setMine] = useState<{ multiple: number; rank: number; boarded: boolean } | null>(null);
  const wallet = usePilotWallet();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setStreak(dailyStreak(dailyId));
    const v = savedDaily(dailyId)?.verdict;
    if (v) { setMine({ multiple: v.score.multiple, rank: v.rank, boarded: !!v.boarded });
      // the rank moves as more pilots finish, and a run is boarded once its pilot saves it: read both fresh
      void refreshRank(dailyId, v.runId).then((r) => { if (r) setMine({ multiple: v.score.multiple, rank: r.rank, boarded: r.boarded }); }); }
    const load = () => fetchDailyBoard(dailyId).then(setBoard);
    load();
    let n = 0; const iv = setInterval(() => { setNow(Date.now()); if (++n % 4 === 0 && !document.hidden) load(); }, 30_000); return () => clearInterval(iv);   // board every 2 min, only while visible (KV request budget)
  }, [dailyId]);
  // the old-design sweep hides the app chrome (sidebar, wallet pills) while Free play's own screens are up
  useEffect(() => { document.body.classList.add("fp-hub"); return () => document.body.classList.remove("fp-hub"); }, []);
  const best = board?.top[0];
  const pilots = board && board.count > 0 ? `${board.count.toLocaleString("en-US")} pilot${board.count === 1 ? "" : "s"}` : "";

  return (
    <div className={s.hub} data-testid="sim-select">
      <div className={s.wrap}>
        <div className={s.head}>
          <Link href="/" className={s.back} aria-label="Back to the lobby"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F2F3F7" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 5l-7 7 7 7" /></svg><span className={s.backT}>BACK</span></Link>
          <div className={s.titleBox}><h1 className={s.title}>DAILY MISSION</h1></div>
          {streak > 0 ? <span className={s.streak} data-testid="fp-streak" aria-label={`${streak}-day streak`}><span className={s.streakIcon}><Flame size={16} /></span><b className={s.streakN}>{streak}</b><span className={s.streakL}>DAY<br />STREAK</span></span> : <span style={{ width: 44 }} aria-hidden />}
        </div>

        <div className={s.top}>
          <section className={s.daily} aria-label={`Daily flight #${dailyId}`}>
            <div className={s.dailyArt} aria-hidden />
            <div className={s.dailyShade} aria-hidden />
            <div className={s.dailyBody}>
              <div className={s.tags}><span className={s.tag}>#{dailyId}</span><span className={s.tag}>FREE PLAY</span><span className={s.tag}>NEW IN {untilText(dailyEndsAt(dailyId) - now)}</span></div>
              <div>
                <div className={s.dailyH}>Same sky.<br />Everyone apes it.</div>
              </div>
              <div className={s.phoneMeta}><span>{best ? <>Best today <b style={{ color: "#5FF0A0", fontWeight: 600 }}>{fmtMultiple(best.multiple)}</b> by {best.name}</> : "No runs yet"}</span><span>{pilots}</span></div>
              <div className={s.ctaRow}>
                <button type="button" className={s.cta} data-testid="sim-daily" onClick={onDaily}>{mine ? "SEE YOUR RESULT" : "FLY TODAY'S FLIGHT"}</button>
              </div>
              {msg && <span className={s.msg} data-testid="sim-daily-msg">{msg}</span>}
            </div>
          </section>

          <aside className={s.board} aria-label="Today's board">
            <div className={s.boardHead}><span className={s.boardT}>TODAY&apos;S BOARD</span><span className={s.meta}>{pilots || `Daily #${dailyId}`}</span></div>
            {board && board.top.length ? board.top.slice(0, 5).map((r, i) => (
              <div key={r.runId} className={s.row}><span><b className={`${s.rank} ${i === 0 ? s.rank1 : ""}`}>{i + 1}</b>{r.name}</span><span className={s.mult}>{fmtMultiple(r.multiple)}</span></div>
            )) : <div className={s.empty}>{board ? "No runs yet" : <span className={s.skel} role="status" aria-label="Loading the board" />}</div>}
            <div className={s.rule} />
            <div className={s.row} style={{ color: "#D7D9E4" }}><span>{mine ? `You · #${mine.rank}` : "You · not flown yet"}</span><span className={s.mult} style={{ color: mine ? "#5FF0A0" : "#D7D9E4" }}>{mine ? fmtMultiple(mine.multiple) : "–"}</span></div>
            {!(wallet || mine?.boarded) && <span className={s.boardNote}>Sign in to make the board.</span>}
          </aside>
        </div>

        {tune}
      </div>
    </div>
  );
}

const Check = ({ on, size = 15 }: { on: boolean; size?: number }) => on
  ? <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden><circle cx="12" cy="12" r="10" fill="#F2C14E" /><path d="M7.5 12.5l3 3 6-6.5" stroke="#121327" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
  : <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#F2C14E" strokeWidth="1.8" aria-hidden><circle cx="12" cy="12" r="9.5" /></svg>;
const GOALS: { k: keyof DailyScore["goals"]; label: string }[] = [{ k: "green", label: "FINISH GREEN" }, { k: "cash2x", label: "CASH OUT 2×" }, { k: "orbit", label: "REACH ORBIT" }];

export type StripAlert = { text: string; good?: boolean } | null;
/** the run layer: mode, time left and the three goals; one alert line for a tell or a big moment */
export function FreePlayStrip({ mode, left, difficulty, goals, alert, phone, tune }: {
  mode: string; left: string; difficulty: DifficultyId; goals: DailyScore["goals"]; alert: StripAlert; phone: boolean; tune?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const d = fpDiff(difficulty), done = GOALS.filter((g) => goals[g.k]).length;
  const dots = GOALS.map((g) => !!goals[g.k]).join(",");
  // phones (maker 2026-11-14: "put the timer by the market cap"): the phone HUD shows mode · clock · goal dots in its top
  // row from disciple:simclock and taps back with disciple:simgoals to open this panel; the chip stays as a fallback.
  useEffect(() => {
    if (!phone) return;
    dispatchEvent(new CustomEvent("disciple:simclock", { detail: { mode, left, dots: dots.split(",").map((x) => x === "true") } }));
  }, [phone, mode, left, dots]);
  useEffect(() => {
    if (!phone) return;
    const f = () => setOpen((o) => !o);
    addEventListener("disciple:simgoals", f);
    return () => { removeEventListener("disciple:simgoals", f); dispatchEvent(new CustomEvent("disciple:simclock", { detail: null })); };
  }, [phone]);
  if (phone && !open) return (
    <button type="button" className={s.chip} data-testid="sim-chip" aria-expanded={false} aria-label={`${mode}, ${left} left, ${done} of 3 goals. Show goals`} onClick={() => setOpen(true)}>
      <span style={{ color: "#F3DFA8" }}>{mode}</span><span>{left}</span><span className={s.chipDots} aria-hidden>{GOALS.map((g) => <i key={g.k} className={goals[g.k] ? "on" : ""} />)}</span>
    </button>
  );
  return (
    <div className={s.strip} data-testid="sim-bar" role="status" aria-label={`${mode}, ${left} left`}>
      <div className={s.stripHead}>
        <span className={s.stripMode}>{mode}</span><span className={s.stripClock}>{left}</span>
        {!mode.startsWith("DAILY") && <span className={s.stripDiff} style={{ "--c": d.c } as React.CSSProperties}><i />{d.label}</span>}
        {phone && <button type="button" className={s.stripFold} data-testid="sim-chip-close" aria-label="Fold the goals" onClick={() => setOpen(false)}>▴</button>}
      </div>
      <div className={s.goals}>{GOALS.map((g) => <span key={g.k} className={`${s.goal} ${goals[g.k] ? s.goalOn : ""}`}><Check on={goals[g.k]} />{g.label}</span>)}</div>
      {alert && <div className={`${s.alert} ${alert.good ? s.alertGood : ""}`} data-testid="sim-alert">{alert.text}</div>}
      {tune && <div className={s.stripTune}>{tune}</div>}
    </div>
  );
}

const money = (v: number) => (v < 0 ? "−$" : "+$") + Math.abs(v).toFixed(2);
/** practice run result: the multiple leads, then money, rank and the goals; fly the same market again in one tap */
export function PracticeResult({ difficulty, score, rank, of, xp, onAgain, onNew, onHub, extra }: {
  difficulty: DifficultyId; score: DailyScore; rank: number; of: number; xp: string; onAgain: () => void; onNew: () => void; onHub: () => void; extra?: React.ReactNode;
}) {
  const d = fpDiff(difficulty), boarded = score.invested > 0;
  return (
    <div className={s.result} data-testid="sim-summary">
      <div className={s.card} role="dialog" aria-label="Practice result">
        <div className={s.resHead}><span>PRACTICE · RESULT</span><span className={s.stripDiff} style={{ "--c": d.c, color: "#F2F3F7" } as React.CSSProperties}><i />{d.label}</span></div>
        <div>
          <div className={s.big} style={{ color: !boarded ? "#D7D9E4" : score.pnl >= 0 ? "#5FF0A0" : "#FF7FB2" }}>{boarded ? fmtMultiple(score.multiple) : "0×"}</div>
          <div style={{ fontSize: 14, color: "#D7D9E4", marginTop: 6 }}>{boarded ? (score.pnl >= 0 ? "You cashed out ahead." : "The market got you this time.") : "You never boarded. Tap BOOST to get on."}</div>
        </div>
        <div className={s.resStats}>
          <div className={s.stat}><span>Cash</span><b style={{ color: score.pnl >= 0 ? "#5FF0A0" : "#FF7FB2" }}>{money(score.pnl)}</b></div>
          <div className={s.stat}><span>Rank</span><b>#{rank} <small style={{ font: "500 12px var(--dsc-font-ui)", color: "#D7D9E4" }}>of {of}</small></b></div>
          <div className={s.stat}><span>Peak</span><b>${score.peakMcap >= 1000 ? `${(score.peakMcap / 1000).toFixed(1)}K` : score.peakMcap}</b></div>
        </div>
        <div className={s.resGoals}>{GOALS.map((g) => <div key={g.k} className={`${s.resGoal} ${score.goals[g.k] ? s.resGoalOn : ""}`} data-testid={`daily-goal-${score.goals[g.k] ? "on" : "off"}`}><Check on={score.goals[g.k]} size={20} />{g.label}</div>)}</div>
        <div className={s.xp} data-testid="sim-xp">{xp}</div>
        <div className={s.resBtns}>
          <button type="button" className={s.cta} data-testid="sim-again" onClick={onAgain}>FLY IT AGAIN</button>
          <div className={s.resRow}><button type="button" className={s.sec} onClick={onNew}>NEW MARKET</button><button type="button" className={s.sec} onClick={onHub}>FREE PLAY</button></div>
        </div>
        {extra}
      </div>
    </div>
  );
}
