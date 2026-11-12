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
/**
 * Static conservative limits for a DEPLOYED session trade (gas is charged on actualGasUsed + v0.7's 10%
 * penalty on unused execution gas). The first session trade of a preset skips eth_estimateUserOperationGas.
 * Measured: v4 buy/sell incl. approve + hook ≈ 0.45–0.65M total; session validation
 * (signer + time-range + policy hook) ≈ 0.15M, which still clears Alchemy's 0.4 verification-efficiency floor
 * at this 350k verification limit. A deployed owner op does not — mav2 estimates that verification gas instead.
 * PVG is a legacy sizing/fallback floor only; mav2 measures and buffers it before quoting/signing.
 */
export const STATIC_GAS: GasLimits = { callGasLimit: BigInt(1_800_000), verificationGasLimit: BigInt(350_000), preVerificationGas: BigInt(60_000) };
/**
 * Rundler v0.7 (Alchemy) rejects eth_sendUserOperation when
 * (preOpGas − preVerificationGas) / (verificationGasLimit + paymasterVerificationGasLimit)
 * is below 0.4. Session validation is heavy enough that STATIC_GAS.verificationGasLimit
 * clears that floor. A deployed owner (plain send, no session hook) is not: the live
 * rejection was 350_000 + 250_000 → efficiency 0.2935.
 * Deployed owner ops take the bundler's verification estimate, add this much headroom,
 * then clamp so the same ratio against the estimate stays at or above the target.
 */
export const VERIFICATION_EFFICIENCY_FLOOR_BPS = 4000n;
export const VERIFICATION_EFFICIENCY_TARGET_BPS = 4500n;
export const OWNER_VERIFICATION_HEADROOM_PCT = 10n;

/** Basis points (2935 = 0.2935), same rounding the bundler prints to 4 decimals. */
export function verificationEfficiencyBps(used: bigint, accountLimit: bigint, paymasterLimit: bigint): bigint {
  const denom = accountLimit + paymasterLimit;
  if (denom <= BigInt(0) || used <= BigInt(0)) return BigInt(0);
  return (used * BigInt(10000)) / denom;
}

/**
 * Account verificationGasLimit for an already-deployed owner op.
 * `estimatedVerification` / `estimatedPaymasterVerification` are the bundler's binary-search
 * results (just above gas actually used). `paymasterLimit` is what will be submitted —
 * the quote server still stamps PAYMASTER_GAS.verificationGasLimit.
 * Headroom is OWNER_VERIFICATION_HEADROOM_PCT, clamped so
 * (estV + estPm) / (limit + paymasterLimit) stays at the 0.45 target. Never below the estimate.
 */
export function deployedOwnerVerificationGas(o: {
  estimatedVerification: bigint; estimatedPaymasterVerification: bigint; paymasterLimit: bigint; headroomPct?: bigint;
}): bigint {
  const estV = o.estimatedVerification;
  if (estV <= BigInt(0)) throw new Error("verification estimate missing");
  const headroom = o.headroomPct ?? OWNER_VERIFICATION_HEADROOM_PCT;
  const padded = estV + (estV * headroom) / BigInt(100);
  const used = estV + (o.estimatedPaymasterVerification > BigInt(0) ? o.estimatedPaymasterVerification : BigInt(0));
  const maxTotal = (used * BigInt(10000)) / VERIFICATION_EFFICIENCY_TARGET_BPS;
  const maxAccount = maxTotal > o.paymasterLimit ? maxTotal - o.paymasterLimit : estV;
  const capped = padded < maxAccount ? padded : maxAccount;
  return capped < estV ? estV : capped;
}
/**
 * Live v5 paymaster maxGasPerOp (RH testnet, Nov 6 2026). validatePaymasterUserOp reverts GasLimitAboveCap when
 * PVG + verificationGasLimit + callGasLimit + paymasterVerificationGasLimit + paymasterPostOpGasLimit exceeds it.
 */
export const PAYMASTER_MAX_GAS_PER_OP = BigInt(7_068_712);
/**
 * Deployed owner (send/withdraw) account verification gas. Live RH testnet probes (Nov 6 2026, Alchemy rundler,
 * test wallet 0x8634…d72b, MAv2 single-signer owner validation): 40k fails AA26, 60k passes. Alchemy echoes any
 * non-zero limit it is given and simulates a zero/omitted verificationGasLimit at its 7.2M max, which the v5 cap
 * rejects (AA33 GasLimitAboveCap), so this bound is the effective estimate. 120k ≈ 2× measured need; with the
 * stamped 250k paymaster limit and the 176.1k live used verification, the 10% headroom clamp plans 132k ⇒ 0.461.
 */
export const DEPLOYED_OWNER_VERIFICATION_GAS = BigInt(120_000);
/**
 * Explicit gas fields for a deployed owner op's eth_estimateUserOperationGas request. Omitted fields are simulated at
 * the bundler's maxima (live: 34.21M total → AA33 GasLimitAboveCap). STATIC_GAS call + zero PVG (request a measurement), plus the owner verification
 * bound and the stamped paymaster limits sum to ~2.33M, well under the cap.
 */
export function ownerEstimateBounds(pm: { paymasterVerificationGasLimit: bigint | string; paymasterPostOpGasLimit: bigint | string }, cap: bigint = PAYMASTER_MAX_GAS_PER_OP): GasLimits {
  const b = { ...STATIC_GAS, verificationGasLimit: DEPLOYED_OWNER_VERIFICATION_GAS, preVerificationGas: BigInt(0) };
  const total = b.callGasLimit + b.verificationGasLimit + b.preVerificationGas + BigInt(pm.paymasterVerificationGasLimit) + BigInt(pm.paymasterPostOpGasLimit);
  if (total > cap) throw new Error(`owner estimate bounds ${total} exceed paymaster cap ${cap}`);
  return b;
}
/**
 * Graduating buys (quote ≥ remaining to graduation): Migration + 16 floor bands ≈ 2.76M execution gas (6-dec USDG), above
 * STATIC_GAS and above what a cached normal-buy estimate allows. The trade layer flags their call data
 * (markGradBuy); lib/aa/mav2 then skips STATIC_GAS and the GasCache, always estimates fresh, and never caches the
 * result (the relay accepts it under GRAD_GAS_CAPS, 5M call / 6M total, after its own on-chain check).
 */
const GRAD_HINTS = new Set<string>();
export function markGradBuy(data: string) {
  GRAD_HINTS.add(data.toLowerCase());
  if (GRAD_HINTS.size > 64) GRAD_HINTS.delete(GRAD_HINTS.values().next().value as string);
}
export const isGradBuyCalls = (calls: { data: string }[]) => calls.some((c) => GRAD_HINTS.has(c.data.toLowerCase()));
/**
 * Session + USDG-gas graduating buy: a session op can't be estimated before its signed paymasterData (see mav2), so it
 * gets these static limits instead of STATIC_GAS: 2.76M measured graduating buy (6-dec USDG; 2.56M at 18-dec) + approve/hook/referral ≈ 1.45x headroom.
 * Sum with session verification + PVG + paymaster gas stays under GRAD_GAS_CAPS.total (6M).
 */
export const GRAD_STATIC_GAS: GasLimits = { callGasLimit: BigInt(4_000_000), verificationGasLimit: BigInt(350_000), preVerificationGas: BigInt(60_000) };
/** Execution-gas padding for a graduating session buy estimated with eth_estimateGas(EntryPoint → account.executeBatch):
 *  that direct call skips the session's pre-exec policy hook (it re-quotes the route, ≈ 0.3–0.6M) and the in-op paymaster
 *  approve, and graduation gas varies with curve state ⇒ ×1.25 + 700k. Clamped to [GRAD_STATIC_GAS, GRAD_CALL_GAS_MAX]. */
export const GRAD_EST_PAD_NUM = BigInt(125), GRAD_EST_PAD_ADD = BigInt(700_000);
/** Highest call gas we ever ask for on a graduating buy: + session verification 350k + PVG 60k + paymaster 200k ⇒ 5.21M,
 *  under GRAD_GAS_CAPS (5M call is the server's call cap ⇒ 4.6M keeps 400k spare; total 6M). */
export const GRAD_CALL_GAS_MAX = BigInt(4_600_000);
/** Session USDG-gas graduating buy limits from a real estimate (null / failed ⇒ GRAD_STATIC_GAS). Pure. */
export function gradSessionGas(estimate: bigint | null | undefined): GasLimits {
  if (!estimate || estimate <= BigInt(0)) return GRAD_STATIC_GAS;
  let call = (estimate * GRAD_EST_PAD_NUM) / BigInt(100) + GRAD_EST_PAD_ADD;
  if (call < GRAD_STATIC_GAS.callGasLimit) call = GRAD_STATIC_GAS.callGasLimit;
  if (call > GRAD_CALL_GAS_MAX) call = GRAD_CALL_GAS_MAX;
  return { ...GRAD_STATIC_GAS, callGasLimit: call };
}
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
  /** Drop the cached value (the relayer rejected it as below its fee floor): the next get() fetches fresh fees. */
  invalidate() { this.v = undefined; this.at = 0; }
  private refresh(fetcher: () => Promise<Fees>) {
    return (this.inflight ??= fetcher().then((f) => {
      // base fee is ~flat on RH testnet; 2× maxFee headroom keeps a cached value valid across small base-fee moves
      this.v = { maxFeePerGas: f.maxFeePerGas * BigInt(2), maxPriorityFeePerGas: f.maxPriorityFeePerGas }; this.at = this.clock(); return this.v;
    }).finally(() => { this.inflight = undefined; }));
  }
}

/**
 * Rapid taps: per-send options. `rebuild` re-quotes a trade (fresh quote ⇒ fresh minOut) for the ONE transient-error
 * retry (lagging-node pre-flight, TRANSIENT_SIM) — the original calls were priced before the preceding in-flight ops
 * moved the curve, so re-sending them verbatim would just revert on min-out. Fee-floor retries keep the same calls.
 */
export type SendOpts = {
  rebuild?: () => Promise<Call[]>;
  /** One id per PRESS, kept across its retries (set by sendCalls when absent): the relay doesn't count retries of the
   * same press toward the per-sender limit (spec item 10, lib/server/limits.hitSenderSend). */
  pressId?: string;
};
/** SITE's shape (#144): sendCalls(calls, { rebuild }) — plus the signer / fee-retry switches as options. */
/** tt: trade timing marks (lib/trade/timing, console only); the first attempt only. */
export type SendCallsOpts = SendOpts & { as?: "owner" | "session"; feeRetry?: boolean; tt?: import("../trade/timing").TradeTiming };
/** GAME: every error a press throws carries its pressId: AAError ⇒ extra.pressId; any object error ⇒ .pressId too.
 * Duck-typed (no AAError import) so this module stays light. */
export function tagPress(e: unknown, pressId: string) {
  if (!e || typeof e !== "object") return;
  const x = e as { extra?: Record<string, unknown>; code?: unknown; pressId?: string };
  try {
    if ("extra" in x && "code" in x) x.extra = { ...(x.extra ?? {}), pressId };
    x.pressId = pressId;
  } catch { /* frozen */ }
}
export function newPressId(): string {
  const a = new Uint8Array(12); (globalThis.crypto as Crypto).getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}
/**
 * The calls to retry with: rebuild() when given and it keeps the same shape (same targets + selectors ⇒ same gas class
 * and the same session-policy decision); otherwise (no rebuild, it threw, or the shape changed) the original calls.
 */
export async function retryCalls(calls: Call[], o: SendOpts = {}): Promise<Call[]> {
  if (!o.rebuild) return calls;
  try {
    const next = await o.rebuild();
    if (next.length && callsKind(next) === callsKind(calls)) return next;
    console.warn("[aa] rebuild changed the call shape; retrying the original calls");
  } catch (e) {
    console.warn("[aa] rebuild failed; retrying the original calls:", (e as Error)?.message ?? e);
  }
  return calls;
}

/**
 * AUDIT Info: a rebuilt (re-quoted) trade may never accept a WORSE price than the press's original minOut (quote taken
 * at press time − the user's slippage). fresh < original ⇒ throw: retryCalls then keeps the ORIGINAL calls (same minOut,
 * so the chain still enforces the user's bound). fresh ≥ original ⇒ the fresh (tighter-or-equal) bound.
 */
export function boundRebuiltMinOut(original: bigint, fresh: bigint): bigint {
  if (fresh < original) throw Object.assign(new Error(`rebuilt minOut ${fresh} below the press's minOut ${original}`), { code: "RebuildWorsePrice" });
  return fresh;
}
