"use client";
/**
 * Daily flight pre-flight screen (maker 2026-11-16: "it started immediately without a countdown like we added in duel").
 * Built like the Trading Duel's pre-match lobby: its own full screen, BACK / title / timer on top, what today's flight is,
 * today's board (the top 10 signed-in pilots), the controls, then LAUNCH, which asks for the start ticket and counts
 * 3 · 2 · 1 · GO before the market starts. There is no difficulty: one market, the same for everyone.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { dailyEndsAt, fmtMultiple } from "@/lib/sim/daily";
import { usePilotWallet } from "@/lib/xpClient";
import { fetchDailyBoard, type Board } from "./FreePlay";
import s from "./preflight.module.css";

const untilText = (ms: number) => { const m = Math.max(0, Math.floor(ms / 60000)); return `${Math.floor(m / 60)}h ${m % 60}m`; };
const beep = (hi: boolean) => {
  try {
    const A = (window as unknown as { __fpAudio?: AudioContext }), ac = A.__fpAudio ?? (A.__fpAudio = new AudioContext());
    const o = ac.createOscillator(), g = ac.createGain(); o.type = "square"; o.frequency.value = hi ? 880 : 520;
    g.gain.setValueAtTime(0.06, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + (hi ? 0.45 : 0.18));
    o.connect(g).connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.5);
  } catch { /* no audio */ }
};

/** a 3 · 2 · 1 · GO count over whatever is on screen; calls onGo at GO. Shared by the daily and practice. */
export function useCountdown(onGo: () => void) {
  const [n, setN] = useState<number | null>(null);
  const go = useRef(onGo); go.current = onGo;
  const t = useRef<number[]>([]);
  useEffect(() => () => t.current.forEach(clearTimeout), []);
  const run = useCallback(() => {
    t.current.forEach(clearTimeout); t.current = [];
    [3, 2, 1, 0].forEach((k, i) => t.current.push(window.setTimeout(() => { setN(k); beep(k === 0); try { navigator.vibrate?.(k === 0 ? 40 : 12); } catch { /* ignore */ } }, i * 800)));
    t.current.push(window.setTimeout(() => go.current(), 3 * 800 + 350));
    t.current.push(window.setTimeout(() => setN(null), 3 * 800 + 700));
  }, []);
  const cancel = useCallback(() => { t.current.forEach(clearTimeout); t.current = []; setN(null); }, []);
  return { n, run, cancel };
}
export function CountOverlay({ n }: { n: number | null }) {
  if (n == null) return null;
  return <div className={s.count} data-testid="fp-countdown" role="status" aria-live="assertive"><b key={n} className={n === 0 ? s.countGo : undefined}>{n === 0 ? "GO" : n}</b></div>;
}

export default function DailyPreflight({ dailyId, msg, onBack, onLaunch, onGo }: {
  dailyId: number; msg: string | null; onBack: () => void;
  /** GO: start the market */
  onGo: () => void;
  /** get the start ticket; resolves true when the run can start (the countdown then runs), false on an error or a run already flown */
  onLaunch: () => Promise<boolean>;
}) {
  const [board, setBoard] = useState<Board>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [counting, setCounting] = useState(false);
  const pilot = usePilotWallet();
  const cd = useCountdown(onGo);
  useEffect(() => {
    const load = () => fetchDailyBoard(dailyId).then(setBoard); load();
    const iv = setInterval(() => { setNow(Date.now()); load(); }, 20_000); return () => clearInterval(iv);
  }, [dailyId]);
  useEffect(() => { document.body.classList.add("fp-hub"); return () => document.body.classList.remove("fp-hub"); }, []);
  const launch = async () => {
    if (busy || counting) return; setBusy(true);
    const ok = await onLaunch(); setBusy(false);
    if (ok) { setCounting(true); cd.run(); }
  };
  const pilots = board && board.count > 0 ? `${board.count.toLocaleString("en-US")} pilot${board.count === 1 ? "" : "s"} today` : "No one on the board yet";

  return (
    <div className={s.pre} data-testid="daily-pre">
      <div className={s.bg} aria-hidden />
      <header className={s.top}>
        <button type="button" className={s.back} onClick={() => { cd.cancel(); onBack(); }} disabled={counting} aria-label="Back to Free play">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 5l-7 7 7 7" /></svg>BACK
        </button>
        <div className={s.title}>DAILY FLIGHT #{dailyId}</div>
        <span className={s.chip}>New in {untilText(dailyEndsAt(dailyId) - now)}</span>
      </header>

      <div className={s.hero}>
        <h1 className={s.h}>One market.<br />Everyone flies it.</h1>
        <p className={s.p}>Same coin, same bots, same chart for every pilot today. Board the rocket, ride it up, cash out before the dump. Your best cash-out multiple goes on the board.</p>
        <div className={s.facts}>
          <span><b>2:00</b>flight</span><span><b>$250</b>practice cash</span><span><b>1</b>scored run</span>
        </div>
      </div>

      <div className={s.cols}>
        <section className={s.board} aria-label="Today's board" data-testid="daily-pre-board">
          <div className={s.bHead}><span className={s.bT}>TODAY&apos;S BOARD</span><span className={s.bMeta}>{pilots}</span></div>
          {board && board.top.length ? board.top.map((r, i) => (
            <div key={r.runId} className={s.row}><span><b className={`${s.rank} ${i === 0 ? s.rank1 : ""}`}>{i + 1}</b>{r.name}</span><span className={s.mult}>{fmtMultiple(r.multiple)}</span></div>
          )) : <div className={s.empty}>{board ? "Nobody has posted a score yet. Fly first and take #1." : "Loading the board…"}</div>}
          <span className={s.note}>{pilot ? "You're signed in, so your score goes on the board." : "Only signed-in pilots go on the board. You can sign in after you land."}</span>
        </section>
        <section className={s.ctl} aria-label="Controls">
          <span className={s.bT}>HOW TO FLY</span>
          <div className={s.keys}>
            <div><kbd>SPACE</kbd><span>Boost (buy in)</span></div>
            <div><kbd>SHIFT</kbd><span>Dump (cash out)</span></div>
            <div><kbd>W</kbd><kbd>S</kbd><span>Fly up and down</span></div>
            <div><kbd>A</kbd><kbd>D</kbd><span>Steer left and right</span></div>
          </div>
          <div className={s.touch}>Drag the sky to fly anywhere. BOOST and DUMP are at the bottom.</div>
        </section>
      </div>

      <div className={s.foot}>
        {msg && <p className={s.err} role="status" data-testid="daily-pre-msg">{msg}</p>}
        <button type="button" className={s.go} data-testid="daily-launch" onClick={launch} disabled={busy || counting}>{busy ? "GETTING TODAY'S MARKET…" : counting ? "LAUNCHING" : "LAUNCH"}</button>
        <span className={s.fine}>Practice cash only. Replays after your scored run don&apos;t count.</span>
      </div>
      <CountOverlay n={cd.n} />
    </div>
  );
}
