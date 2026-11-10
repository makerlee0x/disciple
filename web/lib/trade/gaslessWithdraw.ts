/**
 * Gasless withdrawals (flow/gasless-withdraw). Copied pattern: 0x Gasless / Permit2 fee-in-token (the same
 * Permit2 SignatureTransfer the gasless trades already use) plus Circle/Gelato pay-gas-in-token.
 * The player signs TWO Permit2 permitTransferFrom messages: (amount − fee) to the destination they typed, and
 * the fee to the relayer. The relayer submits both in one tx through the canonical Multicall3
 * (0xcA11bde05977b3631167028862bE2a173976CA11, already used for graduating-buy reads in gradBuy.ts) and never
 * holds the funds. Spender in the EIP-712 is Multicall3 (msg.sender of the Permit2 calls). If Permit2 is not yet
 * approved for USDG, a one-time EIP-2612 permit (DevToken ERC20Permit) is prepended, the same way gasless trades
 * do it (DiscipleRouter buy/sellWithPermit2AndApprove).
 *
 * Fee = estimated gas × live gas price × the old USDG paymaster's USDG-per-ETH rate (rateFromEnv + unmarkedRate,
 * 1.0x, no markup, no protocol cut), rounded UP to 0.000001 USDG. The quoted fee is kept (no unused-gas refund).
 */
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { GaslessReject, GASLESS_MAX_DEADLINE_SEC, PERMIT2, type Erc2612, type Permit } from "./gaslessPermit2";

/** Canonical Multicall3 (Robinhood Chain testnet 46630; same address as web/lib/server/gradBuy.ts). */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/** 0.000001 USDG — fee rounding unit (lee). */
export const USDG_FEE_DECIMALS = 6;
const WAD = BigInt(10) ** BigInt(18);

/** Two Permit2 transfers + Multicall3 overhead, padded so the relayer is not short (quoted fee is kept). */
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
 * `rate` is USDG base units per 1 ETH, already unmarked (paymasterCore.unmarkedRate / rateFromEnv).
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

export const permitTransferTypes = {
  PermitTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  TokenPermissions: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
} as const;

/** EIP-712 typed data the player signs for one Permit2 transfer. `spender` = Multicall3. */
export function transferTypedData(chainId: number, permit: Permit) {
  return {
    domain: { name: "Permit2", chainId, verifyingContract: PERMIT2 },
    types: permitTransferTypes,
    primaryType: "PermitTransferFrom" as const,
    message: { permitted: permit.permitted, spender: MULTICALL3, nonce: permit.nonce, deadline: permit.deadline },
  };
}

export type GaslessWithdrawRequest = {
  signer: Address;
  destination: Address;
  amount: bigint;
  fee: bigint;
  feeTo: Address;
  netPermit: Permit;
  feePermit: Permit;
  netSignature: Hex;
  feeSignature: Hex;
  approval?: Erc2612;
};

export const permit2TransferAbi = parseAbi([
  "function permitTransferFrom(((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit, (address to,uint256 requestedAmount) transferDetails, address owner, bytes signature)",
]);
export const erc2612PermitAbi = parseAbi([
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
]);
export const multicall3Abi = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

const transferCall = (permit: Permit, to: Address, owner: Address, signature: Hex): Hex =>
  encodeFunctionData({
    abi: permit2TransferAbi,
    functionName: "permitTransferFrom",
    args: [{ permitted: permit.permitted, nonce: permit.nonce, deadline: permit.deadline }, { to, requestedAmount: permit.permitted.amount }, owner, signature],
  });

/** Relayer tx calldata: Multicall3.aggregate3 of [optional USDG.permit, net transfer, fee transfer]. Never holds funds. */
export function encodeWithdrawCall(q: GaslessWithdrawRequest, usdg: Address): Hex {
  const calls: { target: Address; allowFailure: boolean; callData: Hex }[] = [];
  if (q.approval && q.approval.value > BigInt(0)) {
    const a = q.approval;
    calls.push({
      target: usdg,
      allowFailure: false,
      callData: encodeFunctionData({
        abi: erc2612PermitAbi,
        functionName: "permit",
        args: [q.signer, PERMIT2, a.value, a.deadline, a.v, a.r, a.s],
      }),
    });
  }
  const net = q.amount - q.fee;
  calls.push({ target: PERMIT2, allowFailure: false, callData: transferCall(q.netPermit, q.destination, q.signer, q.netSignature) });
  if (q.fee > BigInt(0))
    calls.push({ target: PERMIT2, allowFailure: false, callData: transferCall(q.feePermit, q.feeTo, q.signer, q.feeSignature) });
  void net;
  return encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] });
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
    netPermit: permitOf(o.netPermit ?? {}, "net permit"),
    feePermit: permitOf(o.feePermit ?? {}, "fee permit"),
    netSignature: sig(o.netSignature, "net signature"),
    feeSignature: sig(o.feeSignature, "fee signature"),
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
 * both permits are USDG for the exact net / fee amounts, distinct nonces, live deadlines, optional approval not expired.
 */
export function checkGaslessWithdrawRequest(q: GaslessWithdrawRequest, o: { usdg: Address; usdgDecimals: number; nowSec: number; feeTo: Address; minFee?: bigint }): void {
  if (!eq(q.feeTo, o.feeTo)) throw new GaslessReject("fee recipient is not the relayer");
  if (q.fee < (o.minFee ?? BigInt(0))) throw new GaslessReject("fee too low");
  const min = minWithdrawAmount(q.fee, o.usdgDecimals);
  if (q.amount < min) throw new GaslessReject("amount must exceed the network fee");
  const net = q.amount - q.fee;
  if (!eq(q.netPermit.permitted.token, o.usdg) || !eq(q.feePermit.permitted.token, o.usdg)) throw new GaslessReject("permit token mismatch");
  if (q.netPermit.permitted.amount !== net) throw new GaslessReject("net permit amount mismatch");
  if (q.feePermit.permitted.amount !== q.fee) throw new GaslessReject("fee permit amount mismatch");
  if (q.netPermit.nonce === q.feePermit.nonce) throw new GaslessReject("permit nonces must differ");
  const now = BigInt(o.nowSec), max = now + BigInt(GASLESS_MAX_DEADLINE_SEC);
  for (const d of [q.netPermit.deadline, q.feePermit.deadline]) if (d <= now || d > max) throw new GaslessReject("deadline out of range");
  if (q.approval && q.approval.value > BigInt(0) && q.approval.deadline <= now) throw new GaslessReject("approval expired");
}
