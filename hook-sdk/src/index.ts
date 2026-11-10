import type { Hex } from "viem";
import type { PoolInfo } from "./pools.ts";

export * from "./abi.ts";
export * from "./pools.ts";
export * from "./quote.ts";
export * from "./stats.ts";
export { ROBINHOOD } from "./robinhood.ts";

/**
 * What a router has to watch to know a cached quote went stale. Besides a new block (the centre may step once per
 * block; on Robinhood and other Arbitrum-stack chains `block.number` is the L1 block, about every 12 s):
 * - the hook: HookSwap, HookModifyLiquidity, Tipped (a sample() moved the centre), JarFunded, PriceAccepted, LocalMode
 * - same chain: every swap or liquidity change on each source leg (the live cap and the centre read them)
 */
export function watchSet(hook: Hex, info: PoolInfo): { hook: Hex; v4PoolIds: Hex[]; contracts: Hex[] } {
  if (info.remoteEid !== 0) return { hook, v4PoolIds: [], contracts: [] }; // cross chain: only PriceAccepted moves it
  return {
    hook,
    v4PoolIds: info.legs.filter((l) => l.kind === "v4").map((l) => l.v4Id),
    contracts: info.legs.filter((l) => l.kind !== "v4").map((l) => l.target),
  };
}
