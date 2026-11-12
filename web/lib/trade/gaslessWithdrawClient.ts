/**
 * Gasless withdraw, client side. The Privy embedded EOA signs one Permit2 witness that binds the destination
 * and the fee (and, on the first USDG withdrawal, an EIP-2612 permit of USDG to PERMIT2), then POSTs /api/gasless.
 */
import { type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import { ACTIVE_CHAIN } from "../chains";
import { bigintToDecimal, GASLESS_MAX_DEADLINE_SEC, jsonSafe, PERMIT2, type Permit } from "./gaslessPermit2";
import { permitFor, permit2NonceBook, GaslessError, type GaslessSendResult } from "./gaslessClient";
import { withdrawTypedData, type GaslessWithdrawRequest } from "./gaslessWithdraw";

export type WithdrawQuote = {
  fee: bigint;
  feeTo: Address;
  gas: bigint;
  gasPrice: bigint;
  rate: bigint;
  usdg: Address;
  usdgDecimals: number;
  minAmount: bigint;
  spender: Address;
  permit2: Address;
};

export function parseWithdrawQuote(x: unknown): WithdrawQuote {
  const o = (x ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const b = (v: unknown) => (typeof v === "bigint" ? v : BigInt(String(v)));
  return {
    fee: b(o.fee), feeTo: o.feeTo, gas: b(o.gas), gasPrice: b(o.gasPrice), rate: b(o.rate),
    usdg: o.usdg, usdgDecimals: Number(o.usdgDecimals), minAmount: b(o.minAmount),
    spender: o.spender, permit2: o.permit2 ?? PERMIT2,
  };
}

/** POST disciple_gaslessWithdrawQuote — no signature, no identity token. */
export async function quoteGaslessWithdraw(input: { amount?: bigint; signer?: Address } = {}, url = "/api/gasless", fetchFn: typeof fetch = fetch): Promise<WithdrawQuote> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "disciple_gaslessWithdrawQuote", params: [JSON.parse(JSON.stringify(input, bigintToDecimal))] });
  const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  const j = await r.json().catch(() => ({})) as { result?: unknown; error?: { message?: string; data?: GaslessError["data"] } };
  if (!j.result) throw new GaslessError(j.error?.message ?? `withdraw quote HTTP ${r.status}`, j.error?.data ?? {}, r.status);
  return parseWithdrawQuote(j.result);
}

/** Build + sign one gasless withdraw request (no network beyond reads / the optional EIP-2612 permit). */
export async function signGaslessWithdraw(pc: PublicClient, owner: LocalAccount, a: { amount: bigint; destination: Address; quote: WithdrawQuote; nowSec?: number }): Promise<GaslessWithdrawRequest> {
  const now = BigInt(a.nowSec ?? Math.floor(Date.now() / 1000));
  const deadline = now + BigInt(GASLESS_MAX_DEADLINE_SEC - 30);
  const fee = a.quote.fee;
  const [nonce, approval] = await Promise.all([permit2NonceBook(pc).next(owner.address), permitFor(pc, owner, a.quote.usdg, deadline)]);
  const permit: Permit = { permitted: { token: a.quote.usdg, amount: a.amount }, nonce, deadline };
  const w = { to: a.destination, fee, feeTo: a.quote.feeTo };
  const signature = await owner.signTypedData(jsonSafe(withdrawTypedData(ACTIVE_CHAIN.id, permit, w, a.quote.spender)));
  return { signer: owner.address, destination: a.destination, amount: a.amount, fee, feeTo: a.quote.feeTo, permit, signature, ...(approval ? { approval } : {}) };
}

const json = (q: GaslessWithdrawRequest) => JSON.stringify(q, bigintToDecimal);

/** POST one signed withdraw; resolves with the receipt or throws GaslessError (data.notSent ⇒ nothing sent). */
export async function submitGaslessWithdraw(q: GaslessWithdrawRequest, url = "/api/gasless", fetchFn: typeof fetch = fetch, idToken?: string | null): Promise<GaslessSendResult> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(idToken ? { "privy-id-token": idToken } : {}) };
  const r = await fetchFn(url, { method: "POST", headers, body: `{"jsonrpc":"2.0","id":1,"method":"disciple_gaslessWithdraw","params":[${json(q)}]}` });
  const j = await r.json().catch(() => ({})) as { result?: { txHash: Hex; success: boolean; receipt: { logs: GaslessSendResult["logs"] }; gasUsed: number; server?: unknown }; error?: { message?: string; data?: GaslessError["data"] } };
  if (!j.result) throw new GaslessError(j.error?.message ?? `gasless withdraw HTTP ${r.status}`, j.error?.data ?? {}, r.status);
  if (!j.result.success) throw new GaslessError("withdraw reverted on-chain", { notSent: false, txHash: j.result.txHash }, r.status);
  return { txHash: j.result.txHash, logs: j.result.receipt.logs, gasUsed: j.result.gasUsed, server: j.result.server };
}

/** Format a USDG raw amount for the Cash confirm / quote line (up to 6 decimals, trimmed). */
export function formatUsdgFee(raw: bigint, decimals: number): string {
  const neg = raw < BigInt(0);
  const n = neg ? -raw : raw;
  const d = Math.max(0, decimals | 0);
  const s = n.toString().padStart(d + 1, "0");
  const i = d ? s.slice(0, -d) : s;
  const f = (d ? s.slice(-d) : "").replace(/0+$/, "");
  return `${neg ? "-" : ""}${i}${f ? "." + f : ""}`;
}
