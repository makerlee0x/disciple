import "server-only";
/**
 * Chain reads for the keeper reference price (lib/poolRef): current spot from PoolManager storage (extsload, same slot
 * as v4 StateLibrary.getSlot0, works on any chain without StateView) and the pool's Swap prices over REF_WINDOW_S.
 */
import { encodeAbiParameters, keccak256, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { SWAP_EVENT, type SwapArgs } from "@/lib/v4Swap";
import { REF_WINDOW_S, twapSqrt, type PricePoint } from "@/lib/poolRef";

const PM_ABI = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);
/** v4-core StateLibrary.POOLS_SLOT */
const POOLS_SLOT = BigInt(6);
const MASK160 = (BigInt(1) << BigInt(160)) - BigInt(1);
const MAX_POINTS = 200;

/** slot0.sqrtPriceX96 of a v4 pool (0n if the pool is not initialized). */
export async function spotSqrt(pc: PublicClient, poolManager: Address, poolId: Hex): Promise<bigint> {
  const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, POOLS_SLOT]));
  const w = await pc.readContract({ address: poolManager, abi: PM_ABI, functionName: "extsload", args: [slot] });
  return BigInt(w) & MASK160;
}

/** Seconds per block, measured over the last `span` blocks (floored at 0.05 s). */
async function blockTime(pc: PublicClient, latest: { number: bigint; timestamp: bigint }, span = BigInt(2_000)): Promise<number> {
  const back = latest.number > span ? latest.number - span : BigInt(0);
  const b = await pc.getBlock({ blockNumber: back });
  const dt = Number(latest.timestamp - b.timestamp), dn = Number(latest.number - back);
  return dn > 0 && dt > 0 ? Math.max(0.05, dt / dn) : 1;
}

/**
 * Keeper reference sqrtPriceX96 for `poolId`: geometric TWAP of its Swap prices over the last REF_WINDOW_S, starting
 * from the price held when the window opened (first swap's pre-price, rebuilt from its token1 delta and liquidity) or
 * the current spot when nothing traded. Returns { ref, spot } (spot from storage, for the caller's own 3% pre-check).
 */
export async function refSqrt(pc: PublicClient, poolManager: Address, poolId: Hex): Promise<{ ref: bigint; spot: bigint }> {
  const latest = await pc.getBlock();
  const spot = await spotSqrt(pc, poolManager, poolId);
  const spb = await blockTime(pc, { number: latest.number, timestamp: latest.timestamp });
  const blocks = BigInt(Math.ceil((REF_WINDOW_S * 1.2) / spb));
  const from = latest.number > blocks ? latest.number - blocks : BigInt(0);
  const logs = (await pc.getLogs({ address: poolManager, event: SWAP_EVENT, args: { id: poolId }, fromBlock: from, toBlock: latest.number })) as unknown as {
    blockNumber: bigint; args: SwapArgs;
  }[];
  if (!logs.length) return { ref: spot, spot };
  const recent = logs.slice(-MAX_POINTS);
  const ts = new Map<bigint, number>();
  for (const b of Array.from(new Set(recent.map((l) => l.blockNumber)))) ts.set(b, Number((await pc.getBlock({ blockNumber: b })).timestamp));
  const first = recent[0].args;
  const Q96 = BigInt(2) ** BigInt(96);
  let start = first.liquidity > BigInt(0) ? first.sqrtPriceX96 + (first.amount1 * Q96) / first.liquidity : first.sqrtPriceX96;
  if (start <= BigInt(0)) start = first.sqrtPriceX96;
  const points: PricePoint[] = recent.map((l) => ({ ts: ts.get(l.blockNumber) ?? Number(latest.timestamp), sqrtP: l.args.sqrtPriceX96 }));
  return { ref: twapSqrt(start, points, Number(latest.timestamp)), spot };
}
