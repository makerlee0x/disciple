"use client";
/**
 * The bay (Hangar take A · Cinematic, canvas board "The bay: three takes"): a letterboxed, low-camera frame. The pilot's
 * name sits on the left like a title card (eyebrow, call sign, bio, level bar, actions); their Rocket Factory rocket
 * stands on a gold-rimmed plinth on the right in a cold backlight, with steam off the pad and its reflection in the deck.
 * No parts caption: the rocket shows what it's wearing. The rocket is HangarRocket (the real loadout, factory-lit);
 * generated per-skin plates (prompt pack "Hangar rocket art") replace the drawn pad once they exist.
 */
import type { ReactNode } from "react";
import HangarRocket from "@/components/factory/HangarRocket";
import { withBase } from "@/lib/base-path";
import { MAX_LEVEL, type XpSummary } from "@/lib/xp";
import type { Loadout } from "./hangarData";
import s from "./hangarBay.module.css";

const fmt = (n: number) => n.toLocaleString("en-US");

export default function HangarBay({ handle, bio, avatar, xp, loadout, actions, spend, eyebrow, lines }: {
  handle: string; bio: ReactNode; avatar: ReactNode; xp: XpSummary | null; loadout: Loadout; actions?: ReactNode; spend: boolean;
  /** signed-out Hangar: its own eyebrow and title lines in place of the pilot's */
  eyebrow?: ReactNode; lines?: string[];
}) {
  const L = xp?.level;
  const words = lines ?? handle.replace(/^@/, "").split(/\s+/);
  return (
    <section className={s.bay} style={{ ["--plate" as string]: `url(${withBase("/hangar/plate-1280.webp")})`, ["--flame" as string]: loadout.flame }} data-testid="profile-identity">
      <div className={s.stage} aria-hidden>
        <span className={s.plate} />
        <span className={s.grade} />
        <span className={s.back} />
        <span className={s.streak} />
        <span className={s.deck} />
        <span className={s.pool} />
        <span className={s.padWall} />
        <span className={s.padTop} />
        <span className={s.ship}>
          <HangarRocket skin={loadout.skin} coin={loadout.coin} flame={loadout.flame} className={s.rocket} reflClassName={s.refl} />
          <span className={s.bells} />
        </span>
        <span className={s.steam}><i /><i /><i /></span>
        <span className={s.vignette} />
      </div>
      <span className={`${s.bar} ${s.barTop}`} aria-hidden />
      <span className={`${s.bar} ${s.barBot}`} aria-hidden />

      <div className={s.card}>
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
            <span className={s.lnext}>{L.level >= MAX_LEVEL ? "Max level" : `${fmt(L.need - L.into)} XP to ${L.level + 1}`}</span>
          </div>
        )}
        {actions && <div className={s.actions}>{actions}</div>}
      </div>

      {xp && spend && (
        <div className={s.spend}>
          <span>XP to spend</span>
          <b>{fmt(xp.spendableXp)}</b>
        </div>
      )}
    </section>
  );
}
