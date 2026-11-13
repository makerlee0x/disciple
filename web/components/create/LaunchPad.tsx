/**
 * The launch builder's pad stage (canvas board "Launch: build your rocket", left): the rocket on the mount ring with the
 * badge on its hull, engines warm, and the nameplate that follows what the host types and picks.
 */
import { withBase } from "@/lib/base-path";
import { ROCKET_SRC } from "@/lib/home/trending";
import s from "./launch.module.css";

export default function LaunchPad({ name, ticker, icon, mode, modeColor, seat }: {
  name: string; ticker: string; icon: string | null; mode: string; modeColor: string; seat: string;
}) {
  return (
    <section className={s.stage} aria-label="Your rocket on the pad" data-testid="create-pad-preview" style={{ ["--mc" as string]: modeColor }}>
      <div className={s.sky} aria-hidden />
      <div className={s.tint} aria-hidden />
      <div className={s.halo} aria-hidden />
      <div className={s.horizon} aria-hidden />
      <div className={s.padGlow} aria-hidden />
      <div className={s.rocket} aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={withBase(ROCKET_SRC)} alt="" />
        <span className={s.badge}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {icon && <img src={icon} alt="" />}
        </span>
        <span className={s.pilotLight} />
      </div>
      <span className={`${s.smoke} ${s.smokeA}`} aria-hidden />
      <span className={`${s.smoke} ${s.smokeB}`} aria-hidden />
      <div className={s.vignette} aria-hidden />
      <span className={`${s.bar} ${s.barT}`} aria-hidden />
      <span className={`${s.bar} ${s.barB}`} aria-hidden />
      <div className={s.stageTop}>
        <div className={s.stageTitle}>
          <span className={s.eb}>Host a match</span>
          <h1>Launch<br />a rocket</h1>
        </div>
        <span className={s.modeTag} data-testid="pad-mode">● {mode}</span>
      </div>
      <div className={s.plate}>
        <div className={s.plateName}>
          <b data-testid="pad-name">{name.trim() || "Your rocket"}</b>
          <span>{ticker ? `$${ticker}` : "$TICKER"} · On the pad · Ready for lift-off</span>
        </div>
        <div className={s.seatCard}><span>Your seat at launch</span><b data-testid="pad-seat">{seat}</b></div>
      </div>
    </section>
  );
}
