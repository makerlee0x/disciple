"use client";
/**
 * Free play, built to the approved boards (Free play canvas, 2026-11-13): the hub ("Free play hub", phone + desktop), the thin
 * layer a run adds on top of the flight HUD ("Daily flight, mid-run") and the practice result.
 * Seed, minutes and speed are off the screen; they come back with the tuning panel (?tune=1 or the ` key).
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import type { DifficultyId } from "@/lib/sim/config";
import { DAILY, dailyEndsAt, fmtMultiple, type DailyScore } from "@/lib/sim/daily";
import { savedDaily } from "@/lib/sim/dailyClient";
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

function Chevrons({ n, c, size }: { n: number; c: string; size: number }) {
  return (
    <span className={s.chev} role="img" aria-label={`Difficulty ${n} of 3`}>
      {[0, 1, 2].map((i) => <svg key={i} width={size} height={size} viewBox="0 0 24 24" aria-hidden><path d="M5 15l7-7 7 7" fill="none" stroke={i < n ? c : "rgba(215,217,228,0.28)"} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>)}
    </span>
  );
}
const Flame = ({ size = 18 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#F2C14E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-3 2-4 2-7 2 1 3 2 3 4" /></svg>;

type Board = { count: number; top: { runId: string; name: string; multiple: number }[] } | null;
const untilText = (ms: number) => { const m = Math.max(0, Math.floor(ms / 60000)); return `${Math.floor(m / 60)}H ${m % 60}M`; };

export function FreePlayHub({ dailyId, msg, onDaily, onPractice, tune }: {
  dailyId: number; msg: string | null; onDaily: () => void; onPractice: (id: DifficultyId) => void; tune?: React.ReactNode;
}) {
  const [board, setBoard] = useState<Board>(null);
  const [bests, setBests] = useState<Partial<Record<DifficultyId, number>>>({});
  const [streak, setStreak] = useState(0);
  const [mine, setMine] = useState<{ multiple: number; rank: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setBests(practiceBests()); setStreak(dailyStreak(dailyId));
    const v = savedDaily(dailyId)?.verdict; if (v) setMine({ multiple: v.score.multiple, rank: v.rank });
    fetch(`/api/daily?id=${dailyId}`).then((r) => (r.ok ? r.json() : null)).then((j) => setBoard(j && Array.isArray(j.top) ? { count: j.count ?? 0, top: j.top } : { count: 0, top: [] })).catch(() => setBoard({ count: 0, top: [] }));
    const iv = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(iv);
  }, [dailyId]);
  const best = board?.top[0];
  const diff = fpDiff(DAILY.difficulty);
  const pilots = board && board.count > 0 ? `${board.count.toLocaleString("en-US")} pilot${board.count === 1 ? "" : "s"}` : "";

  return (
    <div className={s.hub} data-testid="sim-select">
      <div className={s.wrap}>
        <div className={s.head}>
          <Link href="/" className={s.back} aria-label="Back to the lobby"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F2F3F7" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 5l-7 7 7 7" /></svg></Link>
          <div className={s.titleBox}><h1 className={s.title}>FREE PLAY</h1><span className={s.sub}>Practice cash. Real market rules.</span></div>
          {streak > 0 ? <span className={s.streak} data-testid="fp-streak"><Flame />{streak}-day streak</span> : <span style={{ width: 44 }} aria-hidden />}
        </div>

        <div className={s.top}>
          <section className={s.daily} aria-label={`Daily flight #${dailyId}`}>
            <div className={s.dailyArt} aria-hidden />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={s.dailyRocket} src="/assets/rocket-hi.webp" alt="" aria-hidden />
            <div className={s.dailyShade} aria-hidden />
            <div className={s.dailyBody}>
              <div className={s.tags}><span className={`${s.tag} ${s.tagHard}`} style={{ borderColor: diff.c }}>{diff.label}</span><span className={s.tag}>NEW FLIGHT IN {untilText(dailyEndsAt(dailyId) - now)}</span></div>
              <div>
                <span className={s.kicker}>DAILY FLIGHT #{dailyId}</span>
                <div className={s.dailyH}>One market.<br />Everyone flies it.</div>
                <p className={s.dailyP}>{mine ? `You cashed out at ${fmtMultiple(mine.multiple)} today. A new market lands at midnight UTC.` : "One scored run a day. Cash out higher than the rest of the field."}</p>
              </div>
              <div className={s.phoneMeta}><span>{best ? <>Best today <b style={{ color: "#5FF0A0", fontWeight: 600 }}>{fmtMultiple(best.multiple)}</b> by {best.name}</> : "No one has flown it yet"}</span><span>{pilots}</span></div>
              <div className={s.ctaRow}>
                <button type="button" className={s.cta} data-testid="sim-daily" onClick={onDaily}>{mine ? "SEE YOUR RESULT" : "FLY TODAY'S FLIGHT"}</button>
                {pilots && <span className={`${s.meta} ${s.desk}`}>{pilots} so far</span>}
              </div>
              {msg && <span className={s.msg} data-testid="sim-daily-msg">{msg}</span>}
            </div>
          </section>

          <aside className={s.board} aria-label="Today's board">
            <div className={s.boardHead}><span className={s.boardT}>TODAY&apos;S BOARD</span></div>
            {board && board.top.length ? board.top.slice(0, 5).map((r, i) => (
              <div key={r.runId} className={s.row}><span><b className={`${s.rank} ${i === 0 ? s.rank1 : ""}`}>{i + 1}</b>{r.name}</span><span className={s.mult}>{fmtMultiple(r.multiple)}</span></div>
            )) : <div className={s.empty}>{board ? "No one is on the board yet. Fly first and take the top spot." : "Loading the board…"}</div>}
            <div className={s.rule} />
            <div className={s.row} style={{ color: "#D7D9E4" }}><span>{mine ? `You · #${mine.rank}` : "You haven't flown today"}</span><span className={s.mult} style={{ color: mine ? "#5FF0A0" : "#D7D9E4" }}>{mine ? fmtMultiple(mine.multiple) : "–"}</span></div>
          </aside>
        </div>

        <section aria-label="Practice">
          <div className={s.practiceHead}><span className={s.secT}>PRACTICE</span><span className={s.meta}>Unlimited runs · harder as you go</span></div>
          <div className={s.tiles}>
            {FP_DIFFS.map((d) => { const b = bests[d.id]; return (
              <button key={d.id} type="button" data-testid={`sim-diff-${d.id}`} className={`${s.tile} ${b == null ? s.tileNew : ""}`} style={{ "--c": d.c, "--c2": d.c2 ?? d.c } as React.CSSProperties}
                onClick={() => onPractice(d.id)} aria-label={`Practice ${d.label.toLowerCase()}${b == null ? ", not flown yet" : `, best ${fmtMultiple(b)}`}`}>
                <span className={s.tileTop}><span className={s.tileName}>{d.label}</span><Chevrons n={d.n} c={d.c2 ?? d.c} size={22} /></span>
                <span className={s.tileP}><span className={s.tDesk}>{d.desk}</span><span className={s.tPhone}>{d.phone}</span></span>
                <span className={s.tileChevPhone}><Chevrons n={d.n} c={d.c2 ?? d.c} size={18} /></span>
                <span className={s.tileBest} style={b == null ? { color: d.c2 ?? d.c } : undefined}>{b == null ? "Ready to try" : `Best ${fmtMultiple(b)}`}</span>
              </button>); })}
          </div>
        </section>
        {tune}
        <div className={s.foot}>Practice cash only. Nothing here touches a wallet.</div>
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
        <span className={s.stripDiff} style={{ "--c": d.c } as React.CSSProperties}><i />{d.label}</span>
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
