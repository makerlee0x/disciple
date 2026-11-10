/**
 * Gasless non-trade actions (claims / tramp pull / anon creator transfer) on the same Permit2 + Multicall3
 * relayer path as withdrawals (0x Gasless / Permit2 fee-in-token). The relayer never holds the player's funds.
 *
 * Only actions whose contracts already have an on-behalf or signature variant, or that are permissionless, are
 * relayable. msg.sender-only functions are rejected here (see blockedActionMessage) and are not given a new
 * login or trade mechanism.
 */
import { decodeFunctionData, encodeFunctionData, toFunctionSelector, type Address, type Hex } from "viem";
import { deployment } from "../chains";
import { GaslessReject, PERMIT2, type Erc2612, type Permit } from "./gaslessPermit2";
import {
  erc2612PermitAbi, microUsdg, multicall3Abi, permit2TransferAbi,
  WITHDRAW_GAS_PAD, WITHDRAW_GAS_PERMIT,
} from "./gaslessWithdraw";

export { MULTICALL3, transferTypedData, withdrawFeeRaw, minWithdrawAmount } from "./gaslessWithdraw";

export const ACTION_KINDS = ["anonClaim", "anonTransferCreator", "trampPull"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const SEL = {
  claimManyBySig: toFunctionSelector("claimManyBySig((address,address[],address,uint256,uint256,bytes))"),
  transferCreatorBySig: toFunctionSelector("transferCreatorBySig(address,address,uint256,bytes)"),
  pull: toFunctionSelector("pull(uint256)"),
} as const;

/** Conservative gas units for the quoted USDG fee (quoted fee is kept; unused gas is not refunded). */
export const ACTION_GAS = {
  anonClaim: BigInt(250_000),
  anonClaimPerExtra: BigInt(80_000),
  anonTransferCreator: BigInt(120_000),
  trampPull: BigInt(550_000),
} as const;
export const ACTION_TX_GAS_LIMIT = {
  anonClaim: BigInt(800_000),
  anonTransferCreator: BigInt(300_000),
  trampPull: BigInt(900_000),
} as const;

export type ActionCall = { to: Address; data: Hex };
export type GaslessActionRequest = {
  kind: ActionKind;
  signer: Address;
  calls: ActionCall[];
  fee: bigint;
  feeTo: Address;
  feePermit?: Permit;
  feeSignature?: Hex;
  approval?: Erc2612;
};

export function isActionKind(x: unknown): x is ActionKind {
  return typeof x === "string" && (ACTION_KINDS as readonly string[]).includes(x);
}

export function actionGas(kind: ActionKind, callCount = 1, needsPermit = false): bigint {
  const n = BigInt(Math.max(1, callCount | 0));
  const body = kind === "anonClaim" ? ACTION_GAS.anonClaim + ACTION_GAS.anonClaimPerExtra * (n - 1n)
    : kind === "anonTransferCreator" ? ACTION_GAS.anonTransferCreator
    : ACTION_GAS.trampPull;
  return body + (needsPermit ? WITHDRAW_GAS_PERMIT : 0n) + WITHDRAW_GAS_PAD;
}

export function actionTxGasLimit(kind: ActionKind): bigint {
  return ACTION_TX_GAS_LIMIT[kind];
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const selOf = (data: Hex): Hex => (data.slice(0, 10).toLowerCase() as Hex);

/** Human message for a msg.sender-only function that has no on-behalf / signature variant. */
export function blockedActionMessage(fn: string): string {
  return `Can't relay ${fn} gaslessly: the contract only accepts msg.sender as the claimant or owner and has no on-behalf or signature variant. A contract change would be needed; nothing was sent.`;
}

export function describeBlockedCall(data: Hex): string {
  const s = selOf(data);
  const map: Record<string, string> = {
    [toFunctionSelector("claimCreatorFees(address)")]: "FeeRouter.claimCreatorFees(address)",
    [toFunctionSelector("claimCreatorTokenFees(address)")]: "FeeRouter.claimCreatorTokenFees(address)",
    [toFunctionSelector("claimReferrerFees(address)")]: "FeeRouter.claimReferrerFees(address)",
    [toFunctionSelector("claim(address)")]: "Launchpad.claim(address)",
    [toFunctionSelector("claimCreatorFeesToUsdg(address,uint256)")]: "DiscipleRouter.claimCreatorFeesToUsdg(address,uint256)",
    [toFunctionSelector("transferCreator(address,address)")]: "Launchpad.transferCreator(address,address)",
    [toFunctionSelector("placeTramp(address,int24,int24,uint256,uint128,uint256)")]: "TrampWallManager.placeTramp",
    [toFunctionSelector("placeWall(address,int24,int24,uint256,uint128,uint256)")]: "TrampWallManager.placeWall",
    [toFunctionSelector("cancel(uint256)")]: "TrampWallManager.cancel(uint256)",
    [toFunctionSelector("withdraw(uint256[])")]: "UsdgDepositNotifier.withdraw(uint256[])",
    [toFunctionSelector("deposit(address,uint256)")]: "UsdgDepositNotifier.deposit(address,uint256)",
    [toFunctionSelector("approve(address,uint256)")]: "ERC20.approve (token pull for tramp / deposit)",
    [toFunctionSelector("claimMany(address[],address)")]: "AnonLauncher.claimMany(address[],address) — use claimManyBySig instead",
  };
  return map[s] ?? `unknown selector ${s}`;
}

export function blockedCallsMessage(calls: ActionCall[]): string {
  const fns = [...new Set(calls.map((c) => describeBlockedCall(c.data)))];
  return blockedActionMessage(fns.join(", "));
}

export function isRelayableCall(kind: ActionKind, c: ActionCall): boolean {
  const s = selOf(c.data);
  if (kind === "anonClaim") return s === SEL.claimManyBySig;
  if (kind === "anonTransferCreator") return s === SEL.transferCreatorBySig;
  return s === SEL.pull && eq(c.to, deployment().trampWallManager);
}

export function partitionRelayableCalls(kind: ActionKind, calls: ActionCall[]): { relayable: ActionCall[]; blocked: ActionCall[] } {
  const relayable: ActionCall[] = [], blocked: ActionCall[] = [];
  for (const c of calls) (isRelayableCall(kind, c) ? relayable : blocked).push(c);
  return { relayable, blocked };
}

const claimAbi = [{
  type: "function", name: "claimManyBySig", stateMutability: "nonpayable",
  inputs: [{ name: "c", type: "tuple", components: [
    { name: "owner", type: "address" }, { name: "tokens", type: "address[]" }, { name: "to", type: "address" },
    { name: "relayerFeeBps", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "sig", type: "bytes" },
  ] }],
  outputs: [],
}] as const;

/** claimManyBySig payout `to` must be the session wallet (the current UI always pays `me`). */
export function claimPayoutOf(data: Hex): Address {
  const dec = decodeFunctionData({ abi: claimAbi, data });
  const c = dec.args[0] as { to: Address };
  return c.to;
}

export function parseGaslessActionRequest(x: unknown): GaslessActionRequest {
  const o = (x ?? {}) as Record<string, unknown>;
  if (!isActionKind(o.kind)) throw new GaslessReject("unknown gasless action");
  if (typeof o.signer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(o.signer) || /^0x0{40}$/i.test(o.signer))
    throw new GaslessReject("bad signer");
  if (!Array.isArray(o.calls) || o.calls.length < 1) throw new GaslessReject("no calls");
  const calls: ActionCall[] = o.calls.map((c, i) => {
    const r = (c ?? {}) as Record<string, unknown>;
    if (typeof r.to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(r.to)) throw new GaslessReject(`bad call ${i} to`);
    if (typeof r.data !== "string" || !/^0x[0-9a-fA-F]*$/.test(r.data) || r.data.length < 10) throw new GaslessReject(`bad call ${i} data`);
    return { to: r.to as Address, data: r.data as Hex };
  });
  const fee = o.fee == null ? 0n : BigInt(o.fee as string | number | bigint);
  const feeTo = (typeof o.feeTo === "string" && /^0x[0-9a-fA-F]{40}$/.test(o.feeTo) ? o.feeTo : "0x0000000000000000000000000000000000000000") as Address;
  const permitOf = (p: unknown, what: string): Permit | undefined => {
    if (p == null) return undefined;
    const q = p as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const perm = (q.permitted ?? {}) as Record<string, unknown>;
    const token = perm.token, amount = perm.amount, nonce = q.nonce, deadline = q.deadline;
    if (typeof token !== "string") throw new GaslessReject(`bad ${what} token`);
    return { permitted: { token: token as Address, amount: BigInt(amount as string | number | bigint) }, nonce: BigInt(nonce as string | number | bigint), deadline: BigInt(deadline as string | number | bigint) };
  };
  const approval = o.approval == null ? undefined : (() => {
    const a = o.approval as Record<string, unknown>;
    return { value: BigInt(a.value as string | number | bigint), deadline: BigInt(a.deadline as string | number | bigint), v: Number(a.v), r: a.r as Hex, s: a.s as Hex };
  })();
  return {
    kind: o.kind, signer: o.signer as Address, calls, fee, feeTo,
    feePermit: permitOf(o.feePermit, "fee permit"),
    feeSignature: typeof o.feeSignature === "string" ? o.feeSignature as Hex : undefined,
    approval,
  };
}

export function checkGaslessActionRequest(q: GaslessActionRequest, o: { usdg: Address; usdgDecimals: number; nowSec: number; feeTo: Address; minFee?: bigint }): void {
  if (!q.calls.length) throw new GaslessReject("no calls");
  for (const c of q.calls) {
    if (!isRelayableCall(q.kind, c)) throw new GaslessReject(`call is not a relayable ${q.kind} (${describeBlockedCall(c.data)})`);
  }
  if (q.kind === "anonClaim") {
    for (const c of q.calls) {
      if (!eq(claimPayoutOf(c.data), q.signer)) throw new GaslessReject("claim payout must be the signer's wallet");
    }
  }
  const minFee = o.minFee ?? 0n;
  if (q.fee < minFee) throw new GaslessReject("fee changed, please retry");
  if (q.fee === 0n) {
    if (q.feePermit || q.feeSignature) throw new GaslessReject("unexpected fee permit");
    return;
  }
  if (!eq(q.feeTo, o.feeTo)) throw new GaslessReject("fee recipient mismatch");
  if (!q.feePermit || !q.feeSignature) throw new GaslessReject("fee permit required");
  if (!eq(q.feePermit.permitted.token, o.usdg)) throw new GaslessReject("permit token mismatch");
  if (q.feePermit.permitted.amount !== q.fee) throw new GaslessReject("fee permit amount mismatch");
  if (q.feePermit.deadline < BigInt(o.nowSec)) throw new GaslessReject("fee permit expired");
  if (q.approval && q.approval.deadline < BigInt(o.nowSec)) throw new GaslessReject("USDG permit expired");
  void microUsdg(o.usdgDecimals);
}

const transferCall = (permit: Permit, to: Address, owner: Address, signature: Hex): Hex =>
  encodeFunctionData({
    abi: permit2TransferAbi,
    functionName: "permitTransferFrom",
    args: [{ permitted: permit.permitted, nonce: permit.nonce, deadline: permit.deadline }, { to, requestedAmount: permit.permitted.amount }, owner, signature],
  });

/** Multicall3.aggregate3 of [optional USDG.permit, optional fee Permit2 transfer, ...action calls]. */
export function encodeActionCall(q: GaslessActionRequest, usdg: Address): Hex {
  const calls: { target: Address; allowFailure: boolean; callData: Hex }[] = [];
  if (q.approval && q.approval.value > BigInt(0)) {
    const a = q.approval;
    calls.push({
      target: usdg, allowFailure: false,
      callData: encodeFunctionData({ abi: erc2612PermitAbi, functionName: "permit", args: [q.signer, PERMIT2, a.value, a.deadline, a.v, a.r, a.s] }),
    });
  }
  if (q.fee > BigInt(0) && q.feePermit && q.feeSignature) {
    calls.push({ target: PERMIT2, allowFailure: false, callData: transferCall(q.feePermit, q.feeTo, q.signer, q.feeSignature) });
  }
  for (const c of q.calls) calls.push({ target: c.to, allowFailure: false, callData: c.data });
  return encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] });
}
