/**
 * DisciplePermitForwarder, site side (contracts/src/addons/DisciplePermitForwarder.sol is the on-chain twin).
 *
 * Why (Vercel finding "Public Multicall3 permits let observers redirect gasless withdrawals", 2026-11-14): with the public
 * Multicall3 as the Permit2 spender, Permit2 only checked msg.sender, so whoever held an unused signature could call Permit2
 * through Multicall3 and pick the recipient. The forwarder is the spender instead, and every recipient / fee / fee recipient /
 * relayed call / launch field is in the signed Permit2 witness, so a signature can only do what the player signed.
 *
 * `relaySpender(chainId)` decides per chain: the forwarder when it is deployed (DEPLOYMENTS[..].permitForwarder); otherwise the
 * old Multicall3 path, which is allowed ONLY on Robinhood testnet (46630). On any other chain (mainnet 4663) with no forwarder
 * it throws: the relays never send a Multicall3-spender permit on mainnet.
 */
import { encodeFunctionData, encodeAbiParameters, hashStruct, keccak256, parseAbi, type Address, type Hex } from "viem";
import { DEPLOYMENTS } from "../chains";
import { GaslessReject, PERMIT2, type Erc2612, type Permit } from "./gaslessPermit2";
import { signedLaunch, type AnonLaunch } from "./gaslessAnonLaunch";
import { ANON_ANY_MODE_LIVE } from "../anonModes";

export const MULTICALL3_ADDR = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const ZERO = "0x0000000000000000000000000000000000000000";
const TESTNET = 46630;

export type RelaySpender = { kind: "forwarder"; address: Address } | { kind: "multicall3"; address: typeof MULTICALL3_ADDR };

/** The deployed forwarder for this chain, or null. */
export function forwarderFor(chainId: number): Address | null {
  const a = DEPLOYMENTS[chainId]?.permitForwarder;
  return a && a.toLowerCase() !== ZERO ? a : null;
}

/**
 * Who the player's Permit2 signature names as spender. Throws (nothing is signed or sent) on mainnet without a forwarder.
 * `legacy: false` (the private launch) never falls back to Multicall3, not even on testnet: that path was never working
 * (its witness type string was mis-ordered), and once the string was fixed it would have been exploitable the same way
 * (Vercel finding on PR #384, "Corrected launch witnesses expose payments through the Multicall3 fallback").
 */
export function relaySpender(chainId: number, o: { legacy?: boolean } = {}): RelaySpender {
  const f = forwarderFor(chainId);
  if (f) return { kind: "forwarder", address: f };
  if (chainId === TESTNET && o.legacy !== false) return { kind: "multicall3", address: MULTICALL3_ADDR };
  throw new GaslessReject(o.legacy === false
    ? "Gasless private launches aren't available on this network yet."
    : "Gasless withdrawals and relayed actions aren't available on this network yet.");
}

// ───────── witness types (must match the contract's constants byte for byte) ─────────

export const WITHDRAW_TYPE = "Withdraw(address to,uint256 fee,address feeTo)";
export const WITHDRAW_WITNESS_TYPE = `Withdraw witness)TokenPermissions(address token,uint256 amount)${WITHDRAW_TYPE}`;
export const ACTION_TYPE = "Action(address feeTo,bytes32 callsHash)";
export const ACTION_WITNESS_TYPE = `Action witness)${ACTION_TYPE}TokenPermissions(address token,uint256 amount)`;

const TOKEN_PERMISSIONS = [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] as const;
const permitHead = [
  { name: "permitted", type: "TokenPermissions" }, { name: "spender", type: "address" },
  { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
] as const;

export type ForwarderWithdraw = { to: Address; fee: bigint; feeTo: Address };
export type ForwarderCall = { target: Address; data: Hex };
export type ForwarderAction = { feeTo: Address; callsHash: Hex };

export const withdrawTypes = {
  PermitWitnessTransferFrom: [...permitHead, { name: "witness", type: "Withdraw" }],
  TokenPermissions: TOKEN_PERMISSIONS,
  Withdraw: [{ name: "to", type: "address" }, { name: "fee", type: "uint256" }, { name: "feeTo", type: "address" }],
} as const;

export const actionTypes = {
  PermitWitnessTransferFrom: [...permitHead, { name: "witness", type: "Action" }],
  TokenPermissions: TOKEN_PERMISSIONS,
  Action: [{ name: "feeTo", type: "address" }, { name: "callsHash", type: "bytes32" }],
} as const;

const domain = (chainId: number) => ({ name: "Permit2", chainId, verifyingContract: PERMIT2 });

/** One signature for the whole withdrawal: amount = net + fee; the witness fixes the destination, fee and fee recipient. */
export function withdrawTypedData(chainId: number, forwarder: Address, permit: Permit, w: ForwarderWithdraw) {
  return {
    domain: domain(chainId), types: withdrawTypes, primaryType: "PermitWitnessTransferFrom" as const,
    message: { permitted: permit.permitted, spender: forwarder, nonce: permit.nonce, deadline: permit.deadline, witness: w },
  };
}

/** keccak256(abi.encode(Call[])): what the forwarder checks the relayed calls against. */
export function callsHash(calls: readonly ForwarderCall[]): Hex {
  return keccak256(encodeAbiParameters([{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "data", type: "bytes" }] }], [calls.map((c) => ({ target: c.target, data: c.data }))]));
}

/** The relayed action's fee permit: the witness fixes the fee recipient and exactly which calls run. */
export function actionTypedData(chainId: number, forwarder: Address, permit: Permit, a: ForwarderAction) {
  return {
    domain: domain(chainId), types: actionTypes, primaryType: "PermitWitnessTransferFrom" as const,
    message: { permitted: permit.permitted, spender: forwarder, nonce: permit.nonce, deadline: permit.deadline, witness: a },
  };
}

export const hashWithdraw = (w: ForwarderWithdraw): Hex => hashStruct({ data: w, types: withdrawTypes, primaryType: "Withdraw" });
export const hashAction = (a: ForwarderAction): Hex => hashStruct({ data: a, types: actionTypes, primaryType: "Action" });

// ───────── forwarder calls (what the relayer submits) ─────────

export const forwarderAbi = parseAbi([
  "struct TokenPermissions { address token; uint256 amount; }",
  "struct PermitTransferFrom { TokenPermissions permitted; uint256 nonce; uint256 deadline; }",
  "struct Withdraw { address to; uint256 fee; address feeTo; }",
  "struct Action { address feeTo; bytes32 callsHash; }",
  "struct Call { address target; bytes data; }",
  "struct Approval { uint256 value; uint256 deadline; uint8 v; bytes32 r; bytes32 s; }",
  "struct AnonLaunch { string name; string ticker; string imageURI; string description; string socialsURI; address quote; uint256 creatorTaxBps; uint256 creatorBuyQuoteIn; uint256 creatorBuyMinTokensOut; uint256 deadline; address stealthOwner; address buyRecipient; bytes ephemeralPubKey; bytes1 viewTag; uint256 maxFee; uint256 usdgIn; uint256 minQuoteIn; address refundTo; address launcher; uint8 creatorFeeDestination; }",
  "struct LaunchResult { address token; address curve; uint256 creatorTokensBought; }",
  "function withdraw(PermitTransferFrom permit, Withdraw w, address owner, bytes signature, Approval approval)",
  "function action(PermitTransferFrom permit, Action a, Call[] calls, address owner, bytes signature, Approval approval, address[] sweep)",
  "function launchAnon(PermitTransferFrom permit, AnonLaunch l, address owner, bytes signature, Approval approval) returns (LaunchResult r)",
]);

const NO_APPROVAL = { value: BigInt(0), deadline: BigInt(0), v: 0, r: `0x${"0".repeat(64)}` as Hex, s: `0x${"0".repeat(64)}` as Hex };
const approvalOf = (a?: Erc2612) => (a && a.value > BigInt(0) ? { value: a.value, deadline: a.deadline, v: a.v, r: a.r, s: a.s } : NO_APPROVAL);
const permitArg = (p: Permit) => ({ permitted: p.permitted, nonce: p.nonce, deadline: p.deadline });

export function encodeForwarderWithdraw(o: { permit: Permit; w: ForwarderWithdraw; owner: Address; signature: Hex; approval?: Erc2612 }): Hex {
  return encodeFunctionData({ abi: forwarderAbi, functionName: "withdraw", args: [permitArg(o.permit), o.w, o.owner, o.signature, approvalOf(o.approval)] });
}

export function encodeForwarderAction(o: { permit: Permit; a: ForwarderAction; calls: ForwarderCall[]; owner: Address; signature: Hex; approval?: Erc2612; sweep?: Address[] }): Hex {
  return encodeFunctionData({ abi: forwarderAbi, functionName: "action", args: [permitArg(o.permit), o.a, o.calls, o.owner, o.signature, approvalOf(o.approval), o.sweep ?? []] });
}

/** The modes forwarder's launchAnon: AnonLaunch ends with `uint8 mode` (lib/anonModes ANON_ANY_MODE_LIVE). */
export const forwarderLaunchModesAbi = parseAbi([
  "struct TokenPermissions { address token; uint256 amount; }",
  "struct PermitTransferFrom { TokenPermissions permitted; uint256 nonce; uint256 deadline; }",
  "struct Approval { uint256 value; uint256 deadline; uint8 v; bytes32 r; bytes32 s; }",
  "struct AnonLaunch { string name; string ticker; string imageURI; string description; string socialsURI; address quote; uint256 creatorTaxBps; uint256 creatorBuyQuoteIn; uint256 creatorBuyMinTokensOut; uint256 deadline; address stealthOwner; address buyRecipient; bytes ephemeralPubKey; bytes1 viewTag; uint256 maxFee; uint256 usdgIn; uint256 minQuoteIn; address refundTo; address launcher; uint8 creatorFeeDestination; uint8 mode; }",
  "struct LaunchResult { address token; address curve; uint256 creatorTokensBought; }",
  "function launchAnon(PermitTransferFrom permit, AnonLaunch l, address owner, bytes signature, Approval approval) returns (LaunchResult r)",
]);

export function encodeForwarderLaunch(o: { permit: Permit; l: AnonLaunch; owner: Address; signature: Hex; approval?: Erc2612 }): Hex {
  if (ANON_ANY_MODE_LIVE) {
    const l = { ...signedLaunch(o.l), mode: o.l.mode ?? 0 };
    return encodeFunctionData({ abi: forwarderLaunchModesAbi, functionName: "launchAnon", args: [permitArg(o.permit), l, o.owner, o.signature, approvalOf(o.approval)] });
  }
  const l = signedLaunch(o.l);
  return encodeFunctionData({ abi: forwarderAbi, functionName: "launchAnon", args: [permitArg(o.permit), { ...l, creatorFeeDestination: l.creatorFeeDestination }, o.owner, o.signature, approvalOf(o.approval)] });
}
