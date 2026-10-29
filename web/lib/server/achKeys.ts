import "server-only";
/**
 * KV key names for the V1 achievements engine (lib/server/achievements.ts). Separate tiny module so the trade indexer
 * (lib/server/trades.ts storeFills / replaceFill) can mark wallets dirty without importing the engine (no cycle).
 * Namespaced by chain id: testnet unlocks never carry to mainnet (GAME Q2).
 */
import { ACTIVE_CHAIN } from "@/lib/chains";

const ns = () => `ach:${ACTIVE_CHAIN.id}`;
export const ACH = {
  /** zset score=recordedAt ms, member=`${wallet}|${reason}` — wallets to re-score (unique member per fill/event ⇒ never lost) */
  dirty: () => `${ns()}:dirty`,
  /** zset score=unlockedAt ms (block time), member=AchievementUnlockRecord JSON */
  unlocks: (w: string) => `${ns()}:u:${w.toLowerCase()}`,
  /** SET NX marker: rule `id` unlocked for wallet (once ever) */
  seen: (id: string, w: string) => `${ns()}:seen:${id}:${w.toLowerCase()}`,
  /** JSON { v, at, progress: { [id]: { progress, target } } } — last evaluation */
  progress: (w: string) => `${ns()}:p:${w.toLowerCase()}`,
  /** JSON { creator, anon, curve, launch: ref, grad?: ref } */
  coin: (c: string) => `${ns()}:coin:${c.toLowerCase()}`,
  /** set of every coin seen in Launched (for seeding) */
  coins: () => `${ns()}:coins`,
  /** last block scanned for Launched / GraduatedToV4, per launchpad */
  cursor: (launchpad: string) => `${ns()}:cur:${launchpad.toLowerCase()}`,
  /** zset score=recordedAt ms, member=JSON { wallet, id, rarity, unlockedAt, tx, recordedAt } — live unlocks for toasts */
  feed: () => `${ns()}:feed`,
  /** counter per rule */
  count: (id: string) => `${ns()}:count:${id}`,
  /** rules version the stored state was seeded for (V1_RULES_VERSION) */
  ver: () => `${ns()}:ver`,
  /** seeding progress for a rules version: index into the coins list */
  seed: (v: number) => `${ns()}:seed:${v}`,
  lock: () => `${ns()}:lock`,
};
