"use client";
/**
 * Pair art: the new coin's image as a big rounded square, the base pair's logo as a smaller
 * silver-chrome coin overlapping its bottom-right corner, centered on a dreamcore cloud sky.
 *
 * Pure HTML/CSS over pre-rendered static assets (scripts/pair-art/gen.py): the rim, specular and
 * drop shadow are baked into one 256px webp per pair, and the sky (haze below + group shadow +
 * grain) is one shared 640px webp — so 600+ cards cost 2 cached images + each coin's own image,
 * no canvas work and no per-card filters.
 *
 * Sizes: "header" / "grid" (sky background), "list" (no background, full chrome rim),
 * "icon" (no background, simplified rim; for ≤32px).
 */
import { memo, useState } from "react";
import { withBase } from "@/lib/base-path";
import { basePair, pairCoin, pairCoinSm, PAIR_SKY } from "@/lib/pairArt";
import { artSlotOf, defaultRocketArtChain, defaultRocketTint } from "@/lib/rocketDefault";

export type PairArtSize = "header" | "grid" | "list" | "icon";
const PX: Record<PairArtSize, number> = { header: 220, grid: 150, list: 40, icon: 24 };

type Props = {
  /** New coin image (square-cropped via object-fit). */
  src?: string | null;
  /** Base pair symbol, e.g. "STRATEGY", "mUSDG", "WETH". Unknown → square only. */
  pair?: string | null;
  /** Ticker, for the fallback monogram when there is no image. */
  tk?: string;
  tint?: string;
  size?: PairArtSize;
  /** Override pixel size (box is square). Use "100%" via className for fluid layouts. */
  px?: number;
  className?: string;
  /** Eager-load (above the fold, e.g. coin header). */
  eager?: boolean;
  /** Fill the parent (width/height 100%) instead of a fixed pixel box. */
  fluid?: boolean;
  /** Coin address: test coins (lib/home/hiddenCoins) never get the default rocket art. */
  coin?: string | null;
  /** Tier for the default art's sky (lib/rocketDefault rocketArtTier). Only feed cards / the coin header pass it. */
  artTier?: number | null;
  /** Off ⇒ old behaviour (tint + monogram) when there is no image. */
  defaultArt?: boolean;
};

/** Rendered square slot (CSS px) per size, for the default-art size rule (SPEC: grid/fluid cards ≈107–130, header ≈140). */
const SLOT: Record<PairArtSize, number> = { header: 140, grid: 120, list: 30, icon: 18 };

function PairArt({ src, pair, tk = "", tint = "#e3d6ff", size = "grid", px, className, eager, fluid, coin, artTier, defaultArt = true }: Props) {
  const bp = basePair(pair);
  const n = px ?? PX[size];
  // Fallback chain (rocket-default-r1 SPEC): own image → tier default → generic default → tinted square (no monogram).
  // onError moves one step forward, once per step, so it can't loop. Default art is display-only (lib/rocketDefault).
  const defaults = defaultArt ? defaultRocketArtChain({ slot: artSlotOf(px && !fluid ? px * 0.742 : SLOT[size]), tier: artTier, coin }) : [];
  const chain = [...(src ? [src] : []), ...defaults];
  const key = chain.join("|");
  const [err, setErr] = useState<{ key: string; step: number }>({ key, step: 0 });
  const step = err.key === key ? err.step : 0;
  const cur = chain[step];
  const usingDefault = !!cur && step >= (src ? 1 : 0);
  const fell = defaults.length > 0 && !cur; // every default failed ⇒ plain tint, no monogram
  const bgTint = usingDefault || fell ? defaultRocketTint(artTier) : tint;
  const bg = size === "header" || size === "grid";
  const sm = size === "icon";
  const load = eager ? "eager" : "lazy";
  return (
    <span className={`pa pa-${size}${fluid ? " pa-fluid" : ""}${bp ? "" : " pa-solo"}${className ? " " + className : ""}`} style={fluid ? undefined : { width: n, height: n }} aria-hidden>
      {bg && <img className="pa-sky" src={withBase(PAIR_SKY)} alt="" loading={load} decoding="async" draggable={false} />}
      <span className="pa-sq" style={{ background: bgTint }}>
        {cur
          // eslint-disable-next-line @next/next/no-img-element
          ? <img key={cur} src={cur} alt="" loading={load} decoding="async" draggable={false} onError={() => setErr({ key, step: step + 1 })} />
          : fell ? null : <b className="pa-mono">{tk.slice(0, 2)}</b>}
      </span>
      {bp && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={sm ? "pa-coin-sm" : "pa-coin"} src={sm ? pairCoinSm(bp.tk) : pairCoin(bp.tk)} alt="" loading={load} decoding="async" draggable={false} />
      )}
    </span>
  );
}
export default memo(PairArt);
