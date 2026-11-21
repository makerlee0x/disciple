/**
 * Season track (retention loop, maker 2026-11-21 "do all 10", item 4): the XP you earn inside a season fills a 30-tier
 * track that starts over each season (same 12-week seasons as the ladder, lib/duel/season rankSeasonAt, so pre-season XP
 * from 2026-11-20 counts toward Season 1). Every 5th tier drops a bound crate (cosmetic, never trades). Free: no pass to
 * buy, nothing on-chain. Pure, shared by server, client and tests.
 *
 * Sized so a pilot who only plays free modes (~150 Free play XP + streaks + drops, ~250 XP a day) clears it in about
 * 12 weeks, and an active trader in about 5. Crate XP and spends don't count, so opening the track's own crates can't
 * fill the track.
 */
import type { Rarity } from "@/lib/collection";

export const TRACK = { tiers: 30, xpPerTier: 700 } as const;
/** tier → crate */
export const TRACK_REWARDS: Readonly<Record<number, Rarity>> = { 5: "uncommon", 10: "rare", 15: "rare", 20: "epic", 25: "epic", 30: "legendary" };
/** ledger kinds that never fill the track */
const SKIP = new Set(["crate", "buy", "prestige"]);

export interface TrackRow { kind: string; xp: number; ts: number }
/** XP earned in [from, to): positive rows only, crate XP and spends left out */
export function seasonXp(rows: readonly TrackRow[], from: number, to: number): number {
  let t = 0;
  for (const r of rows) if (r.xp > 0 && r.ts >= from && r.ts < to && !SKIP.has(r.kind)) t += r.xp;
  return t;
}

export interface TrackState {
  xp: number; tier: number; max: number;
  /** XP into the next tier and what it needs (0 at the top) */
  into: number; need: number;
  /** the next tier that drops a crate, if any is left */
  next: { tier: number; crate: Rarity } | null;
  /** tiers reached that drop a crate */
  earned: { tier: number; crate: Rarity }[];
}
export function trackOf(xp: number): TrackState {
  const x = Math.max(0, Math.floor(xp)), tier = Math.min(TRACK.tiers, Math.floor(x / TRACK.xpPerTier));
  const top = tier >= TRACK.tiers;
  const rewards = Object.entries(TRACK_REWARDS).map(([k, v]) => ({ tier: Number(k), crate: v })).sort((a, b) => a.tier - b.tier);
  return {
    xp: x, tier, max: TRACK.tiers,
    into: top ? 0 : x - tier * TRACK.xpPerTier, need: top ? 0 : TRACK.xpPerTier,
    next: rewards.find((r) => r.tier > tier) ?? null,
    earned: rewards.filter((r) => r.tier <= tier),
  };
}
