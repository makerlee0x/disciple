/**
 * Trending-hero rocket ON the launch pad: the #79 rooftop deck with a full-height service gantry (right of the rocket,
 * umbilical arms reaching in) and a launch mount at the deck centre the rocket stands on. Idle: exhaust smog vents
 * from under the engines and rolls out low along the deck, lit warm from below by the pad lamps, and dissipates up
 * and out; far away, a small moon (our target) hangs off to one side of the rocket's path. `launching` plays the
 * lift-off: the idle smog surges into the ignition (flare, exhaust, billowing smoke), then the rocket rises out of frame.
 * All CSS transform/opacity, no canvas, no video. Grain stays on the sky only (it sits under this layer).
 *
 * Geometry is in plate pixels × --s: the pad asset's baked mount point (PAD_BASE) is the scene origin, so the rocket
 * is always planted on the mount at any size. Smog sprites + moon load after paint (`go`).
 */
import { withBase } from "@/lib/base-path";
import { ROCKET_SRC } from "@/lib/home/trending";
import s from "./heroPad.module.css";

export const PAD_SRC = "/home/pad/pad.webp";
const PAD_SM_SRC = "/home/pad/pad-sm.webp";
const FOG_SRC = "/hero/fog.webp"; // #79 haze sheet
const SMOG = { roll: "/home/pad/smog-roll.webp", puff: "/home/pad/smog-puff.webp", wisp: "/home/pad/smog-wisp.webp" };
export const MOON_SRC = "/home/pad/moon.webp";

/** Lift-off length (ms): navigation fires when the rocket has cleared the frame. Mirrors --liftoff-ms in the CSS. */
export const LIFTOFF_MS = 1300;

const n = (k: number, c?: string) => Array.from({ length: k }, (_, i) => <i key={i} className={c} />);

export default function HeroPad({ go, launching }: { go: boolean; launching: boolean }) {
  const fog = { backgroundImage: `url(${withBase(FOG_SRC)})` };
  const rocket = withBase(ROCKET_SRC);
  const smog = go
    ? ({ ["--smog-roll" as string]: `url(${withBase(SMOG.roll)})`, ["--smog-puff" as string]: `url(${withBase(SMOG.puff)})`, ["--smog-wisp" as string]: `url(${withBase(SMOG.wisp)})` } as React.CSSProperties)
    : undefined;
  return (
    <div className={`${s.pad}${go ? " " + s.go : ""}${launching ? " " + s.launching : ""}`} style={smog} aria-hidden>
      {go && (
        <div className={s.moon}>
          <span className={s.moonGlow} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={withBase(MOON_SRC)} alt="" width={160} height={160} decoding="async" draggable={false} />
        </div>
      )}
      <div className={`${s.fog} ${s.fogBack}`} style={fog} />
      <div className={s.scene}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={s.deck} src={withBase(PAD_SRC)} srcSet={`${withBase(PAD_SM_SRC)} 535w, ${withBase(PAD_SRC)} 1070w`}
          sizes="(max-width: 760px) 360px, 600px" width={1070} height={676} alt="" fetchPriority="low" decoding="async" draggable={false} />
        <span className={s.beacon} />
        <span className={s.lamp} style={{ ["--lx" as string]: 963, ["--ly" as string]: 504 }} />
        <span className={s.lamp} style={{ ["--lx" as string]: 674, ["--ly" as string]: 530 }} />
        <span className={s.lamp} style={{ ["--lx" as string]: 105, ["--ly" as string]: 530 }} />
        <div className={s.deckGlow} />
        <div className={s.pool} />
        <div className={s.refl}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={rocket} alt="" width={221} height={609} decoding="async" draggable={false} />
        </div>
        {/* smog behind the hull: the deck bed, vent puffs swelling out from under the engines, wisps climbing past it */}
        <div className={s.smog}><i className={s.bed} />{n(3, s.wisp)}{n(3, s.vent)}</div>
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
        {/* smog in front, low: the dense core under the nozzle and rollers spreading along the deck, lit by the lamps */}
        <div className={s.smog}>{n(4, s.roll)}<i className={s.haze} /><i className={s.core} /></div>
        <div className={s.smogGlow} />
        <div className={s.billow}>{n(8)}</div>
      </div>
      <div className={`${s.fog} ${s.fogFront}`} style={fog} />
    </div>
  );
}
