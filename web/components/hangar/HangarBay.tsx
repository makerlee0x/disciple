"use client";
/**
 * The Hangar banner, take A · Cockpit (canvas board "Hangar banner: three cinematic takes", picked by maker 2026-11-14).
 * The pilot looks out of the cockpit from the X header: stars, the moon, Earth's edge, gold-lit gauges. No rocket here; the
 * rocket you fly lives under "Your rocket". The name sits over the stars like a title card; up to three stats glow on the dash.
 */
import type { ReactNode } from "react";
import { withBase } from "@/lib/base-path";
import { MAX_LEVEL, type XpSummary } from "@/lib/xp";
import type { Loadout } from "./hangarData";
import s from "./hangarBay.module.css";

const fmt = (n: number) => n.toLocaleString("en-US");
export type DashStat = { k: string; v: string };

export default function HangarBay({ handle, bio, avatar, xp, actions, spend, eyebrow, lines, stats }: {
  handle: string; bio: ReactNode; avatar: ReactNode; xp: XpSummary | null; actions?: ReactNode; spend: boolean;
  /** kept for callers; the cockpit banner shows no rocket */
  loadout?: Loadout;
  /** signed-out Hangar: its own eyebrow and title lines in place of the pilot's */
  eyebrow?: ReactNode; lines?: string[];
  /** the gauges on the dash (at most three) */
  stats?: DashStat[];
}) {
  const L = xp?.level;
  const words = lines ?? handle.replace(/^@/, "").split(/\s+/);
  return (
    <section className={s.bay} data-testid="profile-identity">
      <picture className={s.art}>
        <source media="(max-width: 760px)" srcSet={withBase("/hangar/cockpit-phone.webp")} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={withBase("/hangar/cockpit-2400.webp")} srcSet={`${withBase("/hangar/cockpit-1200.webp")} 1200w, ${withBase("/hangar/cockpit-2400.webp")} 2400w`}
          sizes="(max-width: 1280px) 100vw, 1280px" alt="" aria-hidden fetchPriority="high" />
      </picture>
      <span className={s.scrim} aria-hidden />

      <div className={s.card}>
        <div>
          <div className={s.eyebrow}>
            {eyebrow ?? <><span className={s.av}>{avatar}</span>
            <span>{L ? `Pilot · Level ${L.level} · ${L.prestige ? `Prestige ${L.prestige} · ` : ""}${L.prestigeName}` : "Pilot"}</span></>}
          </div>
          <h1 className={s.name}>
            {words.length > 1 ? words.map((w, i) => <span key={i}>{w}</span>) : <span>{handle}</span>}
          </h1>
          {bio && <div className={s.bio}>{bio}</div>}
          {L && (
            <div className={s.level}>
              <span className={s.lbar} role="progressbar" aria-label="Level progress" aria-valuemin={0} aria-valuemax={L.need || 1} aria-valuenow={L.into}>
                <i style={{ width: `${Math.round(L.progress * 100)}%` }} />
              </span>
              <span className={s.lnext}>{L.level >= MAX_LEVEL ? "Max level" : `${fmt(L.need - L.into)} XP to level ${L.level + 1}`}</span>
            </div>
          )}
        </div>
        {actions && <div className={s.actions}>{actions}</div>}
      </div>

      {stats && stats.length > 0 && (
        <dl className={s.dash} data-testid="hangar-dash">
          {stats.slice(0, 3).map((x) => <div key={x.k}><dt>{x.k}</dt><dd>{x.v}</dd></div>)}
        </dl>
      )}
      {xp && spend && (
        <div className={s.spend}>
          <span>XP to spend</span>
          <b>{fmt(xp.spendableXp)}</b>
        </div>
      )}
    </section>
  );
}
