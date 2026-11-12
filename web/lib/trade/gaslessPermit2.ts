/**
 * Gasless swaps (flow/gasless-permit2, lee Nov 9 2:46 PM CT). Copied pattern: 0x Gasless / 0x-settler
 * SettlerMetaTxn.executeMetaTxn — the trader signs ONE EIP-712 Permit2 PermitWitnessTransferFrom whose witness is the
 * whole trade; our relayer EOA submits DiscipleRouter.buyWithPermit2 / sellWithPermit2 and pays the ETH (covered by
 * the trading fee). Pure (no DOM, no server): the client signs with these types, the server rebuilds and verifies them,
 * and contracts/src/DiscipleRouter.sol TRADE_WITNESS_TYPE / tradeWitnessHash is the on-chain twin.
 */
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";

export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

/** lee, Nov 9 2026: the minimum trade is $3 (was the ~$0.20 "network min shot"). One number for client, server, engine. */
export const MIN_TRADE_USD = 3;
/** Raw USDG base units of MIN_TRADE_USD at `decimals` (6 on mainnet and the v5 testnet mock). */
export const minTradeRaw = (decimals: number) => BigInt(MIN_TRADE_USD) * BigInt(10) ** BigInt(decimals);

/** Server bounds on what a relayer will submit. */
export const GASLESS_MAX_DEADLINE_SEC = 300;   // signed deadline at most 5 min ahead
/** Default cap for ordinary gasless trades (RH/Orbit bills gasUsed, not the cap). */
export const GASLESS_GAS_LIMIT = BigInt(900_000);
/** Cap for a buy that fills (graduates) the curve. A graduating smoke buy used 2,365,644 gas; 3M is the existing AA call cap. */
export const GASLESS_GRAD_GAS_LIMIT = BigInt(3_000_000);
/** Higher cap only when the buy fills the curve: a bigger gasLimit reserves relayer ETH (balance must cover gasLimit×maxFeePerGas) even though unused gas is not billed. */
export const gaslessTxGasLimit = (fillsCurve: boolean) => (fillsCurve ? GASLESS_GRAD_GAS_LIMIT : GASLESS_GAS_LIMIT);

export type Trade = { coin: Address; isBuy: boolean; amountIn: bigint; minOut: bigint; recipient: Address; deadline: bigint };
export type Permit = { permitted: { token: Address; amount: bigint }; nonce: bigint; deadline: bigint };
/** One-time EIP-2612 approve of PERMIT2 bundled into the first trade (value 0 ⇒ none). */
export type Erc2612 = { value: bigint; deadline: bigint; v: number; r: Hex; s: Hex };
export type GaslessRequest = { signer: Address; permit: Permit; trade: Trade; signature: Hex; approval?: Erc2612 };

export const TRADE_TYPE = "Trade(address coin,bool isBuy,uint256 amountIn,uint256 minOut,address recipient,uint256 deadline)";
export const TRADE_WITNESS_TYPE = `Trade witness)TokenPermissions(address token,uint256 amount)${TRADE_TYPE}`;
export const TRADE_TYPEHASH = keccak256(toBytes(TRADE_TYPE));

export const permit2Types = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" }, { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "witness", type: "Trade" },
  ],
  TokenPermissions: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
  Trade: [
    { name: "coin", type: "address" }, { name: "isBuy", type: "bool" }, { name: "amountIn", type: "uint256" },
    { name: "minOut", type: "uint256" }, { name: "recipient", type: "address" }, { name: "deadline", type: "uint256" },
  ],
} as const;

/** EIP-712 typed data the trader signs (Permit2 domain: name "Permit2", no version). `spender` = the gasless router. */
export function tradeTypedData(chainId: number, router: Address, permit: Permit, trade: Trade) {
  return {
    domain: { name: "Permit2", chainId, verifyingContract: PERMIT2 },
    types: permit2Types,
    primaryType: "PermitWitnessTransferFrom" as const,
    message: { permitted: permit.permitted, spender: router, nonce: permit.nonce, deadline: permit.deadline, witness: trade },
  };
}
/** keccak256(abi.encode(TRADE_TYPEHASH, …)) — DiscipleRouter.tradeWitnessHash. */
export function tradeWitnessHash(t: Trade): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }],
    [TRADE_TYPEHASH, t.coin, t.isBuy, t.amountIn, t.minOut, t.recipient, t.deadline]));
}

const P = "(address token,uint256 amount) permitted,uint256 nonce,uint256 deadline";
const T = "address coin,bool isBuy,uint256 amountIn,uint256 minOut,address recipient,uint256 deadline";
const A = "uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s";
export const gaslessRouterAbi = parseAbi([
  `function buyWithPermit2(address signer, (${P}) permit, (${T}) trade, bytes signature) returns (uint256)`,
  `function sellWithPermit2(address signer, (${P}) permit, (${T}) trade, bytes signature) returns (uint256)`,
  `function buyWithPermit2AndApprove(address signer, (${P}) permit, (${T}) trade, bytes signature, (${A}) approval) returns (uint256)`,
  `function sellWithPermit2AndApprove(address signer, (${P}) permit, (${T}) trade, bytes signature, (${A}) approval) returns (uint256)`,
  "event GaslessTrade(address indexed signer, address indexed relayer, address indexed coin, bool isBuy, uint256 nonce)",
]);
/** The relayer tx calldata for a request (the router call; no wrapper, no UserOp). */
export function encodeGaslessCall(q: GaslessRequest): Hex {
  const permit = { permitted: q.permit.permitted, nonce: q.permit.nonce, deadline: q.permit.deadline };
  if (q.approval && q.approval.value > BigInt(0))
    return encodeFunctionData({ abi: gaslessRouterAbi, functionName: q.trade.isBuy ? "buyWithPermit2AndApprove" : "sellWithPermit2AndApprove", args: [q.signer, permit, q.trade, q.signature, q.approval] });
  return encodeFunctionData({ abi: gaslessRouterAbi, functionName: q.trade.isBuy ? "buyWithPermit2" : "sellWithPermit2", args: [q.signer, permit, q.trade, q.signature] });
}

/* ───────── Permit2 unordered nonces ─────────
 * Permit2 burns bit (nonce & 255) of word (nonce >> 8) in nonceBitmap[owner]. Reusing ONE word per player keeps the
 * nonce SSTORE warm-ish (non-zero → non-zero: measured 62k vs 79k gas for a fresh word). Pick the lowest unset bit,
 * mark it locally at once (rapid taps never share a nonce in one tab); another tab / device colliding just fails the
 * exact simulation before anything is sent. */
export function lowestFreeBit(bitmap: bigint, taken: bigint = BigInt(0)): number {
  const used = bitmap | taken;
  for (let i = 0; i < 256; i++) if (((used >> BigInt(i)) & BigInt(1)) === BigInt(0)) return i;
  return -1;
}
export class NonceBook {
  private words = new Map<string, { word: bigint; taken: bigint }>();
  private chain = new Map<string, Promise<unknown>>();
  constructor(private readBitmap: (owner: Address, word: bigint) => Promise<bigint>) {}
  /** Serialized per owner (rapid taps): each pick sees the previous pick's bit. */
  next(owner: Address): Promise<bigint> {
    const k = owner.toLowerCase();
    const p = (this.chain.get(k) ?? Promise.resolve()).catch(() => undefined).then(() => this.pick(owner, k));
    this.chain.set(k, p);
    return p;
  }
  private async pick(owner: Address, k: string): Promise<bigint> {
    let w = this.words.get(k) ?? { word: BigInt(0), taken: await this.readBitmap(owner, BigInt(0)) };
    for (let guard = 0; guard < 64; guard++) {
      const bit = lowestFreeBit(w.taken);
      if (bit >= 0) { w = { word: w.word, taken: w.taken | (BigInt(1) << BigInt(bit)) }; this.words.set(k, w); return (w.word << BigInt(8)) | BigInt(bit); }
      const word = w.word + BigInt(1);
      w = { word, taken: await this.readBitmap(owner, word) };
    }
    throw new Error("no free Permit2 nonce");
  }
  /** Re-read the on-chain bitmap on the next pick (after a collision / reload). */
  reset(owner: Address) { this.words.delete(owner.toLowerCase()); }
}

/* ───────── Request validation (server, before ANY RPC) ───────── */
export class GaslessReject extends Error { notSent = true; constructor(public reason: string) { super(`gasless rejected: ${reason}`); } }
const ADDR = /^0x[0-9a-fA-F]{40}$/, HEX = /^0x[0-9a-fA-F]*$/;
/** Decimal-string bigints so JSON.stringify (POST /api/gasless, Privy eth_signTypedData_v4 signRequest) does not throw. */
export const bigintToDecimal = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
export const jsonSafe = <T,>(v: T): T => JSON.parse(JSON.stringify(v, bigintToDecimal)) as T;

const big = (v: unknown, what: string): bigint => {
  if (typeof v === "bigint") return v;
  if ((typeof v === "string" && /^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(v)) || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) return BigInt(v);
  throw new GaslessReject(`bad ${what}`);
};
const addr = (v: unknown, what: string): Address => { if (typeof v !== "string" || !ADDR.test(v) || /^0x0{40}$/i.test(v)) throw new GaslessReject(`bad ${what}`); return v as Address; };
/** JSON (bigints as decimal/hex strings) → typed request. Shape only. */
export function parseGaslessRequest(x: unknown): GaslessRequest {
  const o = (x ?? {}) as Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
  const sig = o.signature;
  if (typeof sig !== "string" || !HEX.test(sig) || (sig.length !== 132 && sig.length !== 130)) throw new GaslessReject("bad signature");
  const p = o.permit ?? {}, t = o.trade ?? {};
  const q: GaslessRequest = {
    signer: addr(o.signer, "signer"),
    permit: { permitted: { token: addr(p.permitted?.token, "permit token"), amount: big(p.permitted?.amount, "permit amount") }, nonce: big(p.nonce, "nonce"), deadline: big(p.deadline, "permit deadline") },
    trade: { coin: addr(t.coin, "coin"), isBuy: t.isBuy === true ? true : t.isBuy === false ? false : (() => { throw new GaslessReject("bad side"); })(), amountIn: big(t.amountIn, "amountIn"), minOut: big(t.minOut, "minOut"), recipient: addr(t.recipient, "recipient"), deadline: big(t.deadline, "deadline") },
    signature: sig as Hex,
  };
  if (o.approval !== undefined && o.approval !== null) {
    const a = o.approval;
    if (typeof a.r !== "string" || typeof a.s !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(a.r) || !/^0x[0-9a-fA-F]{64}$/.test(a.s) || (a.v !== 27 && a.v !== 28)) throw new GaslessReject("bad approval");
    q.approval = { value: big(a.value, "approval value"), deadline: big(a.deadline, "approval deadline"), v: a.v, r: a.r, s: a.s };
  }
  return q;
}
/**
 * Every rule the router also enforces, checked before any RPC so junk never costs a simulation: signer == trader ==
 * recipient, permitted token = USDG (buy) / the coin (sell), permit amount == trade.amountIn, minOut > 0, deadlines
 * live and ≤ GASLESS_MAX_DEADLINE_SEC ahead, the $3 minimum on buys (lee), the configured router.
 */
export function checkGaslessRequest(q: GaslessRequest, o: { usdg: Address; usdgDecimals: number; nowSec: number }): void {
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!eq(q.trade.recipient, q.signer)) throw new GaslessReject("recipient must be the signer");
  if (!eq(q.permit.permitted.token, q.trade.isBuy ? o.usdg : q.trade.coin)) throw new GaslessReject("permit token mismatch");
  if (q.permit.permitted.amount !== q.trade.amountIn) throw new GaslessReject("permit amount mismatch");
  if (q.trade.amountIn <= BigInt(0) || q.trade.minOut <= BigInt(0)) throw new GaslessReject("zero amount or minOut");
  const now = BigInt(o.nowSec), max = now + BigInt(GASLESS_MAX_DEADLINE_SEC);
  for (const d of [q.trade.deadline, q.permit.deadline]) if (d <= now || d > max) throw new GaslessReject("deadline out of range");
  if (q.trade.isBuy && q.trade.amountIn < minTradeRaw(o.usdgDecimals)) throw new GaslessReject(`minimum trade is $${MIN_TRADE_USD}`);
  if (q.approval && q.approval.value > BigInt(0) && (q.approval.deadline <= now)) throw new GaslessReject("approval expired");
}
