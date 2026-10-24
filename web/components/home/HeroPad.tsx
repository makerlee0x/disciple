/**
 * Trending-hero rocket ON the launch pad (BRAND home-hero layers r1, from the owner-approved plate_v1b).
 *
 * Everything lives in one **plate frame**: a box with the sky's aspect (16:9 desktop, 828:1792 mobile) that covers the
 * hero stage. The sky plate has the deck, mount ring, gantry and fog baked in (moon removed); every other layer is
 * positioned in % of that frame or in pad px (`--u` = one pad.webp pixel at its rendered size), so the layers stay
 * registered to the sky, and the rocket stays seated in the mount ring, at every viewport. Any idle drift moves the
 * whole frame (sky + pad + rocket) together; the sky never drifts on its own.
 *
 * Z-order (SPEC §3): sky → stars → moon (carries its own glow) → back smog (tile bands, bed, wisps) → pad.webp (occludes
 * stars / moon / back smog; duplicates the baked pad exactly) → rocket (night tint + amber bounce + cool rim) →
 * exhaust glow (screen) → pad-front lip (hides fin tips + spike so the rocket reads as seated in the ring) → glow
 * spill → front smog (vent puffs, rolls). Grain + scrims + UI sit above this layer (HomeHero).
 *
 * `launching` plays the lift-off: the idle smog surges into the ignition (flare, exhaust, billowing smoke), then the
 * rocket rises out of frame. All CSS transform/opacity, no canvas, no video. The sky paints first (LQIP under a
 * <picture> with AVIF/WebP + responsive sizes); pad / moon / stars / smog / glow load after paint (`go`).
 */
import { withBase } from "@/lib/base-path";
import { ROCKET_SRC } from "@/lib/home/trending";
import s from "./heroPad.module.css";

const P = "/home/pad/";
export const PAD_SRC = P + "pad.webp";
const PAD_SM_SRC = P + "pad-sm.webp";
const PAD_FRONT_SRC = P + "pad-front.webp";
export const MOON_SRC = P + "moon.webp";
const MOON_2X_SRC = P + "moon@2x.webp";
const GLOW_SRC = P + "exhaust-glow.webp";
const STARS = [P + "stars-a.webp", P + "stars-b.webp"];
const SMOG = { roll: P + "smog-roll.webp", tile: P + "smog-roll-tile.webp", puff: P + "smog-puff.webp", wisp: P + "smog-wisp.webp" };

/** Sky plates (pad + fog baked in, moon removed). Desktop 16:9, mobile 828:1792 portrait. */
export const SKY = {
  desktopAvif: `${P}sky-1280.avif 1280w, ${P}sky-1920.avif 1920w`,
  desktopWebp: `${P}sky-1280.webp 1280w, ${P}sky-1920.webp 1920w`,
  mobileAvif: `${P}sky-mobile.avif 828w`,
  mobileWebp: `${P}sky-mobile-414.webp 414w, ${P}sky-mobile.webp 828w`,
  fallback: `${P}sky-1280.webp`,
};
export const SKY_MOBILE_MQ = "(max-width: 760px)";
export const SKY_DESKTOP_MQ = "(min-width: 761px)";
/** Desktop frame ≥ the stage width (see heroPad.module.css); mobile frame = stage width. */
export const SKY_SIZES = `${SKY_MOBILE_MQ} 100vw, max(100vw - 270px, 1031px)`;

/** Lift-off length (ms): navigation fires when the rocket has cleared the frame. Mirrors --liftoff-ms in the CSS. */
export const LIFTOFF_MS = 1300;

const srcset = (list: string) => list.split(", ").map((e) => { const [u, w] = e.split(" "); return `${withBase(u)} ${w}`; }).join(", ");
const n = (k: number, c?: string) => Array.from({ length: k }, (_, i) => <i key={i} className={c} />);

export default function HeroPad({ go, launching }: { go: boolean; launching: boolean }) {
  const rocket = withBase(ROCKET_SRC);
  const rocketMask = { WebkitMaskImage: `url(${rocket})`, maskImage: `url(${rocket})` };
  const lazy = go
    ? ({
        ["--smog-roll" as string]: `url(${withBase(SMOG.roll)})`, ["--smog-tile" as string]: `url(${withBase(SMOG.tile)})`,
        ["--smog-puff" as string]: `url(${withBase(SMOG.puff)})`, ["--smog-wisp" as string]: `url(${withBase(SMOG.wisp)})`,
        ["--glow" as string]: `url(${withBase(GLOW_SRC)})`,
      } as React.CSSProperties)
    : undefined;
  return (
    <div className={`${s.pad}${go ? " " + s.go : ""}${launching ? " " + s.launching : ""}`} style={lazy} aria-hidden>
      <div className={s.plate}>
        {/* z0: sky plate (LCP; the inline LQIP under it is the frame's ::before) */}
        <picture>
          <source media={SKY_MOBILE_MQ} type="image/avif" srcSet={srcset(SKY.mobileAvif)} sizes={SKY_SIZES} />
          <source media={SKY_MOBILE_MQ} type="image/webp" srcSet={srcset(SKY.mobileWebp)} sizes={SKY_SIZES} />
          <source type="image/avif" srcSet={srcset(SKY.desktopAvif)} sizes={SKY_SIZES} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={s.sky} src={withBase(SKY.fallback)} srcSet={srcset(SKY.desktopWebp)} sizes={SKY_SIZES}
            alt="" width={1280} height={720} fetchPriority="high" decoding="async" draggable={false} />
        </picture>
        {go && (
          <>
            {/* z1: twinkle tiles; z2: moon (disc + baked glow) */}
            <div className={s.stars}><i style={{ backgroundImage: `url(${withBase(STARS[0])})` }} /><i style={{ backgroundImage: `url(${withBase(STARS[1])})` }} /></div>
            <div className={s.moon}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={withBase(MOON_SRC)} srcSet={`${withBase(MOON_SRC)} 160w, ${withBase(MOON_2X_SRC)} 320w`}
                sizes={`${SKY_MOBILE_MQ} 49vw, 27vw`} alt="" width={160} height={160} decoding="async" draggable={false} />
            </div>
            {/* z3: back smog bands drifting behind the deck (seamless tile, opposite directions) */}
            <i className={`${s.band} ${s.bandA}`} /><i className={`${s.band} ${s.bandB}`} />
          </>
        )}
        <div className={s.scene}>
          {/* z3: smog behind the hull: the deck bed + wisps climbing past it */}
          <div className={s.back}><div className={s.smog}><i className={s.bed} />{n(3, s.wisp)}</div></div>
          {/* z4: deck + mount ring + gantry cut-out (pad-sm on small DPR-1 screens), origin = mount point (497.2, 501) */}
          {go && (
            <picture>
              <source media={`${SKY_MOBILE_MQ} and (max-resolution: 1dppx)`} srcSet={withBase(PAD_SM_SRC)} />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className={s.deck} src={withBase(PAD_SRC)} width={1070} height={676} alt="" fetchPriority="low" decoding="async" draggable={false} />
            </picture>
          )}
          <span className={s.beacon} />
          <span className={s.lamp} style={{ ["--lx" as string]: 965.3, ["--ly" as string]: 476.3 }} />
          <span className={s.lamp} style={{ ["--lx" as string]: 753.8, ["--ly" as string]: 542.6 }} />
          <span className={s.lamp} style={{ ["--lx" as string]: 157.4, ["--ly" as string]: 502.5 }} />
          <div className={s.deckGlow} />
          <div className={s.pool} />
          {/* z5: rocket, fin-tip line on the seat */}
          <div className={s.lift}>
            <div className={s.flame}><i /><i /></div>
            <div className={s.body}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className={s.rocketImg} src={rocket} alt="" width={221} height={609} fetchPriority="high" decoding="async" draggable={false} />
              <div className={s.tint} style={rocketMask} />
              <div className={s.rim} style={rocketMask} />
              <div className={s.burn} style={rocketMask} />
            </div>
          </div>
          {/* z6: idle exhaust glow; z7: front lip of the ring; z8: glow spill over the lip */}
          {go && <i className={`${s.glow} ${s.glowMain}`} />}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={s.padFront} src={withBase(PAD_FRONT_SRC)} width={348} height={75} alt="" decoding="async" draggable={false} />
          {go && <i className={`${s.glow} ${s.glowSpill}`} />}
          <div className={s.flare} />
          {/* z9: front smog, low: vent puffs at the ring base, rollers spreading along the deck, the dense core */}
          <div className={s.front}><div className={s.smog}>{n(4, s.roll)}{n(2, s.vent)}<i className={s.haze} /><i className={s.core} /></div></div>
          <div className={s.smogGlow} />
          <div className={s.billow}>{n(8)}</div>
        </div>
      </div>
    </div>
  );
}
