/**
 * Client for gasless non-trade actions. The Privy EOA signs an optional USDG fee Permit2 (same helper as withdrawals)
 * plus any contract-side EIP-712 (claimManyBySig / transferCreatorBySig already signed by the caller). POST /api/gasless.
 */
import { type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import { ACTIVE_CHAIN } from "../chains";
import { clientGaslessMode } from "../aa/sponsorshipMode";
import { bigintToDecimal, GASLESS_MAX_DEADLINE_SEC, jsonSafe, PERMIT2 } from "./gaslessPermit2";
import { permitFor, permit2NonceBook, GaslessError, type GaslessSendResult } from "./gaslessClient";
import { gaslessSigner } from "../wallet";
import { privyIdentityToken } from "../aa/session";
import { formatUsdgFee } from "./gaslessWithdrawClient";
import {
  parseGaslessActionRequest, transferTypedData, type ActionCall, type ActionKind, type GaslessActionRequest,
} from "./gaslessAction";
import type { Permit } from "./gaslessPermit2";

export type ActionQuote = {
  kind: ActionKind;
  fee: bigint;
  feeTo: Address;
  gas: bigint;
  gasPrice: bigint;
  rate: bigint;
  usdg: Address;
  usdgDecimals: number;
  spender: Address;
  permit2: Address;
  keeperTipBps: number;
};

export function parseActionQuote(x: unknown): ActionQuote {
  const o = (x ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const b = (v: unknown) => (typeof v === "bigint" ? v : BigInt(String(v)));
  return {
    kind: o.kind, fee: b(o.fee ?? 0), feeTo: o.feeTo, gas: b(o.gas ?? 0), gasPrice: b(o.gasPrice ?? 0), rate: b(o.rate ?? 0),
    usdg: o.usdg, usdgDecimals: Number(o.usdgDecimals), spender: o.spender, permit2: o.permit2 ?? PERMIT2,
    keeperTipBps: Number(o.keeperTipBps ?? 0),
  };
}

export function formatActionFeeNote(q: ActionQuote): string {
  if (q.kind === "trampPull") {
    const bps = q.keeperTipBps;
    const pct = (bps / 100).toFixed(bps % 100 === 0 ? 0 : 2);
    return `A ${pct}% keeper tip comes out of the proceeds (no extra USDG network fee).`;
  }
  return `Network fee $${formatUsdgFee(q.fee, q.usdgDecimals)} in USDG.`;
}

export async function quoteGaslessAction(input: { kind: ActionKind; signer?: Address; callCount?: number; calls?: ActionCall[] } = { kind: "anonClaim" }, url = "/api/gasless", fetchFn: typeof fetch = fetch): Promise<ActionQuote> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "disciple_gaslessActionQuote", params: [JSON.parse(JSON.stringify(input, bigintToDecimal))] });
  const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  const j = await r.json().catch(() => ({})) as { result?: unknown; error?: { message?: string; data?: GaslessError["data"] } };
  if (!j.result) throw new GaslessError(j.error?.message ?? `action quote HTTP ${r.status}`, j.error?.data ?? {}, r.status);
  return parseActionQuote(j.result);
}

export async function signActionFee(pc: PublicClient, owner: LocalAccount, q: ActionQuote): Promise<Pick<GaslessActionRequest, "fee" | "feeTo" | "feePermit" | "feeSignature" | "approval">> {
  if (q.fee === 0n) return { fee: 0n, feeTo: q.feeTo };
  const now = BigInt(Math.floor(Date.now() / 1000));
  const deadline = now + BigInt(GASLESS_MAX_DEADLINE_SEC - 30);
  const book = permit2NonceBook(pc);
  const [nonce, approval] = await Promise.all([book.next(owner.address), permitFor(pc, owner, q.usdg, deadline)]);
  const feePermit: Permit = { permitted: { token: q.usdg, amount: q.fee }, nonce, deadline };
  const feeSignature = await owner.signTypedData(jsonSafe(transferTypedData(ACTIVE_CHAIN.id, feePermit)));
  return { fee: q.fee, feeTo: q.feeTo, feePermit, feeSignature, ...(approval ? { approval } : {}) };
}

export async function submitGaslessAction(q: GaslessActionRequest, url = "/api/gasless", fetchFn: typeof fetch = fetch, idToken?: string | null): Promise<GaslessSendResult> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(idToken ? { "privy-id-token": idToken } : {}) };
  const r = await fetchFn(url, { method: "POST", headers, body: `{"jsonrpc":"2.0","id":1,"method":"disciple_gaslessAction","params":[${JSON.stringify(q, bigintToDecimal)}]}` });
  const j = await r.json().catch(() => ({})) as { result?: { txHash: Hex; success: boolean; receipt: { logs: GaslessSendResult["logs"] }; gasUsed: number; server?: unknown }; error?: { message?: string; data?: GaslessError["data"] } };
  if (!j.result) throw new GaslessError(j.error?.message ?? `gasless action HTTP ${r.status}`, j.error?.data ?? {}, r.status);
  if (!j.result.success) throw new GaslessError("action reverted on-chain", { notSent: false, txHash: j.result.txHash }, r.status);
  return { txHash: j.result.txHash, logs: j.result.receipt.logs, gasUsed: j.result.gasUsed, server: j.result.server };
}

/** Quote, sign the USDG fee when needed, and submit allowlisted calls. Used by claims / tramp pull. */
export async function sendGaslessAction(kind: ActionKind, calls: ActionCall[], pc: PublicClient, url = "/api/gasless", fetchFn: typeof fetch = fetch): Promise<GaslessSendResult> {
  const owner = gaslessSigner();
  if (!owner) throw new GaslessError("Sign in to continue.");
  if (!calls.length) throw new GaslessError("Nothing to send.");
  const q = await quoteGaslessAction({ kind, signer: owner.address, callCount: calls.length, calls }, url, fetchFn);
  const fee = await signActionFee(pc, owner, q);
  const tokenP = privyIdentityToken().catch(() => null);
  const req = parseGaslessActionRequest({ kind, signer: owner.address, calls, fee: fee.fee, feeTo: fee.feeTo, feePermit: fee.feePermit, feeSignature: fee.feeSignature, approval: fee.approval });
  return submitGaslessAction(req, url, fetchFn, await tokenP);
}

export const gaslessActionsEnabled = () => clientGaslessMode();
