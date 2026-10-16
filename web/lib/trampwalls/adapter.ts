/**
 * Tramps & Walls — adapter seam for DISCIPLE FLOW's TrampWallManager + indexer.
 * Graduated (v4) coins only. Tramp = single-sided QUOTE LP below price (support).
 * Wall = single-sided TOKEN LP above price (resistance). See docs/tramps-walls.md.
 */
import type { Address } from "../protocol";

export type TrampWallKind = "tramp" | "wall";
export type TrampWallStatus = "active" | "filled" | "cancelled";

export interface TrampWall {
  id: string;
  token: Address;
  owner: Address;
  kind: TrampWallKind;
  /** Center trigger price expressed as market cap USD (engine draws in mcap space). */
  mcapUsd: number;
  /** Range bounds (mcap USD). */
  mcapLoUsd: number;
  mcapHiUsd: number;
  tickLower?: number;
  tickUpper?: number;
  /** Raw deposit (quote wei for tramp, token wei for wall). */
  amount: bigint;
  /** USD notional at placement (drives line thickness). */
  sizeUsd: number;
  status: TrampWallStatus;
  /** 0..1 portion of the range converted. */
  filledFrac: number;
  feesEarnedUsd: number;
  pointsEarned: number;
  createdAt: number;
  filledAt?: number;
}

export interface PlaceTrampWallParams {
  token: Address;
  kind: TrampWallKind;
  mcapUsd: number;
  /** Optional range width, % of price (default 2). */
  rangeWidthPct?: number;
  amount: bigint;
  sizeUsd: number;
}

export interface TrampWallPreview {
  distancePct: number;
  mcapLoUsd: number;
  mcapHiUsd: number;
  /** Legacy field, always 0: tramps/walls are one-sided limit orders with no fee share or yield. */
  estFeeShareUsdPerDay: number;
  estSharePct: number;
  pointsIfFilled: number;
  valid: boolean;
  reason?: string;
}

export type TrampWallEvent =
  | { type: "Placed"; tw: TrampWall }
  | { type: "Cancelled"; id: string; token: Address }
  | { type: "Filled"; id: string; token: Address; filledAt: number; pointsEarned: number }
  | { type: "FeesDonated"; id: string; token: Address; amountUsd: number };

export interface TrampWallAdapter {
  isGraduated(token: Address): Promise<boolean>;
  /** All live (active + recently filled) tramps/walls for a coin. */
  list(token: Address): Promise<TrampWall[]>;
  listMine(owner: Address, token?: Address): Promise<TrampWall[]>;
  preview(p: PlaceTrampWallParams, currentMcapUsd: number): Promise<TrampWallPreview>;
  place(p: PlaceTrampWallParams): Promise<{ ok: boolean; id?: string; txHash?: string; reason?: string }>;
  cancel(id: string): Promise<{ ok: boolean; txHash?: string; reason?: string }>;
  onEvent(token: Address, cb: (e: TrampWallEvent) => void): () => void;
}

export const HOOK_DONATION_BPS = 0; // no donation / yield (pool LP fee 0, hook donates nothing)
export const POINTS = { tramp: 250, wall: 300, perKUsd: 40 };

export function pointsFor(kind: TrampWallKind, sizeUsd: number): number {
  return Math.round(POINTS[kind] + (sizeUsd / 1000) * POINTS.perKUsd);
}

export function computePreview(p: PlaceTrampWallParams, cur: number, inRangeLiqUsd = 25_000, dailyVolUsd = 60_000): TrampWallPreview {
  const w = Math.max(0.5, p.rangeWidthPct ?? 2) / 100;
  const mcapLoUsd = p.mcapUsd * (1 - w / 2), mcapHiUsd = p.mcapUsd * (1 + w / 2);
  const distancePct = cur > 0 ? ((p.mcapUsd - cur) / cur) * 100 : 0;
  let valid = p.sizeUsd > 0, reason: string | undefined;
  if (p.kind === "tramp" && mcapHiUsd >= cur) { valid = false; reason = "Tramp must sit fully BELOW current price"; }
  if (p.kind === "wall" && mcapLoUsd <= cur) { valid = false; reason = "Wall must sit fully ABOVE current price"; }
  if (!(p.sizeUsd > 0)) reason = reason ?? "Enter an amount";
  const estSharePct = (p.sizeUsd / (p.sizeUsd + inRangeLiqUsd)) * 100;
  const reach = Math.exp(-Math.abs(distancePct) / 25) * Math.min(3, 2 / (w * 100));
  const estFeeShareUsdPerDay = dailyVolUsd * (HOOK_DONATION_BPS / 10_000) * (estSharePct / 100) * reach;
  return { distancePct, mcapLoUsd, mcapHiUsd, estFeeShareUsdPerDay, estSharePct, pointsIfFilled: pointsFor(p.kind, p.sizeUsd), valid, reason };
}
