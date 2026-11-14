/**
 * Gasless withdrawals (flow/gasless-withdraw). Copied pattern: 0x Gasless / Permit2 fee-in-token plus Circle/Gelato
 * pay-gas-in-token.
 * The player signs ONE Permit2 PermitWitnessTransferFrom for `amount` (net + fee) with spender = GaslessForwarder and a
 * witness naming the destination, the net amount, the fee and the fee recipient (lib/trade/gaslessForwarder). The
 * relayer submits it in one Multicall3.aggregate3 [optional one-time USDG EIP-2612 permit of Permit2, forwarder.withdraw]
 * and never holds the funds; the forwarder can only pay the signed addresses.
 * (Before 2026-11-14 the player signed two plain Permit2 transfers with the public Multicall3 as spender, which let anyone
 * holding an unused signature pick the recipient.)
 *
 * Fee = estimated gas × live gas price × the old USDG paymaster's USDG-per-ETH rate (rateFromEnv + unmarkedRate,
 * 1.0x, no markup, no protocol cut), rounded UP to 0.000001 USDG. The quoted fee is kept (no unused-gas refund).
 */
import { parseAbi, type Address, type Hex } from "viem";
import { GaslessReject, GASLESS_MAX_DEADLINE_SEC, type Erc2612, type Permit } from "./gaslessPermit2";
import { batchWithPermit, erc2612PermitAbi, forwarderWithdrawData, multicall3Abi, withdrawTypedData } from "./gaslessForwarder";

export { erc2612PermitAbi, multicall3Abi };

/** Canonical Multicall3 (the relayer's batcher only, never a Permit2 spender; same address as web/lib/server/gradBuy.ts). */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/** 0.000001 USDG — fee rounding unit (lee). */
export const USDG_FEE_DECIMALS = 6;
const WAD = BigInt(10) ** BigInt(18);

/** Permit2 witness transfer + two token transfers + forwarder + Multicall3 overhead, padded so the relayer is not short (quoted fee is kept). */
export const WITHDRAW_GAS = BigInt(180_000);
/** Extra when a one-time USDG EIP-2612 permit is prepended. */
export const WITHDRAW_GAS_PERMIT = BigInt(50_000);
/** Safety pad on top of the estimate (still no markup on the rate). */
export const WITHDRAW_GAS_PAD = BigInt(20_000);
/** Relayer tx gas cap: enough for permit + two transfers; unused gas is not billed to the player (quoted fee is). */
export const WITHDRAW_TX_GAS_LIMIT = BigInt(300_000);
/** Tiny buffer on top of the fee: minimum withdrawal = fee + this (one micro-USDG). */
export const WITHDRAW_FEE_BUFFER_MICROS = BigInt(1);

export function withdrawGas(needsPermit: boolean): bigint {
  return WITHDRAW_GAS + (needsPermit ? WITHDRAW_GAS_PERMIT : BigInt(0)) + WITHDRAW_GAS_PAD;
}

/** 0.000001 USDG in USDG base units. If the token has fewer than 6 decimals, one base unit. */
export function microUsdg(usdgDecimals: number): bigint {
  const d = BigInt(Math.max(0, usdgDecimals | 0));
  const micro = BigInt(USDG_FEE_DECIMALS);
  return d >= micro ? BigInt(10) ** (d - micro) : BigInt(1);
}

/** ceil(n / d) * d for d > 0. */
const ceilTo = (n: bigint, d: bigint) => ((n + d - BigInt(1)) / d) * d;

/**
 * Fee in USDG base units: ceil(gas × gasPrice × rate / 1e18) to 0.000001 USDG.
 * `rate` is USDG base units per 1 ETH, already unmarked (usdgEthRate.unmarkedRate / rateFromEnv).
 */
export function withdrawFeeRaw(gas: bigint, gasPrice: bigint, rate: bigint, usdgDecimals: number): bigint {
  if (gas < BigInt(0) || gasPrice < BigInt(0) || rate < BigInt(0)) throw new GaslessReject("bad fee inputs");
  const num = gas * gasPrice * rate;
  const raw = (num + WAD - BigInt(1)) / WAD;
  return ceilTo(raw, microUsdg(usdgDecimals));
}

/** Minimum gross amount: fee plus one micro-USDG. */
export function minWithdrawAmount(fee: bigint, usdgDecimals: number): bigint {
  if (fee < BigInt(0)) throw new GaslessReject("bad fee");
  return fee + WITHDRAW_FEE_BUFFER_MICROS * microUsdg(usdgDecimals);
}

/** EIP-712 typed data the player signs: one permit for `amount`, spender = GaslessForwarder, witness = the payouts. */
export function withdrawTypedDataOf(chainId: number, forwarder: Address, q: Pick<GaslessWithdrawRequest, "permit" | "destination" | "amount" | "fee" | "feeTo">) {
  return withdrawTypedData(chainId, forwarder, q.permit, withdrawWitnessOf(q));
}

export const withdrawWitnessOf = (q: Pick<GaslessWithdrawRequest, "destination" | "amount" | "fee" | "feeTo">) =>
  ({ to: q.destination, amount: q.amount - q.fee, fee: q.fee, feeTo: q.feeTo });

export type GaslessWithdrawRequest = {
  signer: Address;
  destination: Address;
  /** Gross: net to the destination + fee. */
  amount: bigint;
  fee: bigint;
  feeTo: Address;
  /** Permit2 permit for exactly `amount`. */
  permit: Permit;
  signature: Hex;
  approval?: Erc2612;
};

export const permit2TransferAbi = parseAbi([
  "function permitTransferFrom(((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit, (address to,uint256 requestedAmount) transferDetails, address owner, bytes signature)",
]);

/** Relayer tx calldata: Multicall3.aggregate3 of [optional USDG.permit, forwarder.withdraw]. Never holds funds. */
export function encodeWithdrawCall(q: GaslessWithdrawRequest, usdg: Address, forwarder: Address): Hex {
  return batchWithPermit(q.signer, usdg, q.approval, forwarder, forwarderWithdrawData(q.permit, q.signer, withdrawWitnessOf(q), q.signature));
}

const ADDR = /^0x[0-9a-fA-F]{40}$/, HEX = /^0x[0-9a-fA-F]*$/;
const big = (v: unknown, what: string): bigint => {
  if (typeof v === "bigint") return v;
  if ((typeof v === "string" && /^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(v)) || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) return BigInt(v);
  throw new GaslessReject(`bad ${what}`);
};
const addr = (v: unknown, what: string): Address => {
  if (typeof v !== "string" || !ADDR.test(v) || /^0x0{40}$/i.test(v)) throw new GaslessReject(`bad ${what}`);
  return v as Address;
};
const sig = (v: unknown, what: string): Hex => {
  if (typeof v !== "string" || !HEX.test(v) || (v.length !== 132 && v.length !== 130)) throw new GaslessReject(`bad ${what}`);
  return v as Hex;
};
const permitOf = (o: Record<string, unknown>, what: string): Permit => {
  const p = (o ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const perm = (p.permitted ?? {}) as Record<string, unknown>;
  return { permitted: { token: addr(perm.token, `${what} token`), amount: big(perm.amount, `${what} amount`) }, nonce: big(p.nonce, `${what} nonce`), deadline: big(p.deadline, `${what} deadline`) };
};

/** JSON (bigints as decimal/hex strings) → typed request. Shape only. */
export function parseGaslessWithdrawRequest(x: unknown): GaslessWithdrawRequest {
  const o = (x ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const q: GaslessWithdrawRequest = {
    signer: addr(o.signer, "signer"),
    destination: addr(o.destination, "destination"),
    amount: big(o.amount, "amount"),
    fee: big(o.fee, "fee"),
    feeTo: addr(o.feeTo, "feeTo"),
    permit: permitOf(o.permit ?? {}, "permit"),
    signature: sig(o.signature, "signature"),
  };
  if (o.approval !== undefined && o.approval !== null) {
    const a = o.approval;
    if (typeof a.r !== "string" || typeof a.s !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(a.r) || !/^0x[0-9a-fA-F]{64}$/.test(a.s) || (a.v !== 27 && a.v !== 28))
      throw new GaslessReject("bad approval");
    q.approval = { value: big(a.value, "approval value"), deadline: big(a.deadline, "approval deadline"), v: a.v, r: a.r, s: a.s };
  }
  return q;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Every rule checked before any RPC so junk never costs a simulation: amount exceeds fee by the micro buffer,
 * the permit is USDG for exactly `amount` (net + fee), a live deadline, optional approval not expired.
 */
export function checkGaslessWithdrawRequest(q: GaslessWithdrawRequest, o: { usdg: Address; usdgDecimals: number; nowSec: number; feeTo: Address; minFee?: bigint }): void {
  if (!eq(q.feeTo, o.feeTo)) throw new GaslessReject("fee recipient is not the relayer");
  if (q.fee < (o.minFee ?? BigInt(0))) throw new GaslessReject("fee too low");
  const min = minWithdrawAmount(q.fee, o.usdgDecimals);
  if (q.amount < min) throw new GaslessReject("amount must exceed the network fee");
  if (!eq(q.permit.permitted.token, o.usdg)) throw new GaslessReject("permit token mismatch");
  if (q.permit.permitted.amount !== q.amount) throw new GaslessReject("permit amount mismatch");
  const now = BigInt(o.nowSec), max = now + BigInt(GASLESS_MAX_DEADLINE_SEC);
  if (q.permit.deadline <= now || q.permit.deadline > max) throw new GaslessReject("deadline out of range");
  if (q.approval && q.approval.value > BigInt(0) && q.approval.deadline <= now) throw new GaslessReject("approval expired");
}
