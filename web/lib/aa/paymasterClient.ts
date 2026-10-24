/**
 * Client side of the USDG-gas flow (DisciplePaymaster via /api/paymaster, ERC-7677). Account-agnostic: the caller
 * supplies `build` (calls + paymaster fields → unsigned v0.7 UserOp with gas limits + fees) and `sign`, so the same
 * helper serves Mav2Account (owner or session key) and scripts.
 *
 * Hot path (feat/trade-latency): an AllowanceCache holds the sender's pre-issued per-sender allowance
 * (pm_getPaymasterAllowance) and refreshes it in the background ALLOWANCE_REFRESH_AHEAD_SEC before validUntil. When
 * the built op fits it (tokenCost(maxCost) + debt ≤ maxTokenCost, window still open) payGasInUsdg makes 0 pm_* calls;
 * otherwise (launch, graduating buy, cold estimate, fee spike) it falls back to the two-phase per-op quote.
 *
 * Batch shape (what DiscipleSessionPolicy 1.4.0 and DisciplePaymaster both require):
 *   [ usdg.approve(paymaster, maxTokenCost)  ← exact, FIRST
 *   , ...trade calls ]
 * The approve amount is an upper bound counted against the session's USDG cap; postOp pulls only the actual gas cost
 * (and the rest of the allowance stays unspent — the next op re-approves the exact new amount, overwriting it).
 */
import type { Address, Hex } from "viem";
import type { Call, UserOp } from "./core";
import { ENTRYPOINT_V07 } from "./constants";
import { paymasterApproveCall, requiredMaxTokenCost } from "./paymaster";

export type PaymasterFields = { paymaster: Address; paymasterVerificationGasLimit: Hex; paymasterPostOpGasLimit: Hex; paymasterData: Hex };
type Stub = PaymasterFields & { disciple: { usdg: Address; rate: Hex; maxTokenCost: Hex; debt: Hex; validUntil: number; usdgDecimals: number } };

export class PaymasterRpcError extends Error { constructor(msg: string, public code: number, public data?: unknown) { super(msg); } }

/** Drop any existing approve-to-paymaster and put the exact one first. */
export function withPaymasterApprove(calls: Call[], usdg: Address, paymaster: Address, maxTokenCost: bigint): Call[] {
  const pmWord = paymaster.slice(2).toLowerCase().padStart(64, "0");
  const rest = calls.filter((c) => !(c.to.toLowerCase() === usdg.toLowerCase() && c.data.slice(0, 10).toLowerCase() === "0x095ea7b3" && c.data.slice(10, 74).toLowerCase() === pmWord));
  return [paymasterApproveCall(usdg, paymaster, maxTokenCost), ...rest];
}

async function rpc<T>(url: string, method: string, op: UserOp, chainId: number): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [op, ENTRYPOINT_V07, `0x${chainId.toString(16)}`, {}] }) });
  const j = await r.json().catch(() => ({ error: { code: -32098, message: `paymaster response unreadable (HTTP ${r.status})` } })) as { result?: T; error?: { code: number; message: string; data?: unknown } };
  if (j.error) throw new PaymasterRpcError(j.error.message, j.error.code, j.error.data);
  return j.result as T;
}

export type Allowance = PaymasterFields & {
  disciple: { kind: "allowance"; sender: Address; usdg: Address; rate: Hex; maxTokenCost: Hex; debt: Hex; validUntil: number; validAfter: number; maxFeePerGas: Hex; usdgDecimals: number };
};
/** Refresh this long before validUntil; never USE an allowance closer than ALLOWANCE_MIN_LEFT_SEC to expiry. */
export const ALLOWANCE_REFRESH_AHEAD_SEC = 120;
export const ALLOWANCE_MIN_LEFT_SEC = 20;

/** Per-sender allowance cache: stale-while-revalidate, one in-flight fetch per sender, never blocks a warm trade. */
export class AllowanceCache {
  private m = new Map<string, Allowance>();
  private inflight = new Map<string, Promise<Allowance | undefined>>();
  constructor(private o: { url: string; chainId: number }, private clock: () => number = () => Math.floor(Date.now() / 1000)) {}
  /** Usable allowance now (or undefined); kicks a background refresh when it's within the refresh window / missing. */
  peek(sender: Address): Allowance | undefined {
    const a = this.m.get(sender.toLowerCase());
    const left = a ? a.disciple.validUntil - this.clock() : -1;
    if (left < ALLOWANCE_REFRESH_AHEAD_SEC) void this.refresh(sender).catch(() => undefined);
    return a && left >= ALLOWANCE_MIN_LEFT_SEC && this.clock() >= a.disciple.validAfter ? a : undefined;
  }
  /** Fetch now (deduped). Errors (no USDG, paymaster not configured) leave the cache empty ⇒ per-op flow. */
  refresh(sender: Address): Promise<Allowance | undefined> {
    const k = sender.toLowerCase();
    let p = this.inflight.get(k);
    if (!p) {
      p = this.fetchOne(sender).then((a) => { if (a) this.m.set(k, a); return a; }).finally(() => this.inflight.delete(k));
      this.inflight.set(k, p);
    }
    return p;
  }
  /** Drop it (the chain rejected it: debt appeared, rate bounds moved, signer rotated). */
  invalidate(sender: Address) { this.m.delete(sender.toLowerCase()); }
  set(a: Allowance) { this.m.set(a.disciple.sender.toLowerCase(), a); }
  private async fetchOne(sender: Address): Promise<Allowance | undefined> {
    const r = await fetch(this.o.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "pm_getPaymasterAllowance", params: [sender, ENTRYPOINT_V07, `0x${this.o.chainId.toString(16)}`] }) });
    const j = await r.json().catch(() => ({})) as { result?: Allowance };
    return j.result?.disciple?.kind === "allowance" ? j.result : undefined;
  }
}

/** Does `op` (gas limits + maxFeePerGas already set) fit under the allowance? Mirrors the contract's MaxCostTooLow check. */
export function fitsAllowance(op: UserOp, a: Allowance): boolean {
  const withPm = { ...op, paymasterVerificationGasLimit: a.paymasterVerificationGasLimit, paymasterPostOpGasLimit: a.paymasterPostOpGasLimit };
  return requiredMaxTokenCost(withPm, BigInt(a.disciple.rate), BigInt(a.disciple.debt)) <= BigInt(a.disciple.maxTokenCost);
}

/**
 * Two-phase quote → signed op. `build` must be deterministic for the same calls (same nonce, gas, fees).
 * One re-quote if the final call says the allowance is below the (re-derived) required amount.
 */
export async function payGasInUsdg(o: {
  url: string; chainId: number; usdg: Address; paymaster: Address; calls: Call[];
  build: (calls: Call[], pm: PaymasterFields) => Promise<UserOp>;
  sign: (op: UserOp) => Promise<Hex>;
  /** pre-issued allowance (AllowanceCache.peek): used when the op fits ⇒ no pm_* round trip */
  allowance?: Allowance;
}): Promise<{ op: UserOp; maxTokenCost: bigint; rate: bigint; pmCalls: number }> {
  if (o.allowance && o.allowance.paymaster.toLowerCase() === o.paymaster.toLowerCase()) {
    const a = o.allowance, amount = BigInt(a.disciple.maxTokenCost);
    const op = await o.build(withPaymasterApprove(o.calls, o.usdg, o.paymaster, amount), a);
    if (fitsAllowance(op, a)) {
      const final: UserOp = { ...op, paymaster: a.paymaster, paymasterVerificationGasLimit: a.paymasterVerificationGasLimit, paymasterPostOpGasLimit: a.paymasterPostOpGasLimit, paymasterData: a.paymasterData };
      final.signature = await o.sign(final);
      return { op: final, maxTokenCost: amount, rate: BigInt(a.disciple.rate), pmCalls: 0 };
    }
  }
  // phase 1: size with a placeholder approve of the same calldata length
  const placeholder = withPaymasterApprove(o.calls, o.usdg, o.paymaster, BigInt(0));
  const stubOp = await o.build(placeholder, { paymaster: o.paymaster, paymasterVerificationGasLimit: "0x0", paymasterPostOpGasLimit: "0x0", paymasterData: "0x" });
  const stub = await rpc<Stub>(o.url, "pm_getPaymasterStubData", stubOp, o.chainId);
  let amount = BigInt(stub.disciple.maxTokenCost);
  for (let attempt = 0; ; attempt++) {
    const calls = withPaymasterApprove(o.calls, o.usdg, o.paymaster, amount);
    const op = await o.build(calls, stub);
    try {
      const f = await rpc<PaymasterFields>(o.url, "pm_getPaymasterData", op, o.chainId);
      const final: UserOp = { ...op, ...f };
      final.signature = await o.sign(final);
      return { op: final, maxTokenCost: amount, rate: BigInt(stub.disciple.rate), pmCalls: 2 + attempt };
    } catch (e) {
      const req = (e as PaymasterRpcError).data as { required?: Hex } | undefined;
      if (attempt === 0 && e instanceof PaymasterRpcError && /below required/.test(e.message) && req?.required) { amount = BigInt(req.required); continue; }
      throw e;
    }
  }
}
