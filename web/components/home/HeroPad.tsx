/**
 * Trending-hero rocket ON the launch pad (brings back the #79 rooftop pad: deck + gantry, warm pad lamps, deck
 * reflection, the idle venting cloud plume), composited in the foreground over the coin's tier sky with a low cloud bank
 * so the pad reads as standing above the clouds. `launching` plays the lift-off (ignition flare, exhaust, billowing
 * smoke, rocket rising out of frame) — all CSS transform/opacity, no canvas, no video. Grain stays on the sky only.
 *
 * Geometry is in #79 plate pixels × --s (the pad asset is the deck cut from the approved plate master; the rocket stands
 * at its baked base point), so the rocket always sits planted on the deck at any size.
 */
import { withBase } from "@/lib/base-path";
import { ROCKET_SRC } from "@/lib/home/trending";
import s from "./heroPad.module.css";

export const PAD_SRC = "/home/pad/pad.webp";
const PAD_SM_SRC = "/home/pad/pad-sm.webp";
const FOG_SRC = "/hero/fog.webp"; // #79 haze sheet

/** Lift-off length (ms): navigation fires when the rocket has cleared the frame. Mirrors --liftoff-ms in the CSS. */
export const LIFTOFF_MS = 1300;

export default function HeroPad({ go, launching }: { go: boolean; launching: boolean }) {
  const fog = { backgroundImage: `url(${withBase(FOG_SRC)})` };
  const rocket = withBase(ROCKET_SRC);
  return (
    <div className={`${s.pad}${go ? " " + s.go : ""}${launching ? " " + s.launching : ""}`} aria-hidden>
      <div className={`${s.fog} ${s.fogBack}`} style={fog} />
      <div className={s.scene}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={s.deck} src={withBase(PAD_SRC)} srcSet={`${withBase(PAD_SM_SRC)} 535w, ${withBase(PAD_SRC)} 1070w`}
          sizes="(max-width: 760px) 360px, 600px" width={1070} height={366} alt="" decoding="async" draggable={false} />
        <span className={s.lamp} style={{ ["--lx" as string]: 963, ["--ly" as string]: 194 }} />
        <span className={s.lamp} style={{ ["--lx" as string]: 674, ["--ly" as string]: 220 }} />
        <span className={s.lamp} style={{ ["--lx" as string]: 105, ["--ly" as string]: 220 }} />
        <div className={s.deckGlow} />
        <div className={s.pool} />
        <div className={s.refl}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={rocket} alt="" width={221} height={609} decoding="async" draggable={false} />
        </div>
        <div className={s.lift}>
          <div className={s.flame}><i /><i /></div>
          <div className={s.body}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={s.rocketImg} src={rocket} alt="" width={221} height={609} fetchPriority="high" decoding="async" draggable={false} />
            <div className={s.rim} style={{ WebkitMaskImage: `url(${rocket})`, maskImage: `url(${rocket})` }} />
            <div className={s.burn} style={{ WebkitMaskImage: `url(${rocket})`, maskImage: `url(${rocket})` }} />
          </div>
        </div>
        <div className={s.flare} />
        <div className={s.vapor}><span /><span /><span /><span /></div>
        <div className={s.billow}><i /><i /><i /><i /><i /><i /><i /><i /></div>
      </div>
      <div className={`${s.fog} ${s.fogFront}`} style={fog} />
    </div>
  );
}
