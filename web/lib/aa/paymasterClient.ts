/**
 * Client side of the USDG-gas flow (DisciplePaymaster via /api/paymaster, ERC-7677). Account-agnostic: the caller
 * supplies `build` (calls + paymaster fields → unsigned v0.7 UserOp with gas limits + fees) and `sign`, so the same
 * helper serves Mav2Account (owner or session key) and scripts. Not yet wired into Mav2Account.sendCalls (see PR).
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
import { paymasterApproveCall } from "./paymaster";

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

/**
 * Two-phase quote → signed op. `build` must be deterministic for the same calls (same nonce, gas, fees).
 * One re-quote if the final call says the allowance is below the (re-derived) required amount.
 */
export async function payGasInUsdg(o: {
  url: string; chainId: number; usdg: Address; paymaster: Address; calls: Call[];
  build: (calls: Call[], pm: PaymasterFields) => Promise<UserOp>;
  sign: (op: UserOp) => Promise<Hex>;
}): Promise<{ op: UserOp; maxTokenCost: bigint; rate: bigint }> {
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
      return { op: final, maxTokenCost: amount, rate: BigInt(stub.disciple.rate) };
    } catch (e) {
      const req = (e as PaymasterRpcError).data as { required?: Hex } | undefined;
      if (attempt === 0 && e instanceof PaymasterRpcError && /below required/.test(e.message) && req?.required) { amount = BigInt(req.required); continue; }
      throw e;
    }
  }
}
