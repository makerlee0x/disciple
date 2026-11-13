/**
 * Rocket card, "Live window" (maker's pick, lobby canvas board "Rocket card concepts" C): a window onto the flight. The
 * chrome rocket climbs through its tier's sky (the same tier plates the flight uses) on its own light, with speed
 * streaks and an exhaust trail; LIVE (or IN ORBIT) and the day's climb on top; name, crew, orbit bar, altitude and
 * difficulty below. Hover shows DROP IN. Used by Climbing now and All rockets.
 */
import Link from "next/link";
import { difficultyOf } from "@/lib/difficulty";
import { ROCKET_SRC, skySrc, tierProgress, type HomeCoin } from "@/lib/home/trending";
import { withBase } from "@/lib/base-path";
import { altShort, crewFaces, flightHref, lit, Mark, orbitPct, pct } from "./rocketBits";
import s from "./liveCard.module.css";

/** `seat` (Hangar fleet): the pilot's holding in dollars, shown in place of altitude. */
export default function LiveCard({ c, testId, seat }: { c: HomeCoin; testId?: string; seat?: string }) {
  const t = tierProgress(c.mcapUsd);
  const chg = c.stats?.chg24 ?? null;
  const crew = c.stats?.crew ?? null;
  const d = difficultyOf(c.mode, c.graduated);
  const orbit = c.progressBps == null && !c.graduated ? null : orbitPct(c);
  const style = { ...lit(c), ["--sky" as string]: `url(${withBase(skySrc(t.index))})` };
  return (
    <Link href={flightHref(c)} prefetch={false} className={s.card} style={style} data-testid={testId} aria-label={`${c.name}, tier ${t.index + 1}${chg != null ? `, ${chg >= 0 ? "up" : "down"} ${pct(Math.abs(chg))} today` : ""}. Drop in`}>
      <span className={s.sky} aria-hidden />
      <span className={s.streaks} aria-hidden />
      <span className={s.glow} aria-hidden />
      <span className={s.flight} aria-hidden>
        <span className={s.trail} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={s.rocket} src={withBase(ROCKET_SRC)} alt="" loading="lazy" decoding="async" />
      </span>

      <span className={s.top}>
        <span className={s.live}><i aria-hidden />{c.graduated ? "In orbit" : "Live"}</span>
        {chg != null && <span className={chg >= 0 ? s.up : s.dn}>{chg >= 0 ? "+" : "−"}{pct(Math.abs(chg))}</span>}
      </span>

      <span className={s.foot}>
        <b className={s.name}>{c.name}</b>
        <span className={s.meta}>
          {crew ? (
            <span className={s.faces} aria-hidden>
              {crewFaces(c.token, crew).map((col, i) => <i key={i} style={{ background: col }} />)}
            </span>
          ) : <Mark c={c} className={s.mark} />}
          <span>{crew ? `${crew.toLocaleString("en-US")} aboard · ` : ""}Tier {t.index + 1}{crew ? "" : ` · ${t.title}`}</span>
        </span>
        {/* the bar's row is kept when progress is unknown so names line up across a shelf */}
        <span className={`${s.bar}${orbit == null ? " " + s.barOff : ""}`}><i style={{ width: `${orbit ?? 0}%` }} /></span>
        <span className={s.row}>
          {seat != null ? <span className={s.seat}>Your seat <b>{seat}</b></span> : <span>{altShort(c.mcapUsd)} altitude</span>}
          {d && <span className={`${s.diff} ${s[d.key]}`}>{d.label}</span>}
        </span>
      </span>
      <span className={s.drop} aria-hidden>Drop in</span>
    </Link>
  );
}
