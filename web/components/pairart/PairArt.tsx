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
import { memo } from "react";
import { withBase } from "@/lib/base-path";
import { basePair, pairCoin, pairCoinSm, PAIR_GRAIN, PAIR_SKY } from "@/lib/pairArt";

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
};

function PairArt({ src, pair, tk = "", tint = "#e3d6ff", size = "grid", px, className, eager, fluid }: Props) {
  const bp = basePair(pair);
  const n = px ?? PX[size];
  const bg = size === "header" || size === "grid";
  const sm = size === "icon";
  const load = eager ? "eager" : "lazy";
  return (
    <span className={`pa pa-${size}${fluid ? " pa-fluid" : ""}${bp ? "" : " pa-solo"}${className ? " " + className : ""}`} style={fluid ? undefined : { width: n, height: n }} aria-hidden>
      {bg && <img className="pa-sky" src={withBase(PAIR_SKY)} alt="" loading={load} decoding="async" draggable={false} />}
      <span className="pa-sq" style={{ background: tint }}>
        {src
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={src} alt="" loading={load} decoding="async" draggable={false} />
          : <b className="pa-mono">{tk.slice(0, 2)}</b>}
      </span>
      {bp && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={sm ? "pa-coin-sm" : "pa-coin"} src={sm ? pairCoinSm(bp.tk) : pairCoin(bp.tk)} alt="" loading={load} decoding="async" draggable={false} />
      )}
      {bg && <span className="pa-grain" style={{ backgroundImage: `url(${withBase(PAIR_GRAIN)})` }} />}
    </span>
  );
}
export default memo(PairArt);
