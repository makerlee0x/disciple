/**
 * Relayer-submitted private launch. Copied patterns:
 *   - UniswapX reactors, 0x Settler (SettlerMetaTxn), and DiscipleRouter.buyWithPermit2:
 *     the player signs ONE EIP-712 Permit2 PermitWitnessTransferFrom whose spender is
 *     GaslessForwarder and whose witness is the whole launch, including refundTo.
 *   The forwarder pulls USDG to itself, then calls AnonLauncher.launchAnonWithUsdg.
 *   A leaked signature cannot be pointed at a different recipient because Permit2 only
 *   lets the named spender redeem it, and the forwarder always follows the witness.
 *
 * Does not change the trade relay, GASLESS_GAS_LIMIT, or any cap.
 */
import { encodeAbiParameters, encodeFunctionData, keccak256, toBytes, type Address, type Hex } from "viem";
import { GaslessReject, GASLESS_MAX_DEADLINE_SEC, PERMIT2, type Erc2612, type Permit } from "./gaslessPermit2";
import { ZERO_ERC2612, gaslessForwarderAbi, gaslessForwarderAddress } from "./gaslessForwarder";

/**
 * Launch tx gas cap. Official solc 0.8.26 measured about 7.00M gas for a private
 * launch with a 10 USDG First BOOST (6.52M without). This cap adds room for the
 * Permit2 + approve + Multicall3 wrapper. It is a dedicated constant:
 * GASLESS_GAS_LIMIT is not changed.
 */
export const ANON_LAUNCH_TX_GAS_LIMIT = BigInt(8_500_000);

export const ANON_LAUNCH_TYPE =
  "AnonLaunch(string name,string ticker,string imageURI,string description,string socialsURI,address quote,uint256 creatorTaxBps,uint256 creatorBuyQuoteIn,uint256 creatorBuyMinTokensOut,uint256 deadline,address stealthOwner,address buyRecipient,bytes ephemeralPubKey,bytes1 viewTag,uint256 maxFee,uint256 usdgIn,uint256 minQuoteIn,address refundTo,address launcher)";
export const ANON_LAUNCH_WITNESS_TYPE =
  `AnonLaunch witness)${ANON_LAUNCH_TYPE}TokenPermissions(address token,uint256 amount)`;
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
};

export type GaslessAnonLaunchRequest = {
  signer: Address;
  permit: Permit;
  launch: AnonLaunch;
  signature: Hex;
  approval?: Erc2612;
};

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
  ],
} as const;

/** EIP-712 typed data the player signs. spender = GaslessForwarder. */
export function anonLaunchTypedData(chainId: number, permit: Permit, launch: AnonLaunch, spender: Address = gaslessForwarderAddress(chainId)) {
  return {
    domain: { name: "Permit2", chainId, verifyingContract: PERMIT2 },
    types: anonLaunchTypes,
    primaryType: "PermitWitnessTransferFrom" as const,
    message: { permitted: permit.permitted, spender, nonce: permit.nonce, deadline: permit.deadline, witness: launch },
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
      { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "address" },
    ],
    [
      ANON_LAUNCH_TYPEHASH, hashStr(l.name), hashStr(l.ticker), hashStr(l.imageURI), hashStr(l.description), hashStr(l.socialsURI),
      l.quote, l.creatorTaxBps, l.creatorBuyQuoteIn, l.creatorBuyMinTokensOut, l.deadline,
      l.stealthOwner, l.buyRecipient, hashBytes(l.ephemeralPubKey), l.viewTag,
      l.maxFee, l.usdgIn, l.minQuoteIn, l.refundTo, l.launcher,
    ],
  ));
}

export function permitAmount(l: AnonLaunch): bigint {
  return l.maxFee + l.usdgIn;
}

/** Relayer tx calldata: one GaslessForwarder.launchAnon. Optional EIP-2612 is bundled in `approval`. */
export function encodeAnonLaunchCall(q: GaslessAnonLaunchRequest, forwarder: Address): Hex {
  const permit = { permitted: q.permit.permitted, nonce: q.permit.nonce, deadline: q.permit.deadline };
  const approval = q.approval && q.approval.value > BigInt(0) ? q.approval : ZERO_ERC2612;
  return encodeFunctionData({
    abi: gaslessForwarderAbi,
    functionName: "launchAnon",
    args: [q.signer, permit, q.launch, q.signature, approval],
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
const hex = (v: unknown, what: string): Hex => {
  if (typeof v !== "string" || !HEX.test(v) || v.length % 2 !== 0) throw new GaslessReject(`bad ${what}`);
  return v as Hex;
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
  usdg: Address; launcher: Address; nowSec: number; launchFee: bigint; forwarder?: Address;
}): void {
  const l = q.launch;
  if (!eq(l.launcher, o.launcher)) throw new GaslessReject("launcher mismatch");
  if (!eq(q.permit.permitted.token, o.usdg)) throw new GaslessReject("permit token mismatch");
  if (q.permit.permitted.amount !== permitAmount(l)) throw new GaslessReject("permit amount mismatch");
  if (l.maxFee !== o.launchFee) throw new GaslessReject("launch fee changed, please retry");
  if (!eq(l.refundTo, q.signer)) throw new GaslessReject("refund must go to the signer");
  if (eq(l.refundTo, l.launcher)) throw new GaslessReject("refund cannot go to the launcher");
  if (eq(l.buyRecipient, l.launcher)) throw new GaslessReject("coins cannot go to the launcher");
  if (o.forwarder && (eq(l.refundTo, o.forwarder) || eq(l.buyRecipient, o.forwarder))) {
    throw new GaslessReject("refund or coins cannot go to the forwarder");
  }
  const now = BigInt(o.nowSec), max = now + BigInt(GASLESS_MAX_DEADLINE_SEC);
  for (const d of [l.deadline, q.permit.deadline]) if (d <= now || d > max) throw new GaslessReject("deadline out of range");
  if (q.approval && q.approval.value > BigInt(0) && q.approval.deadline <= now) throw new GaslessReject("approval expired");
}
