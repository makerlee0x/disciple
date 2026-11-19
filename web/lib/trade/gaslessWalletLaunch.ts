/**
 * Gasless wallet launch (maker 2026-11-19: players hold USDG only, so a launch from the wallet can't pay ETH gas).
 *
 * The player signs ONE Permit2 witness (spender = CreatorFeeHarvest) for `usdgIn + gasFee` USDG. The relayer sends
 * CreatorFeeHarvest.launchWithPermit2(signer, permit, params, w, sig): the signer is the coin creator, `usdgIn` buys the
 * First BOOST (leftover back to the signer in USDG), and `gasFee` USDG goes to the relayer (msg.sender), which paid the ETH.
 * Every launch field is in the witness (paramsHash = keccak256(abi.encode(params))), so the relayer can't change any of it.
 * The harvest caps gasFee at $1. Must match contracts/src/addons/CreatorFeeHarvest.sol byte for byte.
 */
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, type Address, type Hex } from "viem";
import { GaslessReject, PERMIT2, type Erc2612, type Permit } from "./gaslessPermit2";

export const GASLESS_LAUNCH_TYPE =
  "GaslessLaunch(bytes32 paramsHash,uint8 mode,uint256 usdgIn,uint256 minQuoteIn,uint8 creatorFeeDestination,uint256 gasFee)";
export const GASLESS_LAUNCH_WITNESS_TYPE = `GaslessLaunch witness)${GASLESS_LAUNCH_TYPE}TokenPermissions(address token,uint256 amount)`;

export type LaunchParams = {
  name: string; ticker: string; imageURI: string; description: string; socialsURI: string; quote: Address;
  creatorTaxBps: bigint; creatorBuyQuoteIn: bigint; creatorBuyMinTokensOut: bigint; deadline: bigint;
};
export type GaslessLaunchWitness = {
  paramsHash: Hex; mode: number; usdgIn: bigint; minQuoteIn: bigint; creatorFeeDestination: number; gasFee: bigint;
};
export type WalletLaunchRequest = {
  signer: Address; permit: Permit; params: LaunchParams; w: GaslessLaunchWitness; signature: Hex; approval?: Erc2612;
};

const PARAMS_COMPONENTS = [
  { name: "name", type: "string" }, { name: "ticker", type: "string" }, { name: "imageURI", type: "string" },
  { name: "description", type: "string" }, { name: "socialsURI", type: "string" }, { name: "quote", type: "address" },
  { name: "creatorTaxBps", type: "uint256" }, { name: "creatorBuyQuoteIn", type: "uint256" },
  { name: "creatorBuyMinTokensOut", type: "uint256" }, { name: "deadline", type: "uint256" },
] as const;

/** keccak256(abi.encode(params)) for the LaunchParams struct (a dynamic tuple, so with its leading offset). */
export function launchParamsHash(p: LaunchParams): Hex {
  return keccak256(encodeAbiParameters([{ type: "tuple", components: PARAMS_COMPONENTS }], [p]));
}

export const walletLaunchTypes = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" }, { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "witness", type: "GaslessLaunch" },
  ],
  TokenPermissions: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
  GaslessLaunch: [
    { name: "paramsHash", type: "bytes32" }, { name: "mode", type: "uint8" }, { name: "usdgIn", type: "uint256" },
    { name: "minQuoteIn", type: "uint256" }, { name: "creatorFeeDestination", type: "uint8" }, { name: "gasFee", type: "uint256" },
  ],
} as const;

export function walletLaunchTypedData(chainId: number, harvest: Address, permit: Permit, w: GaslessLaunchWitness) {
  return {
    domain: { name: "Permit2", chainId, verifyingContract: PERMIT2 },
    types: walletLaunchTypes, primaryType: "PermitWitnessTransferFrom" as const,
    message: { permitted: permit.permitted, spender: harvest, nonce: permit.nonce, deadline: permit.deadline, witness: w },
  };
}

export const harvestPermit2LaunchAbi = parseAbi([
  "function launchWithPermit2(address signer, ((address token, uint256 amount) permitted, uint256 nonce, uint256 deadline) permit, (string name, string ticker, string imageURI, string description, string socialsURI, address quote, uint256 creatorTaxBps, uint256 creatorBuyQuoteIn, uint256 creatorBuyMinTokensOut, uint256 deadline) params, (bytes32 paramsHash, uint8 mode, uint256 usdgIn, uint256 minQuoteIn, uint8 creatorFeeDestination, uint256 gasFee) w, bytes sig) returns ((address token, address curve, uint256 creatorTokensBought) result, uint256 usdgRefund)",
  "function launchWithMode((string name, string ticker, string imageURI, string description, string socialsURI, address quote, uint256 creatorTaxBps, uint256 creatorBuyQuoteIn, uint256 creatorBuyMinTokensOut, uint256 deadline) params, uint8 mode, uint8 creatorFeeDestination) returns ((address token, address curve, uint256 creatorTokensBought) result)",
]);

export function encodeWalletLaunch(q: WalletLaunchRequest): Hex {
  return encodeFunctionData({ abi: harvestPermit2LaunchAbi, functionName: "launchWithPermit2", args: [q.signer, q.permit, q.params, q.w, q.signature] });
}

/** What the relayer estimates for the quote: the same launch with no First BOOST, from the signer. */
export function encodeLaunchEstimate(p: LaunchParams, mode: number, creatorFeeDestination: number): Hex {
  return encodeFunctionData({ abi: harvestPermit2LaunchAbi, functionName: "launchWithMode", args: [{ ...p, creatorBuyQuoteIn: 0n }, mode, creatorFeeDestination] });
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const big = (v: unknown, what: string): bigint => {
  try { return BigInt(v as string | number | bigint); } catch { throw new GaslessReject(`bad ${what}`); }
};
const str = (v: unknown, what: string): string => { if (typeof v !== "string") throw new GaslessReject(`bad ${what}`); return v; };
const addr = (v: unknown, what: string): Address => { if (typeof v !== "string" || !ADDR.test(v)) throw new GaslessReject(`bad ${what}`); return v as Address; };

export function parseLaunchParams(x: unknown): LaunchParams {
  const p = (x ?? {}) as Record<string, unknown>;
  return {
    name: str(p.name, "name"), ticker: str(p.ticker, "ticker"), imageURI: str(p.imageURI, "image"),
    description: str(p.description ?? "", "description"), socialsURI: str(p.socialsURI ?? "", "socials"),
    quote: addr(p.quote, "quote"), creatorTaxBps: big(p.creatorTaxBps, "tax"), creatorBuyQuoteIn: big(p.creatorBuyQuoteIn ?? 0, "buy"),
    creatorBuyMinTokensOut: big(p.creatorBuyMinTokensOut ?? 0, "min out"), deadline: big(p.deadline, "deadline"),
  };
}

export function parseWalletLaunchRequest(x: unknown): WalletLaunchRequest {
  const o = (x ?? {}) as Record<string, unknown>;
  const pm = (o.permit ?? {}) as Record<string, unknown>;
  const pd = (pm.permitted ?? {}) as Record<string, unknown>;
  const w = (o.w ?? {}) as Record<string, unknown>;
  const sig = o.signature;
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]+$/.test(sig)) throw new GaslessReject("bad signature");
  if (typeof w.paramsHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(w.paramsHash)) throw new GaslessReject("bad params hash");
  const approval = o.approval == null ? undefined : (() => {
    const a = o.approval as Record<string, unknown>;
    return { value: big(a.value, "permit value"), deadline: big(a.deadline, "permit deadline"), v: Number(a.v), r: a.r as Hex, s: a.s as Hex };
  })();
  return {
    signer: addr(o.signer, "signer"),
    permit: { permitted: { token: addr(pd.token, "permit token"), amount: big(pd.amount, "permit amount") }, nonce: big(pm.nonce, "nonce"), deadline: big(pm.deadline, "permit deadline") },
    params: parseLaunchParams(o.params),
    w: {
      paramsHash: w.paramsHash as Hex, mode: Number(w.mode), usdgIn: big(w.usdgIn ?? 0, "usdgIn"), minQuoteIn: big(w.minQuoteIn ?? 0, "minQuoteIn"),
      creatorFeeDestination: Number(w.creatorFeeDestination ?? 0), gasFee: big(w.gasFee, "gas fee"),
    },
    signature: sig as Hex,
    approval,
  };
}

/** Everything the harvest checks, before anything is sent (so a bad request costs the relayer nothing). */
export function checkWalletLaunch(q: WalletLaunchRequest, o: { usdg: Address; usdgDecimals: number; nowSec: number }): void {
  const now = BigInt(o.nowSec);
  if (/^0x0{40}$/i.test(q.signer)) throw new GaslessReject("bad signer");
  if (q.permit.permitted.token.toLowerCase() !== o.usdg.toLowerCase()) throw new GaslessReject("permit token mismatch");
  if (q.permit.permitted.amount !== q.w.usdgIn + q.w.gasFee) throw new GaslessReject("permit amount mismatch");
  if (q.w.paramsHash.toLowerCase() !== launchParamsHash(q.params).toLowerCase()) throw new GaslessReject("launch fields don't match the signature");
  if (q.w.gasFee > 10n ** BigInt(o.usdgDecimals)) throw new GaslessReject("network fee over $1 right now; try again in a bit");
  if (!(q.w.mode >= 0 && q.w.mode <= 2)) throw new GaslessReject("bad mode");
  if (!(q.w.creatorFeeDestination >= 0 && q.w.creatorFeeDestination <= 2)) throw new GaslessReject("bad fee destination");
  if (q.permit.deadline < now || q.params.deadline < now) throw new GaslessReject("launch expired; try again");
  if (q.approval && q.approval.deadline < now) throw new GaslessReject("USDG permit expired");
}
