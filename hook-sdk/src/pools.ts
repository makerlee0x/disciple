// Finding Disciple pools and reading what an integrator needs about each one.
//
// A Disciple pool is a Uniswap v4 pool whose key is (currency0, currency1, fee 0, tickSpacing n, hook), where n
// counts the Disciple pools created for that token pair (1 for the first). The real fee lives in the hook. The pool
// holds no v4 liquidity: its sqrtPrice stays at 2^96 and means nothing. Prices come only from quoteView.
//
// The hook has no getter for a pool's fee or source, so they are read from storage. Layout from
// `forge inspect DiscipleHook storageLayout` (v0.2, same as keeper/src/hook.ts): `pools` mapping at slot 1; in
// Pool, slot +0 packs exists, live, coinIs0, local, fee (uint24) and coin; +2..+5 hold the Source struct.
import { encodeAbiParameters, keccak256, type Hex, type PublicClient } from "viem";
import { discipleHookAbi } from "./abi.ts";

export interface PoolKey {
  currency0: Hex;
  currency1: Hex;
  fee: number;
  tickSpacing: number;
  hooks: Hex;
}

export const POOLS_SLOT = 1n;
const ZERO: Hex = "0x0000000000000000000000000000000000000000";

const keyAbi = [
  {
    type: "tuple",
    components: [
      { name: "currency0", type: "address" },
      { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" },
    ],
  },
] as const;

/** v4 PoolId = keccak256(abi.encode(key)). */
export const poolId = (k: PoolKey): Hex => keccak256(encodeAbiParameters(keyAbi, [k]));

export const sortPair = (a: Hex, b: Hex): [Hex, Hex] => (BigInt(a) < BigInt(b) ? [a, b] : [b, a]);

/** Key of the n-th Disciple pool (n from 1) for a token pair on `hook`. */
export function discipleKey(hook: Hex, tokenA: Hex, tokenB: Hex, n: number): PoolKey {
  const [currency0, currency1] = sortPair(tokenA, tokenB);
  return { currency0, currency1, fee: 0, tickSpacing: n, hooks: hook };
}

/** Every Disciple pool for a token pair, without scanning logs: one poolsOf read, then the keys follow. */
export async function poolsForPair(
  c: PublicClient,
  hook: Hex,
  tokenA: Hex,
  tokenB: Hex,
): Promise<{ id: Hex; key: PoolKey }[]> {
  const [c0, c1] = sortPair(tokenA, tokenB);
  const n = Number(await c.readContract({ address: hook, abi: discipleHookAbi, functionName: "poolsOf", args: [c0, c1] }));
  return Array.from({ length: n }, (_, i) => {
    const key = discipleKey(hook, c0, c1, i + 1);
    return { id: poolId(key), key };
  });
}

/** One leg of a same-chain source, or the home pool of a cross-chain one. */
export interface SourceLeg {
  kind: "v2" | "v3" | "v4";
  /** v2 pair / v3 pool, or the PoolManager for v4 */
  target: Hex;
  /** v4 pool id (zero for v2/v3) */
  v4Id: Hex;
  /** the base token (the coin on leg 1, X on leg 2) is token0 of this leg */
  baseIs0: boolean;
}

export interface PoolInfo {
  exists: boolean;
  live: boolean;
  /** coin is currency0 of the Disciple pool */
  coinIs0: boolean;
  /** cross-chain local mode (feed down for 2 h; the pool keeps trading on its curve) */
  local: boolean;
  /** Disciple fee in pips (10000 = 1%); the v4 key's fee is always 0 */
  feePips: number;
  coin: Hex;
  /** 0 = same chain; otherwise the LayerZero eid of the home chain the price is pushed from */
  remoteEid: number;
  /** the pools whose state moves this pool's quote (same chain: 1 or 2 legs on this chain) */
  legs: SourceLeg[];
}

const KIND = { 1: "v2", 2: "v3", 3: "v4" } as const;
const byteAt = (w: bigint, i: number): number => Number((w >> BigInt(8 * i)) & 0xffn);
const addrAt = (w: bigint, byteOff: number): Hex =>
  `0x${((w >> BigInt(8 * byteOff)) & ((1n << 160n) - 1n)).toString(16).padStart(40, "0")}`;
const slotHex = (s: bigint): Hex => `0x${s.toString(16).padStart(64, "0")}`;

export function poolBase(id: Hex): bigint {
  return BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, POOLS_SLOT])));
}

/** Decode the pool's head slot and its four Source slots (+0, +2, +3, +4, +5). */
export function decodePoolInfo(head: bigint, s0: bigint, v4Id: bigint, s2: bigint, v4Id2: bigint): PoolInfo {
  const legs: SourceLeg[] = [];
  const k1 = byteAt(s0, 0);
  if (k1 >= 1 && k1 <= 3) {
    legs.push({ kind: KIND[k1 as 1 | 2 | 3], target: addrAt(s0, 6), v4Id: slotHex(v4Id), baseIs0: byteAt(s0, 1) !== 0 });
  }
  const k2 = byteAt(s2, 3);
  if (k2 >= 1 && k2 <= 3) {
    // leg 2's v4 target is unused by the hook; the PoolManager is the same as leg 1's on this chain
    const target2 = k2 === 3 ? legs[0]?.target ?? ZERO : addrAt(s2, 5);
    legs.push({ kind: KIND[k2 as 1 | 2 | 3], target: target2, v4Id: slotHex(v4Id2), baseIs0: byteAt(s2, 4) !== 0 });
  }
  return {
    exists: byteAt(head, 0) !== 0,
    live: byteAt(head, 1) !== 0,
    coinIs0: byteAt(head, 2) !== 0,
    local: byteAt(head, 3) !== 0,
    feePips: Number((head >> 32n) & 0xffffffn),
    coin: addrAt(head, 7),
    remoteEid: Number((s0 >> 16n) & 0xffffffffn),
    legs,
  };
}

export async function readPoolInfo(c: PublicClient, hook: Hex, id: Hex, blockNumber?: bigint): Promise<PoolInfo> {
  const b = poolBase(id);
  const get = async (o: bigint) => BigInt((await c.getStorageAt({ address: hook, slot: slotHex(b + o), blockNumber })) ?? 0);
  const [head, s0, v4, s2, v42] = await Promise.all([get(0n), get(2n), get(3n), get(4n), get(5n)]);
  return decodePoolInfo(head, s0, v4, s2, v42);
}
