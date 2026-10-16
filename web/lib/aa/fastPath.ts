/**
 * Hot-path state for one-tap trades (no RPC on a warm tap):
 *  - NonceCursor: ERC-4337 parallel nonces. MAv2 nonce = (userKey<<40 | entityId<<8 | globalFlag) << 64 | seq.
 *    A fresh userKey per op (random 88-bit page prefix + 64-bit counter, < 2^152) always has seq 0, so the nonce
 *    is known locally and concurrent ops never collide (no queue, no getNonce round trip).
 *  - GasCache: limits per preset kind (as + targets + selectors), from the first estimate × headroom.
 *  - FeeCache: shared fee values, refreshed in the background, never blocking a warm tap.
 */
import type { Call } from "./core";

const MAX152 = (BigInt(1) << BigInt(152)) - BigInt(1);
export class NonceCursor {
  private prefix: bigint; private n = BigInt(0);
  constructor(rand: () => bigint = randomBits) { this.prefix = rand() & ((BigInt(1) << BigInt(88)) - BigInt(1)); }
  /** Next unused 152-bit user key. */
  nextKey(): bigint { this.n += BigInt(1); return ((this.prefix << BigInt(64)) | this.n) & MAX152; }
  /** Full EntryPoint nonce for (entityId, isGlobalValidation) with seq 0. */
  next(entityId: number, isGlobal: boolean): bigint {
    const full = (this.nextKey() << BigInt(40)) + (BigInt(entityId) << BigInt(8)) + (isGlobal ? BigInt(1) : BigInt(0));
    return full << BigInt(64);
  }
}
function randomBits(): bigint {
  const a = new Uint8Array(11); (globalThis.crypto as Crypto).getRandomValues(a);
  return a.reduce((x, b) => (x << BigInt(8)) | BigInt(b), BigInt(0));
}

export type GasLimits = { callGasLimit: bigint; verificationGasLimit: bigint; preVerificationGas: bigint };
/** Same preset ⇒ same shape of calls: targets + selectors (amounts don't change the gas class). */
export const callsKind = (calls: Call[]) => calls.map((c) => `${c.to.toLowerCase()}:${c.data.slice(0, 10)}`).join(",");
export class GasCache {
  private m = new Map<string, GasLimits>();
  /** Headroom: call gas varies with v4 ticks crossed / curve state; verification and PVG are ~constant. */
  set(kind: string, g: GasLimits) {
    this.m.set(kind, { callGasLimit: (g.callGasLimit * BigInt(150)) / BigInt(100), verificationGasLimit: (g.verificationGasLimit * BigInt(120)) / BigInt(100), preVerificationGas: g.preVerificationGas });
  }
  get(kind: string) { return this.m.get(kind); }
  drop(kind: string) { this.m.delete(kind); }
}

export type Fees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
export class FeeCache {
  private v?: Fees; private at = 0; private inflight?: Promise<Fees>;
  constructor(private ttlMs = 3000, private clock: () => number = Date.now) {}
  /** Cached value (any age) for the hot path; refresh kicked off in the background when stale. */
  peek(refresh?: () => Promise<Fees>): Fees | undefined { if (refresh && this.clock() - this.at > this.ttlMs) void this.get(refresh).catch(() => undefined); return this.v; }
  async get(fetcher: () => Promise<Fees>): Promise<Fees> {
    if (this.v && this.clock() - this.at <= this.ttlMs) return this.v;
    if (this.v) { void this.refresh(fetcher).catch(() => undefined); return this.v; }   // stale-while-revalidate
    return this.refresh(fetcher);
  }
  private refresh(fetcher: () => Promise<Fees>) {
    return (this.inflight ??= fetcher().then((f) => {
      // base fee is ~flat on RH testnet; 2× maxFee headroom keeps a cached value valid across small base-fee moves
      this.v = { maxFeePerGas: f.maxFeePerGas * BigInt(2), maxPriorityFeePerGas: f.maxPriorityFeePerGas }; this.at = this.clock(); return this.v;
    }).finally(() => { this.inflight = undefined; }));
  }
}
