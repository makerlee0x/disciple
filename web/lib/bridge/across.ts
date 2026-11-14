/**
 * Across moves between cash and Turbo (Add cash plan, option A, maker 2026-11-14): USDG on Robinhood Chain ⇄ USDC on
 * Arbitrum, filled in about 2 s. Across's blog ("Bridge to Robinhood Chain with Across") lists USDC in → USDG and USDG
 * out → USDC, Arbitrum included.
 *
 * This file is the pure part: the /swap/approval request and turning its answer into the call list lib/wallet
 * execCalls signs (approve + deposit, one sponsored op). The real Nova adapter calls moveQuote() for Load fuel (cash →
 * Turbo, origin = our chain) and for Move to cash (Turbo → cash, origin = Arbitrum, signed on Arbitrum).
 * Field names follow docs.across.to (swap/approval). Re-check them against a live answer before turning on mainnet.
 */
export const ACROSS_API = "https://app.across.to/api";
export const ARBITRUM_ID = 42161;
export const ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;

export type Hex = `0x${string}`;
export type MoveLeg = { originChainId: number; destinationChainId: number; inputToken: string; outputToken: string };
export type MoveQuoteReq = MoveLeg & { amount: bigint; depositor: string; recipient: string; integratorId?: string };
export type Call = { to: Hex; data: Hex; value?: bigint };
export type MoveQuote = {
  calls: Call[];                 // approvals first, then the deposit; all on originChainId
  chainId: number;
  expectedOut: bigint;
  minOut: bigint;
  feeUsd: number | null;         // Across's total fee in dollars, when it says
  fillSec: number | null;
};

/** cash → Turbo and Turbo → cash, for a USDG address on our chain. */
export function legs(chainId: number, usdg: string): { toTurbo: MoveLeg; toCash: MoveLeg } {
  return {
    toTurbo: { originChainId: chainId, destinationChainId: ARBITRUM_ID, inputToken: usdg, outputToken: ARBITRUM_USDC },
    toCash: { originChainId: ARBITRUM_ID, destinationChainId: chainId, inputToken: ARBITRUM_USDC, outputToken: usdg },
  };
}

/** The /swap/approval url for an exact-input move. Pure, tested. */
export function moveQuoteUrl(r: MoveQuoteReq, base = ACROSS_API): string {
  const q = new URLSearchParams({
    tradeType: "exactInput", amount: r.amount.toString(),
    inputToken: r.inputToken, originChainId: String(r.originChainId),
    outputToken: r.outputToken, destinationChainId: String(r.destinationChainId),
    depositor: r.depositor, recipient: r.recipient,
  });
  if (r.integratorId) q.set("integratorId", r.integratorId);
  return `${base}/swap/approval?${q.toString()}`;
}

type TxLike = { chainId?: number; to?: string; data?: string; value?: string | number };
const isHex = (s: unknown): s is Hex => typeof s === "string" && /^0x[0-9a-fA-F]*$/.test(s);
const big = (v: unknown): bigint => { try { return v == null || v === "" ? BigInt(0) : BigInt(v as string); } catch { return BigInt(0); } };
const num = (v: unknown): number | null => { const n = Number(v); return v != null && Number.isFinite(n) ? n : null; };

/** Across's answer → the calls to sign. Throws on a shape we don't understand (never sends a half-read tx). Pure. */
export function parseMoveQuote(j: unknown, expectChainId: number): MoveQuote {
  const o = (j ?? {}) as { approvalTxns?: TxLike[]; swapTx?: TxLike; expectedOutputAmount?: string; minOutputAmount?: string;
    fees?: { total?: { amountUsd?: string | number } }; expectedFillTime?: number };
  const txs = [...(o.approvalTxns ?? []), ...(o.swapTx ? [o.swapTx] : [])];
  if (!o.swapTx || txs.length === 0) throw new Error("across: no swapTx");
  const calls = txs.map((t) => {
    if (!isHex(t.to) || t.to.length !== 42 || !isHex(t.data)) throw new Error("across: bad tx");
    if (t.chainId != null && t.chainId !== expectChainId) throw new Error("across: wrong chain");
    const value = big(t.value);
    return value > BigInt(0) ? { to: t.to, data: t.data, value } : { to: t.to, data: t.data };
  });
  return { calls, chainId: expectChainId, expectedOut: big(o.expectedOutputAmount), minOut: big(o.minOutputAmount),
    feeUsd: num(o.fees?.total?.amountUsd), fillSec: num(o.expectedFillTime) };
}

/** Fetch + parse a move quote. */
export async function moveQuote(r: MoveQuoteReq, f: typeof fetch = fetch): Promise<MoveQuote> {
  const res = await f(moveQuoteUrl(r));
  if (!res.ok) throw new Error(`across: HTTP ${res.status}`);
  return parseMoveQuote(await res.json(), r.originChainId);
}
