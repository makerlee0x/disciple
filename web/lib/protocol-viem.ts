/**
 * viem implementation of ProtocolClient against DISCIPLE FLOW PR #4 (flow/contracts-api).
 *  - No custody/vault: the Privy embedded wallet (lib/wallet.ts) signs every tx.
 *  - Approve once (max) per spender: curve pre-grad, DiscipleRouter post-grad, Launchpad for creator buys.
 *  - Previews come from on-chain views (quoteBuy/quoteSell) or router.quoteExactIn (eth_call) post-grad.
 *  - Quote decimals are read per token (USDG = 6, STRATEGY = 18); never assumed.
 */
import {
  BaseError, ContractFunctionRevertedError, createPublicClient, decodeErrorResult, decodeEventLog, encodeFunctionData, http, maxUint256, parseAbi, type Hex, type PublicClient,
} from "viem";
import { bondingCurveAbi, discipleRouterAbi, launchpadAbi, marketLensAbi, tokenAbi } from "./abi";
import { ACTIVE_CHAIN, deployment, hasLens, hasRouter, isDeployed } from "./chains";
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

/** Exact preview for the current block. Curve views pre-grad, router eth_call post-grad. */
export async function readQuote(pc: PublicClient, token: Address, side: "buy" | "sell", amountIn: bigint): Promise<TradeQuote> {
  const curve = await curveOf(pc, token);
  const c = { address: curve, abi: bondingCurveAbi } as const;
  const [graduated, quote] = await Promise.all([
    pc.readContract({ ...c, functionName: "graduated" }),
    pc.readContract({ ...c, functionName: "quote" }),
  ]);
  const quoteDecimals = await decimalsOf(pc, quote);
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
  const [qp, mcapWad, p] = await Promise.all([
    pc.readContract({ ...c, functionName: "quotePriceUsd" }),
    pc.readContract({ ...c, functionName: "mcapNow" }),
    curveParams(pc, curve),
  ]);
  const usdMicro = B(Math.max(1, Math.round(usd * 1e6)));
  if (side === "buy") return (usdMicro * B(1e18) * B(1e18)) / (qp * B(1e6));
  const live = await readMarket(pc, token);
  if (live?.graduated && live.mcapUsd > 0) return (usdMicro * p.totalSupply) / B(Math.round(live.mcapUsd * 1e6)); // tokens = usd / mcap × supply
  return mcapWad > B(0) ? (usdMicro * B(1e12) * p.totalSupply) / mcapWad : B(0);
}

export async function tokenBalance(pc: PublicClient, erc20: Address, owner: Address) {
  return pc.readContract({ address: erc20, abi: tokenAbi, functionName: "balanceOf", args: [owner] });
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

  async function trade(side: "buy" | "sell", t: TradeParams): Promise<TradeResult> {
    if (!isDeployed()) throw new ProtocolError("NotDeployed", "Contracts not deployed on this chain yet.");
    try {
      const curve = await curveOf(pc, t.token);
      const graduated = await pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "graduated" });
      const quoteAsset = await pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "quote" });
      const me = await activeAddress();
      const recipient = t.recipient || me;
      const deadline = B(t.deadline || now() + 120);
      let minOut = t.minAmountOut;
      if (minOut <= B(0)) {
        const q = await readQuote(pc, t.token, side, t.amountIn);
        minOut = applySlippage(q.amountOut, t.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
      }
      const spendAsset = side === "buy" ? quoteAsset : t.token;
      const outAsset = side === "buy" ? t.token : quoteAsset;
      let target: Address, data: Hex;
      if (graduated) {
        if (!hasRouter()) throw new ProtocolError("NoRouter", "This rocket reached orbit; the router isn't configured on this network yet.");
        target = deployment().router;
        data = encodeFunctionData({ abi: discipleRouterAbi, functionName: side === "buy" ? "buyExactIn" : "sellExactIn", args: [t.token, t.amountIn, minOut, recipient, deadline] });
      } else {
        target = curve;
        data = encodeFunctionData({ abi: bondingCurveAbi, functionName: side, args: [t.amountIn, minOut, deadline, recipient] });
      }
      // Preflight: an underfunded spend otherwise surfaces only as an opaque eth_estimateUserOperationGas failure.
      const have = await pc.readContract({ address: spendAsset, abi: tokenAbi, functionName: "balanceOf", args: [me] });
      if (have < t.amountIn) {
        const [sym, dec] = await Promise.all([
          pc.readContract({ address: spendAsset, abi: tokenAbi, functionName: "symbol" }).catch(() => "token"),
          pc.readContract({ address: spendAsset, abi: tokenAbi, functionName: "decimals" }).catch(() => 18),
        ]);
        throw new ProtocolError("InsufficientBalance", `not enough ${sym}: need ${fmtUnits(t.amountIn, Number(dec))} have ${fmtUnits(have, Number(dec))}`);
      }
      const calls = [...(await approveCall(me, spendAsset, target, t.amountIn)), { to: target, data }];
      const r = await execCalls(calls);
      return { ok: true, txHash: r.txHash, amountOut: received(r.logs, outAsset, recipient) || minOut };
    } catch (e) {
      if (e instanceof ProtocolError) throw e;
      throw friendlyError(e);
    }
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
