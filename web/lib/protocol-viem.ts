/**
 * viem implementation of ProtocolClient against DISCIPLE FLOW PR #4 (flow/contracts-api).
 *  - No custody/vault: the Privy embedded wallet (lib/wallet.ts) signs every tx.
 *  - Approve once (max) per spender: curve pre-grad, DiscipleRouter post-grad, Launchpad for creator buys.
 *  - Previews come from on-chain views (quoteBuy/quoteSell) or router.quoteExactIn (eth_call) post-grad.
 *  - Quote decimals are read per token (USDG = 6, STRATEGY = 18); never assumed.
 */
import { needsHop, usdgAddress, swapQuote, buyHopCalls, sellHopCall, hopBps, UNIVERSAL_ROUTER } from "./trade/usdgRoute";
import { BALANCES, COIN, QUOTES, LAST_QUOTE, scaledQuote, addInflight, marginalQuote, key as ckey } from "./trade/hotCache";
import {
  BaseError, ContractFunctionRevertedError, createPublicClient, decodeErrorResult, decodeEventLog, encodeFunctionData, http, maxUint256, parseAbi, type Hex, type PublicClient,
} from "viem";
import { bondingCurveAbi, discipleRouterAbi, launchpadAbi, marketLensAbi, tokenAbi } from "./abi";
import { ACTIVE_CHAIN, deployment, hasLens, hasRouter, isDeployed } from "./chains";
import { referrerWallet } from "./referral";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;
const referralRegistryAbi = parseAbi([
  "function referrerOf(address wallet) view returns (address)",
  "function pendingReferrer(address wallet) view returns (address)",
  "function tryAttribute(address wallet, address referrer) returns (bool)",
]);
import { CURVE, TIERS } from "./config";
import { applySlippage, type CurveParams } from "./curveMath";
import type {
  Address, CurveState, LaunchCoinParams, LaunchCoinResult, ProtocolClient, TradeParams, TradeQuote, TradeResult,
} from "./protocol";
import { ZERO_ADDRESS } from "./protocol";
import { activeAddress, execCalls, isSmartMode, type ExecResult } from "./wallet";
import { AAError, type Call } from "./aa/core";
const erc20Events = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

const B = BigInt;
const DEFAULT_SLIPPAGE_BPS = 100; // 1%
const now = () => Math.floor(Date.now() / 1000);
const wadToNum = (v: bigint) => Number(v) / 1e18;
/** USD value of `raw` quote units given quotePriceUsd (USD WAD per 1e18 raw units). */
export const quoteRawToUsd = (raw: bigint, quotePriceUsd: bigint) => Number((raw * quotePriceUsd) / B(1e18)) / 1e18;

const fmtUnits = (v: bigint, dec = 18) => { const d = Number(v) / 10 ** dec; return d >= 1e-4 || d === 0 ? d.toPrecision(4) : d.toExponential(2); };

export class ProtocolError extends Error {
  constructor(public code: string, msg: string) { super(msg); }
}

/** Map contract custom errors to friendly copy. */
const ozErrors = parseAbi([
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error Error(string)",
]);
function decodeRevert(data?: Hex): { errorName: string; args?: readonly unknown[] } | null {
  if (!data) return null;
  for (const abi of [bondingCurveAbi, discipleRouterAbi, launchpadAbi, tokenAbi, ozErrors] as const) {
    try { const r = decodeErrorResult({ abi: abi as never, data }); return { errorName: r.errorName, args: r.args as readonly unknown[] | undefined }; } catch { /* next */ }
  }
  return null;
}

export function friendlyError(e: unknown): ProtocolError {
  let name: string | undefined, args: unknown[] | undefined;
  if (e instanceof AAError && e.code === "Estimate") {
    const d = decodeRevert(e.extra?.revertData as Hex | undefined);
    if (d) { name = d.errorName; args = d.args as unknown[] | undefined; }
    else return new ProtocolError("Estimate", e.message);
  }
  if (!name && e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    name = rev?.data?.errorName;
    args = rev?.data?.args as unknown[] | undefined;
  }
  {
    const M: Record<string, string> = {
      QuoteRejected: `That pair token can't be used${args?.[0] ? ` (${String(args[0])})` : ""}. Pick another quote token.`,
      DefaultQuoteUnset: "Launches are paused: the default pair isn't configured yet.",
      PricerUnset: "Launches are paused: the quote price feed isn't configured yet.",
      NoPricePool: "That pair has no USD price pool registered, so it can't be used yet.",
      TaxTooHigh: `Creator tax must be ≤ ${CURVE.creatorTaxMaxPct}%.`,
      InvalidMetadata: "Name, call sign and image are required.",
      CreatorBuyTooLarge: "Creator buy is above Launchpad.creatorBuyMaxBps() (and/or the 7% wallet cap).",
      Slippage: "Price moved too much. Try again or raise slippage.",
      Expired: "The trade took too long and expired. Try again.",
      WalletCap: "Wallet cap reached: one wallet can hold at most 7% before orbit.",
      Graduated: "This rocket reached orbit; trading moved to the v4 pool.",
      NotGraduated: "This rocket is still on the curve.",
      InsufficientLiquidity: "Not enough left on the curve for that size.",
      ZeroAmount: "Amount is too small.",
      ZeroRecipient: "Missing recipient wallet.",
      ERC20InsufficientBalance: "Not enough balance for that shot size — top up the quote token or pick a smaller ammo.",
      ERC20InsufficientAllowance: "Approval too small for that shot size.",
      Error: args?.[0] ? String(args[0]) : "reverted",
    };
    const pre = e instanceof AAError && e.code === "Estimate" ? "simulation: " : "";
    if (name) return new ProtocolError(name, pre + (M[name] || name));
  }
  const code = (e as { code?: string })?.code;
  return new ProtocolError(typeof code === "string" ? code : "Unknown", (e as Error)?.message || String(e));
}

export function publicClient(): PublicClient {
  return createPublicClient({ chain: ACTIVE_CHAIN, transport: http() }) as PublicClient;
}

/* ---------------- reads ---------------- */

/**
 * Live market for a coin. Curve mcapNow()/priceNow() and Trade.mcapAfterUsd FREEZE after graduation (FLOW bug,
 * fixed on-chain later), so graduated coins read MarketLens.market(token) (v4 slot0 × live QuotePricer).
 * Returns null when no lens is configured or the call fails (callers fall back to the curve).
 */
export async function readMarket(pc: PublicClient, token: Address): Promise<{ priceWad: bigint; mcapUsd: number; graduated: boolean } | null> {
  if (!hasLens()) return null;
  try {
    const [priceWad, mcap, graduated] = await pc.readContract({ address: deployment().marketLens, abi: marketLensAbi, functionName: "market", args: [token] });
    return { priceWad, mcapUsd: wadToNum(mcap), graduated };
  } catch { return null; }
}


const paramsCache = new Map<string, CurveParams>();
export async function curveParams(pc: PublicClient, curve: Address): Promise<CurveParams> {
  const hit = paramsCache.get(curve);
  if (hit) return hit;
  const [totalSupply, sCurve, x0, y0] = await pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "curveParams" });
  const p = { totalSupply, sCurve, x0, y0 };
  paramsCache.set(curve, p);
  return p;
}

const decCache = new Map<string, number>();
/** ERC-20 decimals, cached. USDG mainnet = 6, STRATEGY = 18, testnet mUSDG = 18. */
export async function decimalsOf(pc: PublicClient, erc20: Address): Promise<number> {
  const k = erc20.toLowerCase();
  const hit = decCache.get(k);
  if (hit !== undefined) return hit;
  const d = Number(await pc.readContract({ address: erc20, abi: tokenAbi, functionName: "decimals" }));
  decCache.set(k, d);
  return d;
}

const curveCache = new Map<string, Address>();
export async function curveOf(pc: PublicClient, token: Address): Promise<Address> {
  return COIN.get(ckey("curve", token), () => curveOfLive(pc, token)) as Promise<Address>;
}
async function curveOfLive(pc: PublicClient, token: Address): Promise<Address> {
  const hit = curveCache.get(token.toLowerCase());
  if (hit) return hit;
  const c = await pc.readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "curveOf", args: [token] });
  if (c === ZERO_ADDRESS) throw new ProtocolError("NotLaunched", "Not a DISCIPLE rocket.");
  curveCache.set(token.toLowerCase(), c);
  return c;
}

function nextTierOf(mcap: number) {
  const t = TIERS.find((x) => x.lo > mcap);
  return t ? { name: t.name, mcapUsd: t.lo } : null;
}

export async function readCurveState(pc: PublicClient, token: Address): Promise<CurveState> {
  const curve = await curveOf(pc, token);
  const c = { address: curve, abi: bondingCurveAbi } as const;
  const [quote, graduated, quoteReserve, tokensSold, mcapWad, spotWad, quotePriceUsd, taxBps, p, progress, snipe] = await Promise.all([
    pc.readContract({ ...c, functionName: "quote" }),
    pc.readContract({ ...c, functionName: "graduated" }),
    pc.readContract({ ...c, functionName: "quoteReserve" }),
    pc.readContract({ ...c, functionName: "tokensSold" }),
    pc.readContract({ ...c, functionName: "marketCapUsd" }),
    pc.readContract({ ...c, functionName: "spotPriceWad" }),
    pc.readContract({ ...c, functionName: "quotePriceUsd" }),
    pc.readContract({ ...c, functionName: "creatorTaxBps" }),
    curveParams(pc, curve),
    pc.readContract({ ...c, functionName: "progressBps" }),
    pc.readContract({ ...c, functionName: "currentSnipeFeeBps" }),
  ]);
  const quoteDecimals = await decimalsOf(pc, quote);
  const live = graduated ? await readMarket(pc, token) : null;
  const mcapUsd = live ? live.mcapUsd : wadToNum(mcapWad);
  const soldPct = (Number(tokensSold) / Number(p.totalSupply)) * 100;
  const progressBps = Number(progress);
  return {
    token, quote, mcapUsd,
    // spot = quote raw * 1e18 / token raw; quotePriceUsd = USD WAD per 1e18 quote raw ⇒ decimal-agnostic
    priceUsd: live ? mcapUsd / (Number(p.totalSupply) / 1e18) : wadToNum(spotWad) * wadToNum(quotePriceUsd),
    soldPct,
    curveProgressPct: graduated ? 100 : progressBps / 100,
    progressBps: graduated ? 10000 : progressBps,
    snipeFeeBps: Number(snipe),
    quoteDecimals,
    nextTier: nextTierOf(mcapUsd),
    graduated, reserveQuote: quoteReserve, reserveToken: p.sCurve - tokensSold, tokensSold,
    creatorTaxBps: Number(taxBps),
    startMcap: CURVE.startMcap, graduationMcap: CURVE.graduationMcap,
  };
}

/** Curve, graduated, quote token + decimals — cached (graduated=false re-read after 5 s; graduation is one-way). */
export async function coinFacts(pc: PublicClient, token: Address): Promise<{ curve: Address; graduated: boolean; quote: Address; quoteDecimals: number }> {
  const kk = ckey("facts", token);
  const cached = COIN.fresh(kk) as { curve: Address; graduated: boolean; quote: Address; quoteDecimals: number; at: number } | undefined;
  if (cached && (cached.graduated || Date.now() - cached.at < 5000)) return cached;
  const curve = await curveOf(pc, token);
  const c = { address: curve, abi: bondingCurveAbi } as const;
  const [graduated, quote] = await Promise.all([pc.readContract({ ...c, functionName: "graduated" }), pc.readContract({ ...c, functionName: "quote" })]);
  const v = { curve, graduated, quote, quoteDecimals: await decimalsOf(pc, quote), at: Date.now() };
  COIN.set(kk, v); return v;
}

/** amountOut for (token, side, amountIn): the background-warmed value if ≤ maxAge ms old, else a live quote. */
export async function quoteOut(pc: PublicClient, token: Address, side: "buy" | "sell", amountIn: bigint, maxAge = 1500): Promise<bigint> {
  const k = ckey(token, side, amountIn), lk = ckey(token, side);
  const exact = QUOTES.fresh(k, maxAge); if (exact) return exact.amountOut;
  const sc = scaledQuote(LAST_QUOTE.get(lk), amountIn, maxAge); if (sc !== undefined) return sc; // e.g. sell % after balance shrank
  return (await QUOTES.get(k, async () => ({ amountOut: await readAmountOut(pc, token, side, amountIn) }), maxAge)).amountOut;
}
/** amountOut only — ONE eth_call (router quoteExactIn post-grad, curve quoteBuy/quoteSell pre-grad); readQuote also
 * reads the lens for the mcap preview, which a trade doesn't need. */
export async function readAmountOut(pc: PublicClient, token: Address, side: "buy" | "sell", amountIn: bigint): Promise<bigint> {
  const { curve, graduated } = await coinFacts(pc, token);
  if (graduated) {
    const { result } = await pc.simulateContract({ address: deployment().router, abi: discipleRouterAbi, functionName: "quoteExactIn", args: [token, side === "buy", amountIn] });
    return result[0];
  }
  const c = { address: curve, abi: bondingCurveAbi } as const;
  return side === "buy" ? (await pc.readContract({ ...c, functionName: "quoteBuy", args: [amountIn] })).tokensOut : (await pc.readContract({ ...c, functionName: "quoteSell", args: [amountIn] })).quoteOut;
}
/** Background refresh of a preset quote (TradeBridge calls this ~1 s). */
/** After a trade lands, quotes on its route are stale: drop them (the 1 s warm loop re-fills them). */
function dropRouteQuotes(token: Address, ...pair: Address[]) {
  for (const sd of ["buy", "sell"]) LAST_QUOTE.delete(ckey(token, sd));
  if (pair.length === 2) { LAST_QUOTE.delete(ckey("swap", pair[1], pair[0])); LAST_QUOTE.delete(ckey("swap", pair[0], pair[1])); }
  QUOTES.dropWhere((k) => k.startsWith(ckey(token)) || (pair.length === 2 && k.startsWith("swap|")));
}
/** amountIn for a $ shot: USDG mode buys spend mUSDG 1:1 ($1 = 1 USDG, 18 dp); otherwise quote/coin via usdToAmountIn. */
export async function shotAmountIn(pc: PublicClient, token: Address, side: "buy" | "sell", usd: number): Promise<bigint> {
  if (side === "buy") { const { quote } = await coinFacts(pc, token); if (needsHop(quote)) return BigInt(Math.round(usd * 1e6)) * BigInt(1e12); }
  return usdToAmountIn(pc, token, side, usd);
}
/** Warm every quote a tap will need (both hops in USDG mode). */
export async function warmRoute(pc: PublicClient, token: Address, side: "buy" | "sell", amountIn: bigint, slippageBps = DEFAULT_SLIPPAGE_BPS) {
  if (amountIn <= B(0)) return;
  const { quote } = await coinFacts(pc, token);
  if (!needsHop(quote)) return warmQuote(pc, token, side, amountIn);
  const half = hopBps(slippageBps), U = usdgAddress();
  if (side === "buy") { const q1 = await swapQuote(pc, U, quote, amountIn, 0); await warmQuote(pc, token, "buy", applySlippage(q1, half)); }
  else { await warmQuote(pc, token, "sell", amountIn); const q1 = await quoteOut(pc, token, "sell", amountIn); await swapQuote(pc, quote, U, applySlippage(q1, half), 0); }
}
export async function warmQuote(pc: PublicClient, token: Address, side: "buy" | "sell", amountIn: bigint) {
  if (amountIn <= B(0)) return;
  const amountOut = await readAmountOut(pc, token, side, amountIn);
  QUOTES.set(ckey(token, side, amountIn), { amountOut }); LAST_QUOTE.set(ckey(token, side), { amountIn, amountOut, at: Date.now() });
}

/** Exact preview for the current block. Curve views pre-grad, router eth_call post-grad. */
export async function readQuote(pc: PublicClient, token: Address, side: "buy" | "sell", amountIn: bigint): Promise<TradeQuote> {
  const curve = await curveOf(pc, token);
  const c = { address: curve, abi: bondingCurveAbi } as const;
  const { graduated, quoteDecimals } = await coinFacts(pc, token);
  const base = { side, amountIn, quoteDecimals, snipeFee: B(0), graduates: false } as const;

  if (graduated) {
    if (!hasRouter()) throw new ProtocolError("NoRouter", "This rocket reached orbit; the router isn't configured on this network yet.");
    // Not a view (v4 has no view swaps): eth_call via simulateContract. Includes the hook's 1%.
    const { result: [amountOut, impactBps, mcapAfterUsd] } = await pc.simulateContract({
      address: deployment().router, abi: discipleRouterAbi, functionName: "quoteExactIn", args: [token, side === "buy", amountIn],
    });
    const bps = Number(impactBps) * (side === "buy" ? 1 : -1); // impactBps is unsigned; sign from side
    // Router's mcapAfterUsd is frozen post-grad: recompute from the live lens mcap and the on-chain impact.
    const live = await readMarket(pc, token);
    const mcapAfter = live ? live.mcapUsd * (1 + bps / 10000) : wadToNum(mcapAfterUsd);
    return { ...base, amountOut, fee: B(0), impactBps: bps, impactPct: bps / 100, mcapAfterUsd: mcapAfter, venue: "router" };
  }

  if (side === "buy") {
    const q = await pc.readContract({ ...c, functionName: "quoteBuy", args: [amountIn] });
    const bps = Number(q.impactBps);
    return { ...base, amountOut: q.tokensOut, fee: q.fee, snipeFee: q.snipeFee, impactBps: bps, impactPct: bps / 100,
             mcapAfterUsd: wadToNum(q.mcapAfterUsd), graduates: q.graduates, venue: "curve" };
  }
  const q = await pc.readContract({ ...c, functionName: "quoteSell", args: [amountIn] });
  const bps = -Number(q.impactBps);
  return { ...base, amountOut: q.quoteOut, fee: q.fee, impactBps: bps, impactPct: bps / 100,
           mcapAfterUsd: wadToNum(q.mcapAfterUsd), venue: "curve" };
}

/** Launchpad.quoteCreatorBuy: preview the optional same-tx creator buy. quote = 0 ⇒ default quote. */
export async function readCreatorBuyQuote(pc: PublicClient, quote: Address, quoteIn: bigint, creatorTaxBps: number) {
  const [tokensOut, fee, snipeFee, quotePriceUsd, exceedsCap] = await pc.readContract({
    address: deployment().launchpad, abi: launchpadAbi, functionName: "quoteCreatorBuy", args: [quote, quoteIn, B(creatorTaxBps)],
  });
  return { tokensOut, fee, snipeFee, quotePriceUsd, exceedsCap };
}

/** On-chain creator-buy supply cap in bps (v3 default 77 = 0.77%). Prefer this over any hardcoded UI limit. */
export async function readCreatorBuyMaxBps(pc: PublicClient) {
  return Number(await pc.readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "creatorBuyMaxBps" }));
}

/**
 * Convert a $ shot into the raw amount to spend: quote raw for buys, token raw (18 dec) for sells,
 * using the curve's launch-fixed quotePriceUsd (USD WAD per 1e18 quote raw ⇒ decimal-agnostic).
 */
export async function usdToAmountIn(pc: PublicClient, token: Address, side: "buy" | "sell", usd: number): Promise<bigint> {
  const curve = await curveOf(pc, token);
  const c = { address: curve, abi: bondingCurveAbi } as const;
  const qp = await COIN.get(ckey("qp", curve), () => pc.readContract({ ...c, functionName: "quotePriceUsd" })) as bigint;   // launch-fixed
  const usdMicro = B(Math.max(1, Math.round(usd * 1e6)));
  if (side === "buy") return (usdMicro * B(1e18) * B(1e18)) / (qp * B(1e6));
  const [mcapWad, p] = await Promise.all([pc.readContract({ ...c, functionName: "mcapNow" }), curveParams(pc, curve)]);
  const live = await readMarket(pc, token);
  if (live?.graduated && live.mcapUsd > 0) return (usdMicro * p.totalSupply) / B(Math.round(live.mcapUsd * 1e6)); // tokens = usd / mcap × supply
  return mcapWad > B(0) ? (usdMicro * B(1e12) * p.totalSupply) / mcapWad : B(0);
}

export async function tokenBalance(pc: PublicClient, erc20: Address, owner: Address) {
  const b = await pc.readContract({ address: erc20, abi: tokenAbi, functionName: "balanceOf", args: [owner] });
  BALANCES.set(ckey(erc20, owner), b); return b;
}
/**
 * Apply a known delta (e.g. coin received, from the receipt logs) to the cached balance. Reading balanceOf right after
 * a sync receipt can hit an RPC node one block behind (0 after a first buy ⇒ "NO TOKENS IN WALLET" on the next sell).
 */
export function bumpBalance(erc20: Address, owner: Address, delta: bigint) {
  const k = ckey(erc20, owner), cur = BALANCES.fresh(k, 60_000);
  if (cur !== undefined) BALANCES.set(k, cur + delta > B(0) ? cur + delta : B(0)); else if (delta > B(0)) BALANCES.set(k, delta);
}
/** Balance hint ≤ maxAge ms old (polled / refreshed after trades), else a live read. */
export async function balanceHint(pc: PublicClient, erc20: Address, owner: Address, maxAge = 5000) {
  return BALANCES.get(ckey(erc20, owner), () => pc.readContract({ address: erc20, abi: tokenAbi, functionName: "balanceOf", args: [owner] }), maxAge);
}

/* ---------------- client ---------------- */

export function createViemProtocol(): ProtocolClient {
  const pc = publicClient();

  /** Approval call if needed. Smart account: exact amount, batched into the same userOp. EOA: max once. */
  async function approveCall(owner: Address, erc20: Address, spender: Address, amt: bigint): Promise<Call[]> {
    const cur = await pc.readContract({ address: erc20, abi: tokenAbi, functionName: "allowance", args: [owner, spender] });
    if (cur >= amt) return [];
    return [{ to: erc20, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [spender, isSmartMode() ? amt : maxUint256] }) }];
  }
  /** Sum ERC-20 Transfer(to=recipient) of `asset` in the receipt logs. */
  function received(logs: ExecResult["logs"], asset: Address, recipient: Address) {
    let out = B(0);
    for (const l of logs) {
      if (l.address.toLowerCase() !== asset.toLowerCase()) continue;
      try { const ev = decodeEventLog({ abi: erc20Events, data: l.data, topics: l.topics as [Hex, ...Hex[]] }); if (ev.eventName === "Transfer" && ev.args.to.toLowerCase() === recipient.toLowerCase()) out += ev.args.value; } catch { /* not a transfer */ }
    }
    return out;
  }

  /**
   * Referrer (from /r/<name>, lib/referral) → chain. Neither BondingCurve.buy nor DiscipleRouter.buyExactIn takes a
   * referrer arg: FeeRouter pays the trader's ReferralRegistry.referrerOf(trader). So on a buy we prepend
   * ReferralRegistry.tryAttribute(me, ref) once, only when nothing is pending/attributed (it reverts otherwise).
   * Opt-in via NEXT_PUBLIC_REFERRAL_ATTRIBUTE=1 until contracts confirm who may call tryAttribute.
   */
  async function referralCall(me: Address): Promise<{ to: Address; data: Hex }[]> {
    const reg = deployment().referralRegistry;
    const ref = referrerWallet(me);
    if (process.env.NEXT_PUBLIC_REFERRAL_ATTRIBUTE !== "1" || !ref || reg === ZERO_ADDR) return [];
    try {
      const [cur, pending] = await Promise.all([
        pc.readContract({ address: reg, abi: referralRegistryAbi, functionName: "referrerOf", args: [me] }),
        pc.readContract({ address: reg, abi: referralRegistryAbi, functionName: "pendingReferrer", args: [me] }),
      ]);
      if (cur !== ZERO_ADDR || pending !== ZERO_ADDR) return [];
      return [{ to: reg, data: encodeFunctionData({ abi: referralRegistryAbi, functionName: "tryAttribute", args: [me, ref] }) }];
    } catch { return []; }
  }

  const refDone = new Set<string>();
  /** referralCall, but once it resolved to "nothing to attribute" for this wallet it stays [] (no 2 reads per buy). */
  async function referralCallCached(me: Address) {
    if (refDone.has(me.toLowerCase())) return [];
    const r = await referralCall(me); if (!r.length) refDone.add(me.toLowerCase()); return r;
  }

  async function trade(side: "buy" | "sell", t: TradeParams): Promise<TradeResult> {
    if (!isDeployed()) throw new ProtocolError("NotDeployed", "Contracts not deployed on this chain yet.");
    try {
      // Hot path: coin facts cached, quote/balance/referral/allowance in PARALLEL (warm tap ⇒ all cache hits, 0 RPCs).
      const [{ curve, graduated, quote: quoteAsset }, me] = await Promise.all([coinFacts(pc, t.token), activeAddress()]);
      const recipient = t.recipient || me;
      const deadline = B(t.deadline || now() + 120);
      if (needsHop(quoteAsset)) return await tradeViaUsdg(side, t, { curve, graduated, quoteAsset, me, recipient, deadline });
      const spendAsset = side === "buy" ? quoteAsset : t.token;
      const outAsset = side === "buy" ? t.token : quoteAsset;
      const smart = isSmartMode();
      const [qOut, have, refCalls, approve] = await Promise.all([
        t.minAmountOut > B(0) ? Promise.resolve(B(0)) : marginalQuote(ckey("coin", t.token, side), t.amountIn, (a, age) => quoteOut(pc, t.token, side, a, age)),
        balanceHint(pc, spendAsset, me),
        side === "buy" ? referralCallCached(me) : Promise.resolve([]),
        smart ? Promise.resolve(null) : approveCall(me, spendAsset, graduated ? deployment().router : curve, t.amountIn),
      ]);
      const minOut = t.minAmountOut > B(0) ? t.minAmountOut : applySlippage(qOut, t.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
      let target: Address, data: Hex;
      if (graduated) {
        if (!hasRouter()) throw new ProtocolError("NoRouter", "This rocket reached orbit; the router isn't configured on this network yet.");
        target = deployment().router;
        data = encodeFunctionData({ abi: discipleRouterAbi, functionName: side === "buy" ? "buyExactIn" : "sellExactIn", args: [t.token, t.amountIn, minOut, recipient, deadline] });
      } else {
        target = curve;
        data = encodeFunctionData({ abi: bondingCurveAbi, functionName: side, args: [t.amountIn, minOut, deadline, recipient] });
      }
      // Preflight: an underfunded spend otherwise surfaces only as an opaque estimate failure / on-chain revert.
      if (have < t.amountIn) {
        const live = await pc.readContract({ address: spendAsset, abi: tokenAbi, functionName: "balanceOf", args: [me] });   // hint may be stale-low
        BALANCES.set(ckey(spendAsset, me), live);
        if (live < t.amountIn) {
          const [sym, dec] = await Promise.all([
            pc.readContract({ address: spendAsset, abi: tokenAbi, functionName: "symbol" }).catch(() => "token"),
            pc.readContract({ address: spendAsset, abi: tokenAbi, functionName: "decimals" }).catch(() => 18),
          ]);
          throw new ProtocolError("InsufficientBalance", `not enough ${sym}: need ${fmtUnits(t.amountIn, Number(dec))} have ${fmtUnits(live, Number(dec))}`);
        }
      }
      // Smart account: exact approve batched into the same op, always (no allowance read on the hot path).
      const approveCalls = smart ? [{ to: spendAsset, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [target, t.amountIn] }) }] : (approve ?? []);
      const calls = [...refCalls, ...approveCalls, { to: target, data }];
      BALANCES.set(ckey(spendAsset, me), have - t.amountIn);   // optimistic; corrected by the next poll
      const done = addInflight(ckey("coin", t.token, side), t.amountIn);
      try {
        const r = await execCalls(calls);
        return { ok: true, txHash: r.txHash, amountOut: received(r.logs, outAsset, recipient) || minOut };
      } finally { done(); dropRouteQuotes(t.token); }
    } catch (e) {
      if (e instanceof ProtocolError) throw e;
      throw friendlyError(e);
    }
  }

  /**
   * Pay-in-USDG (lib/trade/usdgRoute): buy = mUSDG→quote (v4 ref pool) + quote→coin; sell = coin→quote + quote→mUSDG.
   * ONE userOp. t.amountIn is mUSDG for buys, coin for sells; amountOut is coin (buy) / mUSDG (sell).
   * Quotes (both hops, parallel where possible) come from the warm cache ⇒ 0 RPCs on a warm tap.
   */
  async function tradeViaUsdg(side: "buy" | "sell", t: TradeParams, c: { curve: Address; graduated: boolean; quoteAsset: Address; me: Address; recipient: Address; deadline: bigint }): Promise<TradeResult> {
    const U = usdgAddress(), Q = c.quoteAsset, half = hopBps(t.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
    const target = c.graduated ? deployment().router : c.curve;
    if (c.graduated && !hasRouter()) throw new ProtocolError("NoRouter", "This rocket reached orbit; the router isn't configured on this network yet.");
    const coinCall = (s: "buy" | "sell", amtIn: bigint, min: bigint, to: Address): Call => c.graduated
      ? { to: target, data: encodeFunctionData({ abi: discipleRouterAbi, functionName: s === "buy" ? "buyExactIn" : "sellExactIn", args: [t.token, amtIn, min, to, c.deadline] }) }
      : { to: target, data: encodeFunctionData({ abi: bondingCurveAbi, functionName: s, args: [amtIn, min, c.deadline, to] }) };
    const approve = (tok: Address, amt: bigint): Call => ({ to: tok, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [target, amt] }) });
    const spend = side === "buy" ? U : t.token;
    const have = await balanceHint(pc, spend, c.me);
    if (have < t.amountIn) {
      const live = await pc.readContract({ address: spend, abi: tokenAbi, functionName: "balanceOf", args: [c.me] }); BALANCES.set(ckey(spend, c.me), live);
      if (live < t.amountIn) throw new ProtocolError("InsufficientBalance", `not enough ${side === "buy" ? "mUSDG" : "tokens"}: need ${fmtUnits(t.amountIn, 18)} have ${fmtUnits(live, 18)}`);
    }
    let calls: Call[], minOut: bigint, outAsset: Address;
    const k1 = ckey("swap", side === "buy" ? U : Q, side === "buy" ? Q : U), k2 = ckey("coin", t.token, side);
    const swapQ = (from: Address, to: Address) => (a: bigint, age?: number) => swapQuote(pc, from, to, a, age);
    const coinQ = (a: bigint, age?: number) => quoteOut(pc, t.token, side, a, age);
    let hop1In = B(0), hop2In = B(0);
    if (side === "buy") {
      // hop 1 exact-out: get q1min of the pair for ≤ amountIn mUSDG (leftover stays mUSDG, no pair-token dust)
      const q1 = await marginalQuote(k1, t.amountIn, swapQ(U, Q)); const q1min = applySlippage(q1, half);
      const q2 = await marginalQuote(k2, q1min, coinQ); minOut = t.minAmountOut > B(0) ? t.minAmountOut : applySlippage(q2, half);
      hop1In = t.amountIn; hop2In = q1min;
      calls = [...(await referralCallCached(c.me)), ...buyHopCalls(U, Q, t.amountIn, q1min, c.deadline), approve(Q, q1min), coinCall("buy", q1min, minOut, c.recipient)];
      outAsset = t.token;
    } else {
      // sell proceeds → UniversalRouter, which swaps ALL of them to mUSDG for the account (no dust, no approvals)
      const q1 = await marginalQuote(k2, t.amountIn, coinQ); const q1min = applySlippage(q1, half);
      const q2 = await marginalQuote(k1, q1min, swapQ(Q, U)); minOut = t.minAmountOut > B(0) ? t.minAmountOut : applySlippage(q2, half);
      hop1In = q1min; hop2In = t.amountIn;
      calls = [approve(t.token, t.amountIn), coinCall("sell", t.amountIn, q1min, UNIVERSAL_ROUTER), sellHopCall(Q, U, minOut, c.deadline)];
      outAsset = U;
    }
    BALANCES.set(ckey(spend, c.me), have - t.amountIn);
    const done = [addInflight(k1, hop1In), addInflight(k2, hop2In)];
    try {
      const r = await execCalls(calls);
      return { ok: true, txHash: r.txHash, amountOut: received(r.logs, outAsset, side === "buy" ? c.recipient : c.me) || minOut };
    } finally { done.forEach((f) => f()); dropRouteQuotes(t.token, Q, U); }
  }

  return {
    async launchCoin(lp: LaunchCoinParams): Promise<LaunchCoinResult> {
      if (!isDeployed()) throw new ProtocolError("NotDeployed", "Contracts not deployed on this chain yet.");
      const launchpad = deployment().launchpad;
      const creatorBuy = lp.creatorBuyQuoteIn ?? B(0);
      const params = {
        name: lp.name, ticker: lp.ticker, imageURI: lp.imageUri,
        description: lp.description || "", socialsURI: lp.socials ? JSON.stringify(lp.socials) : "",
        quote: lp.quoteToken, // address(0) → Launchpad.defaultQuote (STRATEGY); priced on-chain by QuotePricer
        creatorTaxBps: B(Math.round(lp.creatorTaxPct * 100)),
        creatorBuyQuoteIn: creatorBuy,
        creatorBuyMinTokensOut: B(0), // filled from Launchpad.quoteCreatorBuy below
        deadline: B(now() + 300),
      };
      try {
        const me = await activeAddress();
        const calls: Call[] = [];
        if (creatorBuy > B(0)) {
          const cq = await readCreatorBuyQuote(pc, lp.quoteToken, creatorBuy, Number(params.creatorTaxBps));
          if (cq.exceedsCap) throw new ProtocolError("CreatorBuyTooLarge", "Creator buy exceeds Launchpad.creatorBuyMaxBps() / wallet cap. Lower it.");
          params.creatorBuyMinTokensOut = applySlippage(cq.tokensOut, lp.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
          const q = lp.quoteToken !== ZERO_ADDRESS ? lp.quoteToken
            : await pc.readContract({ address: launchpad, abi: launchpadAbi, functionName: "defaultQuote" });
          // creator buy pulls amount + launch fee headroom; approve with 5% slack
          calls.push(...(await approveCall(me, q, launchpad, creatorBuy + creatorBuy / B(20))));
        }
        calls.push({ to: launchpad, data: encodeFunctionData({ abi: launchpadAbi, functionName: "launchCoin", args: [params] }) });
        const r = await execCalls(calls);
        for (const l of r.logs) {
          if (l.address.toLowerCase() !== launchpad.toLowerCase()) continue;
          try { const ev = decodeEventLog({ abi: launchpadAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }); if (ev.eventName === "Launched") return { token: ev.args.token as Address, curve: ev.args.curve as Address, txHash: r.txHash }; } catch { /* other event */ }
        }
        throw new ProtocolError("NoLaunchEvent", `Launch tx ${r.txHash} had no Launched event.`);
      } catch (e) {
        throw e instanceof ProtocolError ? e : friendlyError(e);
      }
    },
    buy: (t) => trade("buy", t),
    sell: (t) => trade("sell", t),
    quote: (token, side, amountIn) => readQuote(pc, token, side, amountIn),
    getCurveState: (token) => readCurveState(pc, token),
    async impactPct(token, side, usd) {
      return (await readQuote(pc, token, side, await usdToAmountIn(pc, token, side, usd))).impactPct;
    },
  };
}
