/**
 * GaslessForwarder (contracts/src/addons/GaslessForwarder.sol): the Permit2 spender for gasless withdrawals, action fees
 * and private launches. It replaced the public Multicall3 as spender (Vercel finding 2026-11-14: with Multicall3 as
 * spender the recipient was not signed, so anyone holding an unused signature could send the funds to themselves).
 *
 * The player signs ONE Permit2 PermitWitnessTransferFrom whose witness holds every payout (destination, fee, fee
 * recipient, or the whole launch), with spender = the forwarder. The forwarder only pays those signed addresses, so a
 * leaked or reverted signature can only do what the player signed. The relayer still sends one Multicall3.aggregate3
 * (an optional one-time USDG EIP-2612 permit, then the forwarder call); Multicall3 is only a batcher now, never a spender.
 *
 * Witness type strings list referenced struct types in alphabetical order (EIP-712 encodeType), which is what viem's
 * signTypedData hashes; tests/gasless-forwarder.test.ts checks each string against viem.
 */
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, type Address, type Hex } from "viem";
import { deployment, type Deployment } from "../chains";
import { GaslessReject, PERMIT2, type Erc2612, type Permit } from "./gaslessPermit2";

/** Zero address check for the forwarder: zero ⇒ gasless withdrawals / paid actions / private launches are off. */
export function requireForwarder(dep: Pick<Deployment, "gaslessForwarder"> = deployment()): Address {
  const f = dep.gaslessForwarder;
  if (!f || /^0x0{40}$/i.test(f)) throw new GaslessReject("gasless transfers aren't available on this chain yet");
  return f;
}

export const forwarderAbi = parseAbi([
  "struct TokenPermissions { address token; uint256 amount; }",
  "struct PermitTransferFrom { TokenPermissions permitted; uint256 nonce; uint256 deadline; }",
  "struct Withdraw { address to; uint256 amount; uint256 fee; address feeTo; }",
  "struct ActionFee { uint256 fee; address feeTo; bytes32 callsHash; }",
  "struct Call { address target; bytes data; }",
  "struct LaunchParams { string name; string ticker; string imageURI; string description; string socialsURI; address quote; uint256 creatorTaxBps; uint256 creatorBuyQuoteIn; uint256 creatorBuyMinTokensOut; uint256 deadline; }",
  "struct AnonLaunch { LaunchParams p; address stealthOwner; address buyRecipient; bytes ephemeralPubKey; bytes1 viewTag; uint256 maxFee; uint256 usdgIn; uint256 minQuoteIn; address refundTo; address launcher; uint8 creatorFeeDestination; }",
  "function withdraw(PermitTransferFrom permit, address owner, Withdraw w, bytes signature)",
  "function payFeeAndCall(PermitTransferFrom permit, address owner, ActionFee f, Call[] calls, bytes signature)",
  "function launchAnon(PermitTransferFrom permit, address owner, AnonLaunch l, bytes signature)",
]);

export const erc2612PermitAbi = parseAbi([
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
]);
export const multicall3Abi = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

const TP = [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] as const;
const pwtf = <W extends string>(witness: W) => [
  { name: "permitted", type: "TokenPermissions" },
  { name: "spender", type: "address" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
  { name: "witness", type: witness },
] as const;
const domain = (chainId: number) => ({ name: "Permit2", chainId, verifyingContract: PERMIT2 });

// ───────── withdraw ─────────

export type WithdrawWitness = { to: Address; amount: bigint; fee: bigint; feeTo: Address };
export const WITHDRAW_WITNESS_TYPE =
  "Withdraw witness)TokenPermissions(address token,uint256 amount)Withdraw(address to,uint256 amount,uint256 fee,address feeTo)";
export const withdrawTypes = {
  PermitWitnessTransferFrom: pwtf("Withdraw"),
  TokenPermissions: TP,
  Withdraw: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }, { name: "fee", type: "uint256" }, { name: "feeTo", type: "address" }],
} as const;

/** What the player signs for a withdrawal: permit for `amount + fee`, witness = where both parts go. */
export function withdrawTypedData(chainId: number, forwarder: Address, permit: Permit, w: WithdrawWitness) {
  return {
    domain: domain(chainId), types: withdrawTypes, primaryType: "PermitWitnessTransferFrom" as const,
    message: { permitted: permit.permitted, spender: forwarder, nonce: permit.nonce, deadline: permit.deadline, witness: w },
  };
}

// ───────── action fee ─────────

export type ForwarderCall = { target: Address; data: Hex };
export type ActionFeeWitness = { fee: bigint; feeTo: Address; callsHash: Hex };
export const ACTION_FEE_WITNESS_TYPE =
  "ActionFee witness)ActionFee(uint256 fee,address feeTo,bytes32 callsHash)TokenPermissions(address token,uint256 amount)";
export const actionFeeTypes = {
  PermitWitnessTransferFrom: pwtf("ActionFee"),
  ActionFee: [{ name: "fee", type: "uint256" }, { name: "feeTo", type: "address" }, { name: "callsHash", type: "bytes32" }],
  TokenPermissions: TP,
} as const;

/** keccak256(abi.encode(Call[])), the same bytes GaslessForwarder.payFeeAndCall hashes. */
export function hashCalls(calls: { to: Address; data: Hex }[]): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "data", type: "bytes" }] }],
    [calls.map((c) => ({ target: c.to, data: c.data }))],
  ));
}

/** What the player signs for a paid action: the fee, its recipient and the exact calls it pays for. */
export function actionFeeTypedData(chainId: number, forwarder: Address, permit: Permit, f: ActionFeeWitness) {
  return {
    domain: domain(chainId), types: actionFeeTypes, primaryType: "PermitWitnessTransferFrom" as const,
    message: { permitted: permit.permitted, spender: forwarder, nonce: permit.nonce, deadline: permit.deadline, witness: f },
  };
}

// ───────── relayer calldata ─────────

const permitArg = (p: Permit) => ({ permitted: p.permitted, nonce: p.nonce, deadline: p.deadline });

/**
 * One Multicall3.aggregate3: [optional USDG EIP-2612 permit of Permit2, the forwarder call]. The EIP-2612 permit may fail
 * (someone already submitted it, so the Permit2 allowance is in place), so it is allowFailure; the forwarder call is not.
 */
export function batchWithPermit(signer: Address, usdg: Address, approval: Erc2612 | undefined, forwarder: Address, callData: Hex): Hex {
  const calls: { target: Address; allowFailure: boolean; callData: Hex }[] = [];
  if (approval && approval.value > BigInt(0)) {
    const a = approval;
    calls.push({
      target: usdg, allowFailure: true,
      callData: encodeFunctionData({ abi: erc2612PermitAbi, functionName: "permit", args: [signer, PERMIT2, a.value, a.deadline, a.v, a.r, a.s] }),
    });
  }
  calls.push({ target: forwarder, allowFailure: false, callData });
  return encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] });
}

export function forwarderWithdrawData(permit: Permit, owner: Address, w: WithdrawWitness, signature: Hex): Hex {
  return encodeFunctionData({ abi: forwarderAbi, functionName: "withdraw", args: [permitArg(permit), owner, w, signature] });
}

export function forwarderActionData(permit: Permit, owner: Address, f: ActionFeeWitness, calls: { to: Address; data: Hex }[], signature: Hex): Hex {
  return encodeFunctionData({
    abi: forwarderAbi, functionName: "payFeeAndCall",
    args: [permitArg(permit), owner, f, calls.map((c) => ({ target: c.to, data: c.data })), signature],
  });
}
