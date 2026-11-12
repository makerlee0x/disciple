/**
 * Gasless withdrawals (flow/gasless-withdraw). Copied pattern: 0x Gasless / Permit2 fee-in-token (the same
 * Permit2 SignatureTransfer the gasless trades already use) plus Circle/Gelato pay-gas-in-token.
 * The player signs ONE Permit2 PermitWitnessTransferFrom whose spender is GaslessForwarder and whose witness
 * binds the destination, the fee, and the fee recipient (UniswapX / 0x Settler / DiscipleRouter.buyWithPermit2).
 * The relayer submits GaslessForwarder.withdraw; the forwarder pulls the full amount to itself, then sends
 * amount − fee to the signed destination and the fee to the signed relayer. A leaked signature cannot be pointed
 * at a different recipient. If Permit2 is not yet approved for USDG, a one-time EIP-2612 permit is bundled in
 * the same call (same as DiscipleRouter buy/sellWithPermit2AndApprove).
 * transferTypedData / MULTICALL3 below stay for gasless public actions, which still use a Multicall3 fee permit.
 *
 * Fee = estimated gas × live gas price × the old USDG paymaster's USDG-per-ETH rate (rateFromEnv + unmarkedRate,
 * 1.0x, no markup, no protocol cut), rounded UP to 0.000001 USDG. The quoted fee is kept (no unused-gas refund).
 */
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";
import { GaslessReject, GASLESS_MAX_DEADLINE_SEC, PERMIT2, type Erc2612, type Permit } from "./gaslessPermit2";
import { ZERO_ERC2612, gaslessForwarderAbi, gaslessForwarderAddress } from "./gaslessForwarder";

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

export const permitTransferTypes = {
  PermitTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  TokenPermissions: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
} as const;


export const WITHDRAW_TYPE = "Withdraw(address to,uint256 fee,address feeTo)";
export const WITHDRAW_WITNESS_TYPE =
  `Withdraw witness)TokenPermissions(address token,uint256 amount)${WITHDRAW_TYPE}`;
export const WITHDRAW_TYPEHASH = keccak256(toBytes(WITHDRAW_TYPE));

export type WithdrawWitness = { to: Address; fee: bigint; feeTo: Address };

export const withdrawTypes = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Withdraw" },
  ],
  TokenPermissions: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
  Withdraw: [
    { name: "to", type: "address" },
    { name: "fee", type: "uint256" },
    { name: "feeTo", type: "address" },
  ],
} as const;

/** EIP-712 typed data the player signs for a gasless withdraw. spender = GaslessForwarder. */
export function withdrawTypedData(chainId: number, permit: Permit, w: WithdrawWitness, spender: Address = gaslessForwarderAddress(chainId)) {
  return {
    domain: { name: "Permit2", chainId, verifyingContract: PERMIT2 },
    types: withdrawTypes,
    primaryType: "PermitWitnessTransferFrom" as const,
    message: { permitted: permit.permitted, spender, nonce: permit.nonce, deadline: permit.deadline, witness: w },
  };
}

export function withdrawWitnessHash(w: WithdrawWitness): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "address" }],
    [WITHDRAW_TYPEHASH, w.to, w.fee, w.feeTo],
  ));
}

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
  permit: Permit;
  signature: Hex;
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

/** Relayer tx calldata: one GaslessForwarder.withdraw. Optional EIP-2612 is bundled in `approval`. */
export function encodeWithdrawCall(q: GaslessWithdrawRequest, forwarder: Address): Hex {
  const permit = { permitted: q.permit.permitted, nonce: q.permit.nonce, deadline: q.permit.deadline };
  const approval = q.approval && q.approval.value > BigInt(0) ? q.approval : ZERO_ERC2612;
  return encodeFunctionData({
    abi: gaslessForwarderAbi,
    functionName: "withdraw",
    args: [q.signer, permit, { to: q.destination, fee: q.fee, feeTo: q.feeTo }, q.signature, approval],
  });
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
 * both permits are USDG for the exact net / fee amounts, distinct nonces, live deadlines, optional approval not expired.
 */
export function checkGaslessWithdrawRequest(q: GaslessWithdrawRequest, o: { usdg: Address; usdgDecimals: number; nowSec: number; feeTo: Address; minFee?: bigint; forwarder?: Address }): void {
  if (!eq(q.feeTo, o.feeTo)) throw new GaslessReject("fee recipient is not the relayer");
  if (q.fee < (o.minFee ?? BigInt(0))) throw new GaslessReject("fee too low");
  const min = minWithdrawAmount(q.fee, o.usdgDecimals);
  if (q.amount < min) throw new GaslessReject("amount must exceed the network fee");
  if (q.fee >= q.amount) throw new GaslessReject("fee too high");
  if (!eq(q.permit.permitted.token, o.usdg)) throw new GaslessReject("permit token mismatch");
  if (q.permit.permitted.amount !== q.amount) throw new GaslessReject("permit amount mismatch");
  if (o.forwarder && (eq(q.destination, o.forwarder) || (q.fee > BigInt(0) && eq(q.feeTo, o.forwarder)))) {
    throw new GaslessReject("destination cannot be the forwarder");
  }
  const now = BigInt(o.nowSec), max = now + BigInt(GASLESS_MAX_DEADLINE_SEC);
  if (q.permit.deadline <= now || q.permit.deadline > max) throw new GaslessReject("deadline out of range");
  if (q.approval && q.approval.value > BigInt(0) && q.approval.deadline <= now) throw new GaslessReject("approval expired");
}
