/**
 * Gasless non-trade actions (claims / tramp pull / anon creator transfer) on the same Permit2 + Multicall3
 * relayer path as withdrawals (0x Gasless / Permit2 fee-in-token). The relayer never holds the player's funds.
 *
 * Only actions whose contracts already have an on-behalf or signature variant, or that are permissionless, are
 * relayable. msg.sender-only functions are rejected here (see blockedActionMessage) and are not given a new
 * login or trade mechanism.
 */
import { decodeFunctionData, encodeFunctionData, toFunctionSelector, type Address, type Hex } from "viem";
import { ACTIVE_CHAIN, deployment } from "../chains";
import { ANON_ADDONS } from "../anon";
import { GaslessReject, PERMIT2, type Erc2612, type Permit } from "./gaslessPermit2";
import {
  erc2612PermitAbi, microUsdg, multicall3Abi, permit2TransferAbi,
  WITHDRAW_GAS_PAD, WITHDRAW_GAS_PERMIT,
} from "./gaslessWithdraw";
import { callsHash, encodeForwarderAction, type ForwarderAction, type ForwarderCall } from "./permitForwarder";

export { MULTICALL3, transferTypedData, withdrawFeeRaw, minWithdrawAmount } from "./gaslessWithdraw";

/**
 * anonClaim: every relayable claim (name kept for old clients): the anon claimManyBySig variants plus, maker 2026-11-19
 * (players hold USDG only), the public claims on the rebuilt contracts. Those pay the coin creator's Pays to / the
 * referrer / the holder whoever sends them, so the relayer can.
 * creatorEdit: a wallet coin's creator signs (Launchpad transferCreatorBySig / updateMetadataBySig, CreatorFeeHarvest
 * setCreatorFeeRecipientBySig) and the relayer sends it.
 */
export const ACTION_KINDS = ["anonClaim", "anonTransferCreator", "anonCreatorMeta", "trampPull", "creatorEdit"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const SEL = {
  claimManyBySig: toFunctionSelector("claimManyBySig((address,address[],address,uint256,uint256,bytes))"),
  /** lp-accrue CurveFeeVault: a private coin's curve-phase creator fees, same Claim struct as claimManyBySig. */
  claimManyAsStealthBySig: toFunctionSelector("claimManyAsStealthBySig((address,address[],address,uint256,uint256,bytes))"),
  transferCreatorBySig: toFunctionSelector("transferCreatorBySig(address,address,uint256,bytes)"),
  /** Rewards panel coin info (private coins): AnonLauncher.updateMetadataBySig, signed by the stealth owner. */
  updateMetadataBySig: toFunctionSelector("updateMetadataBySig(address,string,string,string,uint256,bytes)"),
  pull: toFunctionSelector("pull(uint256)"),
  // public claims (rebuilt contracts, maker 2026-11-19)
  claimCreatorFees: toFunctionSelector("claimCreatorFees(address)"),
  claimCreatorTokenFees: toFunctionSelector("claimCreatorTokenFees(address)"),
  claimReferrerFeesFor_2143: toFunctionSelector("claimReferrerFeesFor_2143(address,address)"),
  vaultClaimReferrerFeesFor: toFunctionSelector("claimReferrerFeesFor(address,address,address[])"),
  claimFor: toFunctionSelector("claimFor(address,address)"),
  setCreatorFeeRecipientBySig: toFunctionSelector("setCreatorFeeRecipientBySig(address,address,uint256,bytes)"),
  /** FeeRouter and CurveFeeVault share this signature: a past creator's unclaimed fees move to the current creator. */
  sweepPastCreatorFees: toFunctionSelector("sweepPastCreatorFees_1311(address,address)"),
} as const;

/** Public claim selectors (anyone may send; the money goes where the contract says). */
export const PUBLIC_CLAIM_SELECTORS: readonly Hex[] = [
  SEL.claimCreatorFees, SEL.claimCreatorTokenFees, SEL.claimReferrerFeesFor_2143, SEL.vaultClaimReferrerFeesFor, SEL.claimFor,
  SEL.sweepPastCreatorFees,
];

/** Conservative gas units for the quoted USDG fee (quoted fee is kept; unused gas is not refunded). */
export const ACTION_GAS = {
  anonClaim: BigInt(250_000),
  anonClaimPerExtra: BigInt(150_000),
  anonTransferCreator: BigInt(120_000),
  /** image + description + socials strings land in Launchpad storage (≤ ~1.2 KB): sized for the longest allowed text */
  anonCreatorMeta: BigInt(420_000),
  trampPull: BigInt(550_000),
  /** the longest edit: Launchpad.updateMetadataBySig with the longest allowed text */
  creatorEdit: BigInt(450_000),
} as const;
export const ACTION_TX_GAS_LIMIT = {
  anonClaim: BigInt(3_000_000),
  anonTransferCreator: BigInt(300_000),
  anonCreatorMeta: BigInt(900_000),
  trampPull: BigInt(900_000),
  creatorEdit: BigInt(900_000),
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
    : kind === "anonCreatorMeta" ? ACTION_GAS.anonCreatorMeta
    : kind === "creatorEdit" ? ACTION_GAS.creatorEdit
    : ACTION_GAS.trampPull;
  return body + (needsPermit ? WITHDRAW_GAS_PERMIT : 0n) + WITHDRAW_GAS_PAD;
}

export function actionTxGasLimit(kind: ActionKind, callCount = 1): bigint {
  if (kind !== "anonClaim") return ACTION_TX_GAS_LIMIT[kind];
  // Claim all: one tx for every row; a pool claim pays out both sides, so room per call
  const n = BigInt(Math.max(1, callCount | 0));
  const g = ACTION_TX_GAS_LIMIT.anonClaim + BigInt(400_000) * (n - 1n);
  return g > BigInt(12_000_000) ? BigInt(12_000_000) : g;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** the active chain's AnonLauncher (v2) or the legacy v1 one */
const isAnonLauncher = (a: string) => { const x = ANON_ADDONS[ACTIVE_CHAIN.id]; return [x?.anonLauncher, x?.anonLauncherLegacy].some((v) => !!v && eq(v, a)); };
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
    [toFunctionSelector("updateMetadata(address,string,string,string)")]: "Launchpad.updateMetadata(address,string,string,string)",
    [toFunctionSelector("placeTramp(address,int24,int24,uint256,uint128,uint256)")]: "TrampWallManager.placeTramp",
    [toFunctionSelector("placeWall(address,int24,int24,uint256,uint128,uint256)")]: "TrampWallManager.placeWall",
    [toFunctionSelector("cancel(uint256)")]: "TrampWallManager.cancel(uint256)",
    [toFunctionSelector("withdraw(uint256[])")]: "UsdgDepositNotifier.withdraw(uint256[])",
    [toFunctionSelector("deposit(address,uint256)")]: "UsdgDepositNotifier.deposit(address,uint256)",
    [toFunctionSelector("approve(address,uint256)")]: "ERC20.approve (token pull for tramp / deposit)",
    [toFunctionSelector("claimMany(address[],address)")]: "AnonLauncher.claimMany(address[],address) — use claimManyBySig instead",
    [toFunctionSelector("claimCreatorFeesAsStealth(address,address)")]: "CurveFeeVault.claimCreatorFeesAsStealth(address,address) — use claimManyAsStealthBySig instead",
  };
  return map[s] ?? `unknown selector ${s}`;
}

export function blockedCallsMessage(calls: ActionCall[]): string {
  const fns = [...new Set(calls.map((c) => describeBlockedCall(c.data)))];
  return blockedActionMessage(fns.join(", "));
}

const isSet = (a?: string) => !!a && !/^0x0{40}$/i.test(a);
/** Contracts a public claim may go to. `extra`: a coin's own vault / hook the server read on-chain (older coins). */
function isClaimTarget(s: Hex, to: Address, extra?: ReadonlySet<string>): boolean {
  const d = deployment();
  const known = (a?: string) => isSet(a) && eq(a!, to);
  if (extra?.has(to.toLowerCase())) return s === SEL.claimCreatorFees || s === SEL.vaultClaimReferrerFeesFor || s === SEL.sweepPastCreatorFees;
  if (s === SEL.sweepPastCreatorFees) return known(d.feeRouter) || known(d.curveFeeVault);
  if (s === SEL.claimCreatorFees) return known(d.feeRouter) || known(d.curveFeeVault) || known(d.hook);
  if (s === SEL.claimCreatorTokenFees || s === SEL.claimReferrerFeesFor_2143) return known(d.feeRouter);
  if (s === SEL.vaultClaimReferrerFeesFor) return known(d.curveFeeVault);
  if (s === SEL.claimFor) return known(d.launchpad);
  return false;
}

export function isRelayableCall(kind: ActionKind, c: ActionCall, extra?: ReadonlySet<string>): boolean {
  const s = selOf(c.data);
  // Audit 2026-11-21 C-1: every selector is tied to its contract. Before, claimManyBySig / claimManyAsStealthBySig /
  // transferCreatorBySig were accepted at ANY address, so a no-USDG wallet's free claim could aim the relayer at its own
  // gas-burning contract.
  if (kind === "anonClaim") {
    if (s === SEL.claimManyBySig) return isAnonLauncher(c.to);
    if (s === SEL.claimManyAsStealthBySig) {
      const v = deployment().curveFeeVault;
      return (isSet(v) && eq(c.to, v)) || !!extra?.has(c.to.toLowerCase());
    }
    return isClaimTarget(s, c.to, extra);
  }
  if (kind === "anonTransferCreator") return s === SEL.transferCreatorBySig && isAnonLauncher(c.to);
  if (kind === "anonCreatorMeta") return s === SEL.updateMetadataBySig && isAnonLauncher(c.to);
  if (kind === "creatorEdit") {
    const d = deployment();
    if (s === SEL.transferCreatorBySig || s === SEL.updateMetadataBySig) return isSet(d.launchpad) && eq(c.to, d.launchpad);
    return s === SEL.setCreatorFeeRecipientBySig && isSet(d.creatorFeeHarvest) && eq(c.to, d.creatorFeeHarvest);
  }
  return s === SEL.pull && eq(c.to, deployment().trampWallManager);
}

/**
 * A hidden coin's own action, signed by its stealth key: AnonLauncher edit info, creator transfer, or a stealth claim
 * (claimManyBySig / claimManyAsStealthBySig). These never carry a USDG fee from the player's wallet: a fee permit puts
 * the wallet (Permit2 owner, ActionRelayed.owner) in the same tx as the hidden coin (audit 2026-11-21). The relay sends
 * them fee-free and puts the gas on the account's private anon tab (lib/server/launchTab), like a hidden launch.
 */
export function isStealthAction(q: { kind: unknown; calls?: unknown }): boolean {
  if (q.kind === "anonCreatorMeta" || q.kind === "anonTransferCreator") return true;
  if (q.kind !== "anonClaim" || !Array.isArray(q.calls) || !q.calls.length) return false;
  return q.calls.every((c) => {
    const d = (c as { data?: unknown } | null)?.data;
    if (typeof d !== "string") return false;
    const s = d.slice(0, 10).toLowerCase();
    return s === SEL.claimManyBySig || s === SEL.claimManyAsStealthBySig;
  });
}

/** Most calls one relayed action may carry (a claim batches its coins inside one call, so a few is plenty). */
export const MAX_ACTION_CALLS = 8;

/** A stealth claim's coins (ClaimReq.tokens), for the server's own-vault read. */
export function stealthClaimTokens(c: ActionCall): Address[] {
  const s = selOf(c.data);
  if (s !== SEL.claimManyBySig && s !== SEL.claimManyAsStealthBySig) return [];
  try {
    const dec = decodeFunctionData({ abi: claimAbi, data: c.data });
    return [...((dec.args[0] as { tokens: readonly Address[] }).tokens ?? [])].slice(0, 32);
  } catch { return []; }
}

/** A public claim's coin (first address argument), for the server's own-vault / own-hook read. */
export function claimTokenArg(c: ActionCall): Address | null {
  const s = selOf(c.data);
  if ((s !== SEL.claimCreatorFees && s !== SEL.sweepPastCreatorFees) || c.data.length < 74) return null;
  return (`0x${c.data.slice(34, 74)}`) as Address;
}

export function partitionRelayableCalls(kind: ActionKind, calls: ActionCall[]): { relayable: ActionCall[]; blocked: ActionCall[] } {
  const relayable: ActionCall[] = [], blocked: ActionCall[] = [];
  for (const c of calls) (isRelayableCall(kind, c) ? relayable : blocked).push(c);
  return { relayable, blocked };
}

const claimReqInputs = [{ name: "c", type: "tuple", components: [
  { name: "owner", type: "address" }, { name: "tokens", type: "address[]" }, { name: "to", type: "address" },
  { name: "relayerFeeBps", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "sig", type: "bytes" },
] }] as const;
const claimAbi = [
  { type: "function", name: "claimManyBySig", stateMutability: "nonpayable", inputs: claimReqInputs, outputs: [] },
  { type: "function", name: "claimManyAsStealthBySig", stateMutability: "nonpayable", inputs: claimReqInputs, outputs: [] },
] as const;

/** claimManyBySig / claimManyAsStealthBySig payout `to` must be the session wallet (the current UI always pays `me`). */
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
  if (o.calls.length > MAX_ACTION_CALLS) throw new GaslessReject("too many calls in one request");
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

export function checkGaslessActionRequest(q: GaslessActionRequest, o: { usdg: Address; usdgDecimals: number; nowSec: number; feeTo: Address; minFee?: bigint; extraTargets?: ReadonlySet<string> }): void {
  if (!q.calls.length) throw new GaslessReject("no calls");
  for (const c of q.calls) {
    if (!isRelayableCall(q.kind, c, o.extraTargets)) throw new GaslessReject(`call is not a relayable ${q.kind} (${describeBlockedCall(c.data)})`);
  }
  if (q.kind === "anonClaim") {
    for (const c of q.calls) {
      const s = selOf(c.data);
      if (s !== SEL.claimManyBySig && s !== SEL.claimManyAsStealthBySig) continue; // public claims pay where the contract says
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

/** The relayed calls as the forwarder sees them (and hashes into the signed witness). */
export const forwarderCalls = (calls: readonly ActionCall[]): ForwarderCall[] => calls.map((c) => ({ target: c.to, data: c.data }));
/** The fee witness for a forwarder action: the fee recipient and exactly these calls. */
export const actionWitness = (q: Pick<GaslessActionRequest, "feeTo" | "calls">): ForwarderAction => ({ feeTo: q.feeTo, callsHash: callsHash(forwarderCalls(q.calls)) });

/**
 * Relayer tx calldata for the forwarder (a fee is due): DisciplePermitForwarder.action pays the signed fee to the signed
 * fee recipient and runs exactly the signed calls. A fee of 0 has no Permit2 signature at all and keeps encodeActionCall.
 */
export function encodeForwarderActionCall(q: GaslessActionRequest): Hex {
  if (!(q.fee > 0n) || !q.feePermit || !q.feeSignature) throw new GaslessReject("fee permit required");
  return encodeForwarderAction({ permit: q.feePermit, a: actionWitness(q), calls: forwarderCalls(q.calls), owner: q.signer, signature: q.feeSignature, approval: q.approval });
}

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
