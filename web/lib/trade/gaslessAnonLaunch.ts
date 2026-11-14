/**
 * Relayer-submitted private launch (flow/anon-launch-relayer). Copied patterns:
 *   - 0x Gasless / 0x-settler SettlerMetaTxn: the player signs ONE EIP-712 Permit2
 *     PermitWitnessTransferFrom whose witness is the whole launch (same idea as
 *     gaslessPermit2.ts / DiscipleRouter.buyWithPermit2).
 *   - Multicall3 gasless-withdraw: the relayer submits one aggregate3 and never holds
 *     funds across transactions (gaslessWithdraw.ts).
 *   - Uniswap-style router "recipient / refund to": leftover USDG goes to a named
 *     address (refundTo), not msg.sender, so a Multicall3 caller does not trap leftovers.
 *
 * Atomic batch, submitted by the relayer:
 *   [optional USDG EIP-2612 permit of Permit2,
 *    Permit2.permitWitnessTransferFrom (player → Multicall3),
 *    USDG.approve(launcher, amount),
 *    launcher.launchAnonWithUsdg(..., refundTo = the player),
 *    USDG.approve(launcher, 0)]
 * `launcher` is AnonLauncher when creatorFeeDestination is 0 (keep). For 1 (locked pool) or
 * 2 (buy-and-burn) it is CreatorFeeHarvest, which calls AnonLauncher and records the choice
 * in the same transaction. The destination is part of the signed witness, so the relayer
 * cannot change it.
 * Amount and every launch field are fixed in the signed witness. A failed launch
 * reverts the whole transaction, so the player's dollars never move (the refund path).
 * No leftover stays on Multicall3 when refundTo is the player and the launch fee is
 * unchanged in the same block.
 *
 * Does not change the trade relay, GASLESS_GAS_LIMIT, or any cap.
 */
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";
import { GaslessReject, GASLESS_MAX_DEADLINE_SEC, PERMIT2, type Erc2612, type Permit } from "./gaslessPermit2";
import { MULTICALL3, erc2612PermitAbi, multicall3Abi } from "./gaslessWithdraw";

export { MULTICALL3 };

/**
 * Launch tx gas cap. Official solc 0.8.26 measured about 7.00M gas for a private
 * launch with a 10 USDG First BOOST (6.52M without). This cap adds room for the
 * Permit2 + approve + Multicall3 wrapper. It is a dedicated constant:
 * GASLESS_GAS_LIMIT is not changed.
 */
export const ANON_LAUNCH_TX_GAS_LIMIT = BigInt(8_500_000);

export const ANON_LAUNCH_TYPE =
  "AnonLaunch(string name,string ticker,string imageURI,string description,string socialsURI,address quote,uint256 creatorTaxBps,uint256 creatorBuyQuoteIn,uint256 creatorBuyMinTokensOut,uint256 deadline,address stealthOwner,address buyRecipient,bytes ephemeralPubKey,bytes1 viewTag,uint256 maxFee,uint256 usdgIn,uint256 minQuoteIn,address refundTo,address launcher,uint8 creatorFeeDestination)";
export const ANON_LAUNCH_WITNESS_TYPE =
  `AnonLaunch witness)TokenPermissions(address token,uint256 amount)${ANON_LAUNCH_TYPE}`;
export const ANON_LAUNCH_TYPEHASH = keccak256(toBytes(ANON_LAUNCH_TYPE));

export type LaunchParams = {
  name: string;
  ticker: string;
  imageURI: string;
  description: string;
  socialsURI: string;
  quote: Address;
  creatorTaxBps: bigint;
  creatorBuyQuoteIn: bigint;
  creatorBuyMinTokensOut: bigint;
  deadline: bigint;
};

export type AnonLaunch = LaunchParams & {
  stealthOwner: Address;
  buyRecipient: Address;
  ephemeralPubKey: Hex;
  viewTag: Hex; // bytes1
  maxFee: bigint;
  usdgIn: bigint;
  minQuoteIn: bigint;
  refundTo: Address;
  launcher: Address;
  /** 0 keep (launcher = AnonLauncher), 1 locked pool or 2 buy-and-burn (launcher = CreatorFeeHarvest). */
  creatorFeeDestination: number;
};

export type GaslessAnonLaunchRequest = {
  signer: Address;
  permit: Permit;
  launch: AnonLaunch;
  signature: Hex;
  approval?: Erc2612;
};

export const permit2WitnessTransferAbi = parseAbi([
  "function permitWitnessTransferFrom(((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit, (address to,uint256 requestedAmount) transferDetails, address owner, bytes32 witness, string witnessTypeString, bytes signature)",
]);
export const erc20ApproveAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);
export const launchAnonWithUsdgAbi = parseAbi([
  "function launchAnonWithUsdg((string name,string ticker,string imageURI,string description,string socialsURI,address quote,uint256 creatorTaxBps,uint256 creatorBuyQuoteIn,uint256 creatorBuyMinTokensOut,uint256 deadline) p, address stealthOwner, address buyRecipient, bytes ephemeralPubKey, bytes1 viewTag, uint256 maxFee, uint256 usdgIn, uint256 minQuoteIn, address refundTo) returns ((address token,address curve,uint256 creatorTokensBought) r, uint256 usdgRefund)",
]);

/** CreatorFeeHarvest.launchAnonWithUsdg: same arguments plus the destination (lib/creatorFeeHarvest). */
export const harvestLaunchAnonWithUsdgAbi = parseAbi([
  "function launchAnonWithUsdg((string name,string ticker,string imageURI,string description,string socialsURI,address quote,uint256 creatorTaxBps,uint256 creatorBuyQuoteIn,uint256 creatorBuyMinTokensOut,uint256 deadline) p, address stealthOwner, address buyRecipient, bytes ephemeralPubKey, bytes1 viewTag, uint256 maxFee, uint256 usdgIn, uint256 minQuoteIn, address refundTo, uint8 creatorFeeDestination) returns ((address token,address curve,uint256 creatorTokensBought) r, uint256 usdgRefund)",
]);

export const anonLaunchTypes = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "AnonLaunch" },
  ],
  TokenPermissions: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
  AnonLaunch: [
    { name: "name", type: "string" },
    { name: "ticker", type: "string" },
    { name: "imageURI", type: "string" },
    { name: "description", type: "string" },
    { name: "socialsURI", type: "string" },
    { name: "quote", type: "address" },
    { name: "creatorTaxBps", type: "uint256" },
    { name: "creatorBuyQuoteIn", type: "uint256" },
    { name: "creatorBuyMinTokensOut", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "stealthOwner", type: "address" },
    { name: "buyRecipient", type: "address" },
    { name: "ephemeralPubKey", type: "bytes" },
    { name: "viewTag", type: "bytes1" },
    { name: "maxFee", type: "uint256" },
    { name: "usdgIn", type: "uint256" },
    { name: "minQuoteIn", type: "uint256" },
    { name: "refundTo", type: "address" },
    { name: "launcher", type: "address" },
    { name: "creatorFeeDestination", type: "uint8" },
  ],
} as const;

/** EIP-712 typed data the player signs. spender = Multicall3 (the Permit2 caller). */
export function anonLaunchTypedData(chainId: number, permit: Permit, launch: AnonLaunch) {
  return {
    domain: { name: "Permit2", chainId, verifyingContract: PERMIT2 },
    types: anonLaunchTypes,
    primaryType: "PermitWitnessTransferFrom" as const,
    message: { permitted: permit.permitted, spender: MULTICALL3, nonce: permit.nonce, deadline: permit.deadline, witness: launch },
  };
}

const hashStr = (s: string): Hex => keccak256(toBytes(s));
const hashBytes = (b: Hex): Hex => keccak256(b);

/** keccak256(abi.encode(ANON_LAUNCH_TYPEHASH, …)) — the Permit2 witness bytes32. */
export function anonLaunchWitnessHash(l: AnonLaunch): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
      { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "bytes1" },
      { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint8" },
    ],
    [
      ANON_LAUNCH_TYPEHASH, hashStr(l.name), hashStr(l.ticker), hashStr(l.imageURI), hashStr(l.description), hashStr(l.socialsURI),
      l.quote, l.creatorTaxBps, l.creatorBuyQuoteIn, l.creatorBuyMinTokensOut, l.deadline,
      l.stealthOwner, l.buyRecipient, hashBytes(l.ephemeralPubKey), l.viewTag,
      l.maxFee, l.usdgIn, l.minQuoteIn, l.refundTo, l.launcher, l.creatorFeeDestination,
    ],
  ));
}

export function permitAmount(l: AnonLaunch): bigint {
  return l.maxFee + l.usdgIn;
}

const call = (target: Address, callData: Hex) => ({ target, allowFailure: false, callData });

/** Relayer tx calldata: one Multicall3.aggregate3. Never holds funds across transactions. */
export function encodeAnonLaunchCall(q: GaslessAnonLaunchRequest, usdg: Address): Hex {
  const amount = permitAmount(q.launch);
  const calls: { target: Address; allowFailure: boolean; callData: Hex }[] = [];
  if (q.approval && q.approval.value > BigInt(0)) {
    const a = q.approval;
    calls.push(call(usdg, encodeFunctionData({
      abi: erc2612PermitAbi, functionName: "permit",
      args: [q.signer, PERMIT2, a.value, a.deadline, a.v, a.r, a.s],
    })));
  }
  const permit = { permitted: q.permit.permitted, nonce: q.permit.nonce, deadline: q.permit.deadline };
  calls.push(call(PERMIT2, encodeFunctionData({
    abi: permit2WitnessTransferAbi, functionName: "permitWitnessTransferFrom",
    args: [
      permit,
      { to: MULTICALL3, requestedAmount: amount },
      q.signer,
      anonLaunchWitnessHash(q.launch),
      ANON_LAUNCH_WITNESS_TYPE,
      q.signature,
    ],
  })));
  calls.push(call(usdg, encodeFunctionData({ abi: erc20ApproveAbi, functionName: "approve", args: [q.launch.launcher, amount] })));
  const l = q.launch;
  const p = {
    name: l.name, ticker: l.ticker, imageURI: l.imageURI, description: l.description, socialsURI: l.socialsURI,
    quote: l.quote, creatorTaxBps: l.creatorTaxBps, creatorBuyQuoteIn: l.creatorBuyQuoteIn,
    creatorBuyMinTokensOut: l.creatorBuyMinTokensOut, deadline: l.deadline,
  };
  calls.push(call(l.launcher, l.creatorFeeDestination === 0
    ? encodeFunctionData({
      abi: launchAnonWithUsdgAbi, functionName: "launchAnonWithUsdg",
      args: [p, l.stealthOwner, l.buyRecipient, l.ephemeralPubKey, l.viewTag, l.maxFee, l.usdgIn, l.minQuoteIn, l.refundTo],
    })
    : encodeFunctionData({
      abi: harvestLaunchAnonWithUsdgAbi, functionName: "launchAnonWithUsdg",
      args: [p, l.stealthOwner, l.buyRecipient, l.ephemeralPubKey, l.viewTag, l.maxFee, l.usdgIn, l.minQuoteIn, l.refundTo, l.creatorFeeDestination],
    })));
  // Clear the leftover allowance so a later Multicall3 call cannot spend from a stale approve.
  calls.push(call(usdg, encodeFunctionData({ abi: erc20ApproveAbi, functionName: "approve", args: [q.launch.launcher, BigInt(0)] })));
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
const hex = (v: unknown, what: string): Hex => {
  if (typeof v !== "string" || !HEX.test(v) || v.length % 2 !== 0) throw new GaslessReject(`bad ${what}`);
  return v as Hex;
};
const dest = (v: unknown): number => {
  if (v === 0 || v === 1 || v === 2) return v;
  if (v === "0" || v === "1" || v === "2") return Number(v);
  throw new GaslessReject("bad creatorFeeDestination");
};
const str = (v: unknown, what: string): string => {
  if (typeof v !== "string") throw new GaslessReject(`bad ${what}`);
  return v;
};

/** JSON (bigints as decimal/hex strings) → typed request. Shape only. */
export function parseGaslessAnonLaunchRequest(x: unknown): GaslessAnonLaunchRequest {
  const o = (x ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const sig = o.signature;
  if (typeof sig !== "string" || !HEX.test(sig) || (sig.length !== 132 && sig.length !== 130)) throw new GaslessReject("bad signature");
  const p = o.permit ?? {}, l = o.launch ?? {};
  const viewTag = hex(l.viewTag ?? "0x00", "viewTag");
  if (viewTag.length !== 4) throw new GaslessReject("bad viewTag");
  const q: GaslessAnonLaunchRequest = {
    signer: addr(o.signer, "signer"),
    permit: {
      permitted: { token: addr(p.permitted?.token, "permit token"), amount: big(p.permitted?.amount, "permit amount") },
      nonce: big(p.nonce, "nonce"),
      deadline: big(p.deadline, "permit deadline"),
    },
    launch: {
      name: str(l.name, "name"),
      ticker: str(l.ticker, "ticker"),
      imageURI: str(l.imageURI, "imageURI"),
      description: str(l.description ?? "", "description"),
      socialsURI: str(l.socialsURI ?? "", "socialsURI"),
      quote: addr(l.quote, "quote"),
      creatorTaxBps: big(l.creatorTaxBps, "creatorTaxBps"),
      creatorBuyQuoteIn: big(l.creatorBuyQuoteIn ?? 0, "creatorBuyQuoteIn"),
      creatorBuyMinTokensOut: big(l.creatorBuyMinTokensOut, "creatorBuyMinTokensOut"),
      deadline: big(l.deadline, "deadline"),
      stealthOwner: addr(l.stealthOwner, "stealthOwner"),
      buyRecipient: addr(l.buyRecipient, "buyRecipient"),
      ephemeralPubKey: hex(l.ephemeralPubKey ?? "0x", "ephemeralPubKey"),
      viewTag,
      maxFee: big(l.maxFee, "maxFee"),
      usdgIn: big(l.usdgIn, "usdgIn"),
      minQuoteIn: big(l.minQuoteIn, "minQuoteIn"),
      refundTo: addr(l.refundTo, "refundTo"),
      launcher: addr(l.launcher, "launcher"),
      creatorFeeDestination: dest(l.creatorFeeDestination ?? 0),
    },
    signature: sig as Hex,
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
 * Every rule checked before any RPC so junk never costs a simulation: permit is USDG for
 * exactly fee + First BOOST, refundTo and the signer are the same player, leftover cannot
 * be aimed at the launcher, deadlines are live and within GASLESS_MAX_DEADLINE_SEC.
 */
export function checkGaslessAnonLaunchRequest(q: GaslessAnonLaunchRequest, o: {
  usdg: Address; launcher: Address; nowSec: number; launchFee: bigint;
  /** CreatorFeeHarvest, only when private fee routing is live (lib/quickLaunch PRIVATE_FEE_ROUTING_LIVE). */
  harvest?: Address | null;
}): void {
  const l = q.launch;
  if (l.creatorFeeDestination === 0) {
    if (!eq(l.launcher, o.launcher)) throw new GaslessReject("launcher mismatch");
  } else {
    if (!o.harvest || /^0x0{40}$/i.test(o.harvest)) throw new GaslessReject("private fee routing isn't available yet");
    if (!eq(l.launcher, o.harvest)) throw new GaslessReject("launcher mismatch");
  }
  if (!eq(q.permit.permitted.token, o.usdg)) throw new GaslessReject("permit token mismatch");
  if (q.permit.permitted.amount !== permitAmount(l)) throw new GaslessReject("permit amount mismatch");
  if (l.maxFee !== o.launchFee) throw new GaslessReject("launch fee changed, please retry");
  if (!eq(l.refundTo, q.signer)) throw new GaslessReject("refund must go to the signer");
  if (eq(l.refundTo, l.launcher)) throw new GaslessReject("refund cannot go to the launcher");
  if (eq(l.buyRecipient, l.launcher)) throw new GaslessReject("coins cannot go to the launcher");
  const now = BigInt(o.nowSec), max = now + BigInt(GASLESS_MAX_DEADLINE_SEC);
  for (const d of [l.deadline, q.permit.deadline]) if (d <= now || d > max) throw new GaslessReject("deadline out of range");
  if (q.approval && q.approval.value > BigInt(0) && q.approval.deadline <= now) throw new GaslessReject("approval expired");
}
