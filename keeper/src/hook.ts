// Reads a Disciple pool's push source straight from the hook's storage. The hook has no getter for the source,
// so the keeper reads the slots. Layout from `forge inspect DiscipleHook storageLayout`: `pools` is mapping(PoolId => Pool) at slot 1; inside Pool, `src` starts at +2, `obsAt` is +8 (low 8
// bytes), `book.dx` / `book.dy` share +25 (int128 each, v0.2). test/unit.test.ts ("storage layout matches the hook")
// re-checks this against forge when available.
import { encodeAbiParameters, keccak256, type Hex, type PublicClient } from "viem";
import { carryHookAbi, hookAbi, leaderAbi } from "./abi.ts";
import { SRC_V2, SRC_V3, SRC_V4, shift, spotX128 } from "./price.ts";

export const POOLS_SLOT = 1n;
export const OFF = { head: 0n, src0: 2n, srcV4Id: 3n, src2: 4n, obsAt: 8n, bookDx: 25n, bookDy: 25n } as const;

export interface PoolSource {
  kind: number; // 1 v2, 2 v3, 3 v4
  coinIs0: boolean; // coin is token0 of the home source
  remoteEid: number; // home chain eid (0 = same chain: served by the sampler, not pushed)
  target: Hex; // home v2 pair / v3 pool / v4 PoolManager
  v4Id: Hex;
  decShift: number;
  push: boolean;
  kind2?: number; // second leg kind (0 or absent = single-leg source)
}

export interface PoolDyn {
  exists: boolean;
  live: boolean;
  local: boolean;
  anchorX128: bigint;
  obsAt: bigint; // home-chain timestamp of the anchor's observation
  coin: Hex;
  quote: Hex;
  /** the pool's tip jar valued in quote raw units at the centre (jarY + jarX * anchor); tips come only from it */
  jar: bigint;
  traded: boolean; // the pool traded since its last accepted price (book.dx or dy nonzero)
}

/** Jar value in quote raw units at the centre price. */
export const jarValue = (jarX: bigint, jarY: bigint, anchorX128: bigint): bigint => jarY + (jarX * anchorX128) / (1n << 128n);

export function poolBase(id: Hex): bigint {
  return BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, POOLS_SLOT])));
}

const word = (h: Hex | undefined): bigint => (h ? BigInt(h) : 0n);
const slotHex = (s: bigint): Hex => `0x${s.toString(16).padStart(64, "0")}`;
const byteAt = (w: bigint, i: number): number => Number((w >> BigInt(8 * i)) & 0xffn);
const int8 = (b: number): number => (b >= 128 ? b - 256 : b);
const addr = (w: bigint, byteOff: number): Hex =>
  `0x${((w >> BigInt(8 * byteOff)) & ((1n << 160n) - 1n)).toString(16).padStart(40, "0")}`;

async function slot(c: PublicClient, hook: Hex, s: bigint, blockNumber?: bigint): Promise<bigint> {
  return word(await c.getStorageAt({ address: hook, slot: slotHex(s), blockNumber }));
}

/** Decode the Source struct from its first and third slots (and the v4Id slot). */
export function decodeSource(w0: bigint, v4Id: bigint, w2: bigint): PoolSource {
  return {
    kind: byteAt(w0, 0),
    coinIs0: byteAt(w0, 1) !== 0,
    remoteEid: Number((w0 >> 16n) & 0xffffffffn),
    target: addr(w0, 6),
    v4Id: slotHex(v4Id),
    decShift: int8(byteAt(w2, 0)),
    push: byteAt(w2, 2) !== 0,
    kind2: byteAt(w2, 3),
  };
}

export async function readSource(c: PublicClient, hook: Hex, id: Hex): Promise<PoolSource & { exists: boolean }> {
  const b = poolBase(id);
  const [head, w0, v4, w2] = await Promise.all([
    slot(c, hook, b + OFF.head),
    slot(c, hook, b + OFF.src0),
    slot(c, hook, b + OFF.srcV4Id),
    slot(c, hook, b + OFF.src2),
  ]);
  return { exists: (head & 0xffn) !== 0n, ...decodeSource(w0, v4, w2) };
}

export async function readDyn(c: PublicClient, hook: Hex, id: Hex, abi: typeof hookAbi | typeof carryHookAbi = hookAbi): Promise<PoolDyn> {
  const b = poolBase(id);
  const [head, obs, dx, dy, view] = await Promise.all([
    slot(c, hook, b + OFF.head),
    slot(c, hook, b + OFF.obsAt),
    slot(c, hook, b + OFF.bookDx),
    slot(c, hook, b + OFF.bookDy),
    (c.readContract({ address: hook, abi, functionName: "poolState", args: [id] }) as Promise<{ coin: Hex; quote: Hex; anchorX128: bigint; jarX: bigint; jarY: bigint }>).catch(() => null),
  ]);
  return {
    exists: (head & 0xffn) !== 0n,
    live: byteAt(head, 1) !== 0,
    local: byteAt(head, 3) !== 0,
    anchorX128: view?.anchorX128 ?? 0n,
    obsAt: obs & ((1n << 64n) - 1n),
    coin: view?.coin ?? "0x0000000000000000000000000000000000000000",
    quote: view?.quote ?? "0x0000000000000000000000000000000000000000",
    jar: view ? jarValue(view.jarX, view.jarY, view.anchorX128) : 0n,
    traded: dx !== 0n || dy !== 0n,
  };
}

/** v4 PoolManager storage slot of a pool's Slot0 (StateLibrary: keccak256(poolId, POOLS_SLOT = 6)). */
export const v4Slot0 = (v4Id: Hex): Hex => keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [v4Id, 6n]));

/** A same-chain leader's live spot (X128, raw quote per raw coin), as the hook's single-leg read. 0 = unreadable.
 *  Two-leg sources are not read here (0). */
export async function readLeaderSpot(c: PublicClient, s: PoolSource): Promise<bigint> {
  try {
    if (s.kind2) return 0n;
    if (s.kind === SRC_V2) {
      const r = await c.readContract({ address: s.target, abi: leaderAbi, functionName: "getReserves" });
      return shift(s.decShift, spotX128(SRC_V2, r[0], r[1], s.coinIs0));
    }
    if (s.kind === SRC_V3) {
      const r = await c.readContract({ address: s.target, abi: leaderAbi, functionName: "slot0" });
      return shift(s.decShift, spotX128(SRC_V3, r[0], 0n, s.coinIs0));
    }
    if (s.kind === SRC_V4) {
      const w = await c.readContract({ address: s.target, abi: leaderAbi, functionName: "extsload", args: [v4Slot0(s.v4Id)] });
      const sqrtP = BigInt(w) & ((1n << 160n) - 1n);
      return shift(s.decShift, spotX128(SRC_V4, sqrtP, 0n, s.coinIs0));
    }
  } catch {
    /* unreadable leader */
  }
  return 0n;
}
