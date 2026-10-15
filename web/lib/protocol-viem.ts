/**
 * viem implementation of ProtocolClient against DISCIPLE FLOW contracts (flow/contracts-v0).
 * Read paths use a public client. Write paths go through either:
 *  - custody executor (default): user approved once at deposit; platform submits trades, or
 *  - direct wallet (NEXT_PUBLIC_DIRECT_WALLET=1, dev only): injected wallet signs each tx.
 */
import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, custom, http,
  maxUint256, parseUnits, type Address as VAddress, type PublicClient, type WalletClient,
} from "viem";
import { bondingCurveAbi, launchpadAbi, tokenAbi } from "./abi";
import { ACTIVE_CHAIN, DIRECT_WALLET, deployment, isDeployed } from "./chains";
import { CURVE, TIERS } from "./config";
import { applySlippage, impactPctBetween, quoteBuy, quoteSell, WAD, type CurveParams } from "./curveMath";
import type {
  Address, CurveState, LaunchCoinParams, LaunchCoinResult, ProtocolClient, TradeParams, TradeResult,
} from "./protocol";
import { ZERO_ADDRESS } from "./protocol";

const B = BigInt;
const DEFAULT_SLIPPAGE_BPS = 100; // 1%
const now = () => Math.floor(Date.now() / 1000);
const wadToNum = (v: bigint) => Number(v) / 1e18;

export class ProtocolError extends Error {
  constructor(public code: string, msg: string) { super(msg); }
}

/** Map contract custom errors to friendly copy. */
export function friendlyError(e: unknown): ProtocolError {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = rev?.data?.errorName;
    const args = rev?.data?.args as unknown[] | undefined;
    const M: Record<string, string> = {
      QuoteRejected: `That pair token can't be used${args?.[0] ? ` (${String(args[0])})` : ""}. Pick another quote token.`,
      DefaultQuoteUnset: "Launches are paused: the default pair isn't configured yet.",
      TaxTooHigh: `Creator tax must be ≤ ${CURVE.creatorTaxMaxPct}%.`,
      InvalidMetadata: "Name, call sign and image are required.",
      CreatorBuyTooLarge: "Creator buy is above the allowed maximum.",
      Slippage: "Price moved too much. Try again or raise slippage.",
      Expired: "The trade took too long and expired. Try again.",
      WalletCap: "Wallet cap reached: one wallet can hold at most 7% before orbit.",
      Graduated: "This rocket reached orbit; trading moved to the v4 pool.",
      InsufficientLiquidity: "Not enough left on the curve for that size.",
      ZeroAmount: "Amount is too small.",
    };
    if (name) return new ProtocolError(name, M[name] || name);
  }
  return new ProtocolError("Unknown", (e as Error)?.message || String(e));
}

/** Custody executor seam: platform submits the trade for the user (no per-trade signature). */
export interface CustodyExecutor {
  trade(req: { curve: Address; side: "buy" | "sell"; amountIn: string; minAmountOut: string; deadline: number }): Promise<TradeResult>;
  launch(req: { params: unknown }): Promise<LaunchCoinResult>;
}

/** Default executor → /api/execute (server relay). TODO(FLOW): needs a custody/vault contract; see PR gaps. */
export const httpExecutor: CustodyExecutor = {
  async trade(req) {
    const r = await fetch("/api/execute/trade", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
    const j = await r.json();
    if (!r.ok) throw new ProtocolError(j.code || "ExecutorError", j.error || "Executor unavailable");
    return j;
  },
  async launch(req) {
    const r = await fetch("/api/execute/launch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
    const j = await r.json();
    if (!r.ok) throw new ProtocolError(j.code || "ExecutorError", j.error || "Executor unavailable");
    return j;
  },
};

export function publicClient(): PublicClient {
  return createPublicClient({ chain: ACTIVE_CHAIN, transport: http() }) as PublicClient;
}

async function walletClient(): Promise<WalletClient & { account: { address: VAddress } }> {
  const eth = (globalThis as { ethereum?: unknown }).ethereum;
  if (!eth) throw new ProtocolError("NoWallet", "No injected wallet found (direct-wallet dev mode).");
  const w = createWalletClient({ chain: ACTIVE_CHAIN, transport: custom(eth as Parameters<typeof custom>[0]) });
  const [address] = await w.requestAddresses();
  return Object.assign(w, { account: { address } }) as WalletClient & { account: { address: VAddress } };
}

/* ---------------- reads ---------------- */

const paramsCache = new Map<string, CurveParams>();
export async function curveParams(pc: PublicClient, curve: Address): Promise<CurveParams> {
  const hit = paramsCache.get(curve);
  if (hit) return hit;
  const [totalSupply, sCurve, x0, y0] = await pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "curveParams" });
  const p = { totalSupply, sCurve, x0, y0 };
  paramsCache.set(curve, p);
  return p;
}

export async function curveOf(pc: PublicClient, token: Address): Promise<Address> {
  const c = await pc.readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "curveOf", args: [token] });
  if (c === ZERO_ADDRESS) throw new ProtocolError("NotLaunched", "Not a DISCIPLE rocket.");
  return c;
}

function nextTierOf(mcap: number) {
  const t = TIERS.find((x) => x.lo > mcap);
  return t ? { name: t.name, mcapUsd: t.lo } : null;
}

export async function readCurveState(pc: PublicClient, token: Address): Promise<CurveState> {
  const curve = await curveOf(pc, token);
  const c = { address: curve, abi: bondingCurveAbi } as const;
  const [quote, graduated, quoteReserve, tokensSold, mcapWad, spotWad, quotePriceUsd, taxBps, p] = await Promise.all([
    pc.readContract({ ...c, functionName: "quote" }),
    pc.readContract({ ...c, functionName: "graduated" }),
    pc.readContract({ ...c, functionName: "quoteReserve" }),
    pc.readContract({ ...c, functionName: "tokensSold" }),
    pc.readContract({ ...c, functionName: "marketCapUsd" }),
    pc.readContract({ ...c, functionName: "spotPriceWad" }),
    pc.readContract({ ...c, functionName: "quotePriceUsd" }),
    pc.readContract({ ...c, functionName: "creatorTaxBps" }),
    curveParams(pc, curve),
  ]);
  const mcapUsd = wadToNum(mcapWad);
  const soldPct = (Number(tokensSold) / Number(p.totalSupply)) * 100;
  return {
    token, quote, mcapUsd,
    priceUsd: (Number(spotWad) / 1e18) * wadToNum(quotePriceUsd),
    soldPct,
    curveProgressPct: Math.min(100, (Number(tokensSold) / Number(p.sCurve)) * 100),
    nextTier: nextTierOf(mcapUsd),
    graduated, reserveQuote: quoteReserve, reserveToken: p.sCurve - tokensSold, tokensSold,
    creatorTaxBps: Number(taxBps),
    startMcap: CURVE.startMcap, graduationMcap: CURVE.graduationMcap,
  };
}

/* ---------------- client ---------------- */

export function createViemProtocol(executor: CustodyExecutor = httpExecutor): ProtocolClient {
  const pc = publicClient();

  async function ensureAllowance(w: Awaited<ReturnType<typeof walletClient>>, erc20: Address, spender: Address, amt: bigint) {
    const cur = await pc.readContract({ address: erc20, abi: tokenAbi, functionName: "allowance", args: [w.account.address, spender] });
    if (cur >= amt) return;
    const h = await w.writeContract({ chain: ACTIVE_CHAIN, account: w.account.address, address: erc20, abi: tokenAbi, functionName: "approve", args: [spender, maxUint256] });
    await pc.waitForTransactionReceipt({ hash: h });
  }

  async function trade(side: "buy" | "sell", t: TradeParams): Promise<TradeResult> {
    if (!isDeployed()) throw new ProtocolError("NotDeployed", "Contracts not deployed on this chain yet.");
    try {
      const curve = await curveOf(pc, t.token);
      const st = await readCurveState(pc, t.token);
      if (st.graduated) {
        // TODO(FLOW): post-graduation swaps go through the v4 pool (fee 0; DiscipleHook takes 1%).
        // No router/quoter is in flow/contracts-v0 → needs a v4 Universal Router / V4Router address.
        throw new ProtocolError("Graduated", "This rocket reached orbit. v4 routing is not wired yet (TODO: router).");
      }
      const p = await curveParams(pc, curve);
      const taxBps = B(st.creatorTaxBps);
      const expected = side === "buy" ? quoteBuy(p, st.tokensSold, t.amountIn, taxBps) : quoteSell(p, st.tokensSold, t.amountIn, taxBps);
      const minOut = t.minAmountOut > B(0) ? t.minAmountOut : applySlippage(expected, t.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
      const deadline = t.deadline || now() + 120;

      if (!DIRECT_WALLET) {
        return executor.trade({ curve, side, amountIn: t.amountIn.toString(), minAmountOut: minOut.toString(), deadline });
      }
      const w = await walletClient();
      await ensureAllowance(w, side === "buy" ? st.quote : t.token, curve, t.amountIn);
      const { request, result } = await pc.simulateContract({
        account: w.account.address, address: curve, abi: bondingCurveAbi,
        functionName: side, args: [t.amountIn, minOut, B(deadline)],
      });
      const hash = await w.writeContract(request);
      await pc.waitForTransactionReceipt({ hash });
      return { ok: true, txHash: hash, amountOut: result as bigint };
    } catch (e) {
      if (e instanceof ProtocolError) throw e;
      throw friendlyError(e);
    }
  }

  return {
    async launchCoin(lp: LaunchCoinParams): Promise<LaunchCoinResult> {
      if (!isDeployed()) throw new ProtocolError("NotDeployed", "Contracts not deployed on this chain yet.");
      if (!lp.quotePriceUsd || lp.quotePriceUsd <= 0)
        // GAP: Launchpad trusts a caller-supplied quotePriceUsd (no oracle). We must source it (DexScreener / FLOW oracle).
        throw new ProtocolError("NoQuotePrice", "Missing quote price (TODO: price source for quotePriceUsd).");
      const params = {
        name: lp.name, ticker: lp.ticker, imageURI: lp.imageUri,
        description: lp.description || "", socialsURI: lp.socials ? JSON.stringify(lp.socials) : "",
        quote: lp.quoteToken, // address(0) → Launchpad.defaultQuote (STRATEGY)
        quotePriceUsd: parseUnits(lp.quotePriceUsd.toFixed(18), 18),
        creatorTaxBps: B(Math.round(lp.creatorTaxPct * 100)),
        creatorBuyQuoteIn: B(0), creatorBuyMinTokensOut: B(0),
        deadline: B(now() + 300),
      } as const;
      try {
        if (!DIRECT_WALLET) return executor.launch({ params: JSON.parse(JSON.stringify(params, (_, v) => (typeof v === "bigint" ? v.toString() : v))) });
        const w = await walletClient();
        const { request, result } = await pc.simulateContract({
          account: w.account.address, address: deployment().launchpad, abi: launchpadAbi, functionName: "launchCoin", args: [params],
        });
        const hash = await w.writeContract(request);
        await pc.waitForTransactionReceipt({ hash });
        return { token: result.token, curve: result.curve, txHash: hash };
      } catch (e) {
        throw e instanceof ProtocolError ? e : friendlyError(e);
      }
    },
    buy: (t) => trade("buy", t),
    sell: (t) => trade("sell", t),
    getCurveState: (token) => readCurveState(pc, token),
    async impactPct(token, side, usd) {
      // Pre-trade estimate from curve math (post-trade impact comes from Trade events in lib/events.ts).
      const curve = await curveOf(pc, token);
      const st = await readCurveState(pc, token);
      const p = await curveParams(pc, curve);
      const qp = await pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "quotePriceUsd" });
      const quoteAmt = (B(Math.round(usd * 1e6)) * WAD * WAD) / (qp * B(1e6));
      if (side === "buy") return impactPctBetween(p, st.tokensSold, st.tokensSold + quoteBuy(p, st.tokensSold, quoteAmt, B(st.creatorTaxBps)));
      const spot = (await pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "spotPriceWad" })) as bigint;
      const tokensIn = (quoteAmt * WAD) / (spot || B(1));
      const after = st.tokensSold > tokensIn ? st.tokensSold - tokensIn : B(0);
      return impactPctBetween(p, st.tokensSold, after);
    },
  };
}
