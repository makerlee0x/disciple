"use client";
/**
 * /streaks (main mode hook loop mockup board "Steady-hand streaks", maker 2026-11-13): the aboard streak with its 7-day
 * strip and weekly shield, the check-in streak, and how streak XP pays. Owner only (GET /api/streaks).
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { onWallet } from "@/lib/walletState";
import { privyAccessToken } from "@/lib/aa/sessionState";
import { devSample } from "@/lib/devSample";
import { DAY, STREAK_RULES, type Streak } from "@/lib/streaks";
import s from "./streaks.module.css";

type Data = { aboard: Streak; checkin: Streak; paid: number };
const wd = (day: number) => new Date(day * DAY).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
const wdLong = (day: number) => new Date(day * DAY).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
const days = (n: number) => `${n} ${n === 1 ? "DAY" : "DAYS"}`;
const Shield = ({ size = 16 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z" /></svg>;

function shieldLine(a: Streak) {
  if (a.pausedDay !== null) return `${wdLong(a.pausedDay)} was paused by your weekly shield.${a.shieldUsed ? " Next shield Monday." : ""}`;
  return a.shieldUsed ? "This week's shield is spent. Next shield Monday." : "Your weekly shield is ready. It pauses one missed day.";
}

export default function StreaksView() {
  const [me, setMe] = useState<string | null | undefined>(undefined);
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const sample = process.env.NODE_ENV === "development" && devSample();
  useEffect(() => onWallet((a) => setMe(a ?? null)), []);
  useEffect(() => {
    if (sample) { import("@/lib/mock/hookLoop").then((m) => setD(m.sampleStreaks())); return; }
    if (!me) return;
    let alive = true;
    (async () => {
      const token = await privyAccessToken().catch(() => null);
      const r = await fetch(`/api/streaks?wallet=${me.toLowerCase()}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, cache: "no-store" }).catch(() => null);
      if (!alive) return;
      if (r?.ok) setD((await r.json()) as Data); else setErr(r?.status === 401 ? "Sign in to see your streaks." : "Streaks are unavailable right now.");
    })();
    return () => { alive = false; };
  }, [me, sample]);

  const a = d?.aboard, c = d?.checkin;
  return (
    <div className={s.page} data-testid="streaks">
      <h1 className={s.h1}>Streaks</h1>
      <p className={s.lede}>Streaks count showing up and staying aboard. A trade never keeps one alive.</p>
      {!d ? (me === null && !sample ? <p className={s.lede}>Sign in to see your streaks.</p> : err ? <p className={s.lede}>{err}</p> : <div className={s.loading} aria-busy="true" />) : <>
        <section className={`${s.card} ${s.cardGold}`}>
          <div className={s.top}>
            <div><div className={`${s.eb} ${s.ebGold}`}>Aboard streak</div><div className={s.big}>{days(a!.current)}</div></div>
            <div className={s.best}>Best {a!.best} {a!.best === 1 ? "day" : "days"}</div>
          </div>
          <div className={s.rule}>Hold ${STREAK_RULES.minHoldUsd} or more of any rocket through the UTC day.</div>
          <div className={s.strip}>
            {a!.week.map((x, i) => {
              const last = i === a!.week.length - 1;
              const cls = x.state === "done" ? s.pDone : x.state === "paused" ? s.pPaused : x.state === "today" ? s.pToday : last ? s.pOpen : s.pMissed;
              return <div key={x.day} className={s.dayCol}><div className={`${s.pill} ${cls}`} title={x.state}>{x.state === "paused" && <Shield />}</div>
                <div className={`${s.dayLbl} ${x.state === "paused" ? s.lblInfo : last ? s.lblNow : ""}`}>{last ? "Today" : wd(x.day)}</div></div>;
            })}
          </div>
          <div className={s.shield}><Shield size={20} /><div>{shieldLine(a!)}</div></div>
        </section>
        <section className={s.card}>
          <div className={s.top}>
            <div><div className={s.eb}>Check-in streak</div><div className={`${s.big} ${s.mid}`}>{days(c!.current)}</div></div>
            {c!.todayOk ? <span className={s.done}>DONE TODAY</span> : <Link href="/logbook" className={s.todo}>OPEN LOGBOOK</Link>}
          </div>
          <div className={s.rule}>Open your logbook or crew once a day. No trade needed.</div>
        </section>
        <section className={`${s.card} ${s.small}`}>
          <div className={s.eb}>Streak XP</div>
          <div className={s.xp}>{STREAK_RULES.xpPerDay} XP a day for each streak, up to {STREAK_RULES.xpPerDay * 2} a day. {STREAK_RULES.markEvery}-day marks add {STREAK_RULES.markXp}.</div>
        </section>
      </>}
      <div className={s.grow} />
      <p className={s.note}>A missed day with no shield left ends the streak quietly. We never warn you to trade to save it.</p>
    </div>
  );
}
