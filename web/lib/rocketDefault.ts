/**
 * Branded default rocket art for rockets with no image (BRAND rocket-default-r1, lee approved Oct 26 2026;
 * SPEC: /workspace/disciple-brand/release/rocket-default-r1/SPEC.md). Assets: public/assets/rocket-default/.
 *
 * DISPLAY ONLY. Never write these paths into token metadata / the on-chain image, never send them as a coin's image
 * to listings, and never show them for test coins (lib/home/hiddenCoins). They are UI fallbacks inside PairArt.
 *
 * Size rule (rendered square slot): ≤ 64px → generic small crop (tier skies can't be read that small);
 * 65–128px → _256; > 128px → _512. Tier variants only where the tier is part of the card (feed cards, coin header);
 * the generic version everywhere else (share, OG, chat, small slots) and as the safety fallback.
 */
import { withBase } from "@/lib/base-path";
import { TIERS } from "@/lib/config";
import { isHiddenCoin } from "@/lib/home/hiddenCoins";

const DIR = "/assets/rocket-default";

/** The generic default rocket image (512px webp). Use this anywhere a coin has no art and the tier isn't shown. */
export const DEFAULT_ROCKET_IMAGE = `${DIR}/rocket-default_512.webp`;
export const DEFAULT_ROCKET_IMAGE_256 = `${DIR}/rocket-default_256.webp`;
export const DEFAULT_ROCKET_IMAGE_SM = `${DIR}/rocket-default-sm_128.webp`;

/** Launch Pad, the tier every rocket launches at. */
export const LAUNCH_TIER = 0;

/**
 * The tier whose sky the default art shows. lee, Oct 26 2026: use the rocket's LAUNCH tier for now. To switch to
 * the live tier later, return `tierAt(c?.mcap ?? c?.mcapUsd ?? 0).index` (lib/stats) here; every caller goes through this function.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function rocketArtTier(c?: { mcap?: number | null; mcapUsd?: number | null }): number {
  return LAUNCH_TIER;
}

export type ArtSlot = "sm" | "md" | "lg";
/** Rendered square slot in CSS px → asset size bucket. */
export const artSlotOf = (px: number): ArtSlot => (px <= 64 ? "sm" : px <= 128 ? "md" : "lg");

const tierOk = (t: number | null | undefined): t is number => typeof t === "number" && Number.isInteger(t) && t >= 0 && t < TIERS.length;

/**
 * Default-art fallback chain for one slot (steps 2–3 of SPEC "Fallback chain"): tier variant (when a tier is given,
 * known and the slot is big enough), then generic at the same size. Empty for test coins: they never get default art.
 */
export function defaultRocketArtChain(o: { slot: ArtSlot; tier?: number | null; coin?: string | null }): string[] {
  if (o.coin && isHiddenCoin(o.coin)) return [];
  if (o.slot === "sm") return [withBase(DEFAULT_ROCKET_IMAGE_SM)];
  const size = o.slot === "md" ? 256 : 512;
  const generic = withBase(o.slot === "md" ? DEFAULT_ROCKET_IMAGE_256 : DEFAULT_ROCKET_IMAGE);
  return tierOk(o.tier) ? [withBase(`${DIR}/tier/rocket-default_tier${o.tier}_${size}.webp`), generic] : [generic];
}

/** Tint behind the art (and the last fallback): the tier's sky top, or Launch Pad's for generic, so a swap doesn't flash. */
export const defaultRocketTint = (tier?: number | null) => `var(--dsc-tier-${String(tierOk(tier) ? tier : 0).padStart(2, "0")}-sky-top)`;
