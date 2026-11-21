"use client";
/**
 * /streaks (main mode hook loop mockup board "Steady-hand streaks", maker 2026-11-13; retention loop 2026-11-21): the daily
 * drop strip (the check-in streak), the flight streak, the aboard streak, and the season track. Owner only (GET /api/streaks).
 * Rules sit behind the ⓘ (CLAUDE.md copy rule).
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { onWallet } from "@/lib/walletState";
import { devSample } from "@/lib/devSample";
import { DAY, DAILY_DROP, STREAK_RULES, dropCycle, type Streak } from "@/lib/streaks";
import { TRACK, TRACK_REWARDS } from "@/lib/season/track";
import { RARITY_COLOR, RARITY_NAME, crateArt } from "@/lib/collection";
import { claimDailyDrop, useStreaks, type StreaksData } from "@/lib/streaksClient";
import { untilLabel } from "@/lib/xpClient";
import { DUEL_HREF } from "@/lib/features";
import { withBase } from "@/lib/base-path";
import { haptic } from "@/lib/game/haptics";
import { playSfx } from "@/lib/game/sfx";
import Icon from "@/components/icons/Icon";
import { Flame } from "./DailyDropBar";
import s from "./streaks.module.css";

const wd = (day: number) => new Date(day * DAY).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
const wdLong = (day: number) => new Date(day * DAY).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
const days = (n: number) => `${n} ${n === 1 ? "DAY" : "DAYS"}`;
const Shield = ({ size = 16 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z" /></svg>;

function shieldLine(a: Streak) {
  if (a.pausedDay !== null) return `${wdLong(a.pausedDay)} paused by your shield.${a.shieldUsed ? " Next one Monday." : ""}`;
  return a.shieldUsed ? "Shield spent. Next one Monday." : "Shield ready";
}

function Week({ st }: { st: Streak }) {
  return (
    <div className={s.strip}>
      {st.week.map((x, i) => {
        const last = i === st.week.length - 1;
        const cls = x.state === "done" ? s.pDone : x.state === "paused" ? s.pPaused : x.state === "today" ? s.pToday : last ? s.pOpen : s.pMissed;
        return <div key={x.day} className={s.dayCol}><div className={`${s.pill} ${cls}`} title={x.state}>{x.state === "paused" && <Shield />}</div>
          <div className={`${s.dayLbl} ${x.state === "paused" ? s.lblInfo : last ? s.lblNow : ""}`}>{last ? "Today" : wd(x.day)}</div></div>;
      })}
    </div>
  );
}

function Drop({ d, wallet }: { d: StreaksData; wallet: string | null }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cyc = dropCycle(), today = d.drop.day;
  const claim = async () => {
    if (!wallet || busy) return;
    setBusy(true); setErr(null); haptic("tap", true);
    const r = await claimDailyDrop(wallet);
    setBusy(false);
    if (!r.ok) setErr(r.reason); else { haptic("celebrate"); playSfx("mission_done", { gapMs: 1000 }); }
  };
  return (
    <section className={`${s.card} ${s.cardGold}`} data-testid="streaks-drop">
      <div className={s.top}>
        <div><h2 className={`${s.eb} ${s.ebGold}`}>Daily drop</h2><div className={`${s.big} ${s.mid}`}>{days(d.checkin.current)}</div></div>
        {d.drop.claimed ? <span className={s.done}>CLAIMED</span>
          : <button type="button" className={s.claim} onClick={claim} disabled={busy || !wallet} data-testid="streaks-drop-claim">{d.drop.crate ? "CLAIM CRATE" : `CLAIM +${d.drop.xp} XP`}</button>}
      </div>
      <ol className={s.drops}>
        {cyc.map((r) => {
          const past = r.day < today || (r.day === today && d.drop.claimed);
          return (
            <li key={r.day} className={`${s.drop} ${r.day === today ? s.dropNow : ""} ${past ? s.dropPast : ""}`}>
              {r.crate
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={withBase(crateArt(DAILY_DROP.crate))} alt={`${RARITY_NAME[DAILY_DROP.crate]} crate`} className={s.dropCrate} />
                : <b>+{r.xp}</b>}
              <span>{past ? <Icon name="check" size={12} /> : `D${r.day}`}</span>
            </li>
          );
        })}
      </ol>
      {err && <p className={s.err} role="alert">{err}</p>}
    </section>
  );
}

function Track({ t }: { t: StreaksData["track"] }) {
  const pct = t.need ? (t.into / t.need) * 100 : 100;
  const now = Date.now();
  return (
    <section className={s.card} data-testid="streaks-track">
      <div className={s.top}>
        <div><h2 className={s.eb}>Season {t.season}</h2><div className={`${s.big} ${s.mid}`}>TIER {t.tier}<small>/{t.max}</small></div></div>
        <span className={s.best} suppressHydrationWarning>Ends in {untilLabel(t.endsAt, now)}</span>
      </div>
      <div className={s.bar} aria-label={`${t.into} of ${t.need} XP to tier ${t.tier + 1}`}><i style={{ width: `${pct}%` }} /></div>
      {t.need > 0 && <div className={s.barN}>{t.into.toLocaleString("en-US")} / {t.need.toLocaleString("en-US")} XP</div>}
      <ol className={s.nodes}>
        {Object.entries(TRACK_REWARDS).map(([k, rar]) => {
          const tier = Number(k), got = t.tier >= tier;
          return (
            <li key={k} className={`${s.node} ${got ? s.nodeGot : ""}`} style={{ borderColor: got ? RARITY_COLOR[rar] : undefined }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={withBase(crateArt(rar, got))} alt={`${RARITY_NAME[rar]} crate`} />
              <span>{got ? <Icon name="check" size={12} /> : tier}</span>
            </li>
          );
        })}
      </ol>
      {t.earned.length > 0 && <Link href="/market#crates" className={s.todo}>OPEN CRATES</Link>}
    </section>
  );
}

export default function StreaksView() {
  const [me, setMe] = useState<string | null | undefined>(undefined);
  const [sampleD, setSampleD] = useState<StreaksData | null>(null);
  const sample = process.env.NODE_ENV === "development" && devSample();
  useEffect(() => onWallet((a) => setMe(a ? a.toLowerCase() : null)), []);
  useEffect(() => { if (sample) import("@/lib/mock/hookLoop").then((m) => setSampleD(m.sampleStreaks())); }, [sample]);
  const { data } = useStreaks(sample ? null : me ?? null);
  const d = sample ? sampleD : data;
  const a = d?.aboard, f = d?.flight;

  return (
    <div className={s.page} data-testid="streaks">
      <header className={s.hd}>
        <h1 className={s.h1}>Streaks</h1>
        <details className={s.info}>
          <summary aria-label="How streaks work"><Icon name="info" size={20} /></summary>
          <ul>
            <li>Flight: finish one match a day. Daily, duel, royale, climb or practice.</li>
            <li>Aboard: hold ${STREAK_RULES.minHoldUsd}+ of one rocket through the UTC day.</li>
            <li>Daily drop: claim once a day. Day {DAILY_DROP.crateDay} is a crate.</li>
            <li>{STREAK_RULES.xpPerDay} XP a day per streak, +{STREAK_RULES.markXp} every {STREAK_RULES.markEvery} days.</li>
            <li>One shield a week pauses a missed day. No shield, the streak ends.</li>
            <li>Season track: XP this season fills {TRACK.tiers} tiers of {TRACK.xpPerTier} XP. Track crates don&apos;t trade.</li>
            <li>Days turn at 00:00 UTC.</li>
          </ul>
        </details>
      </header>
      {!d ? (me === null && !sample ? <p className={s.lede}>Sign in to see your streaks.</p> : <div className={s.loading} aria-busy="true" />) : <>
        <Drop d={d} wallet={me ?? null} />
        <section className={s.card} data-testid="streaks-flight">
          <div className={s.top}>
            <div><h2 className={s.eb}>Flight streak</h2><div className={s.bigRow}><Flame lit={f!.todayOk} size={40} /><span className={s.big}>{days(f!.current)}</span></div></div>
            {f!.todayOk ? <span className={s.done}>DONE TODAY</span> : <Link href={DUEL_HREF} className={s.todo}>PLAY</Link>}
          </div>
          <Week st={f!} />
          <div className={s.shield}><Shield size={20} /><div>{shieldLine(f!)}</div><span className={s.best}>Best {f!.best}</span></div>
        </section>
        <Track t={d.track} />
        <section className={s.card} data-testid="streaks-aboard">
          <div className={s.top}>
            <div><h2 className={s.eb}>Aboard streak</h2><div className={`${s.big} ${s.mid}`}>{days(a!.current)}</div></div>
            <div className={s.best}>Best {a!.best}</div>
          </div>
          <Week st={a!} />
          <div className={s.shield}><Shield size={20} /><div>{shieldLine(a!)}</div></div>
        </section>
      </>}
    </div>
  );
}
