/**
 * Pay-in-USDG via DiscipleRouter.buyWithUsdg / sellToUsdg (FLOW PR #65, policy 1.3.0). Replaces the old
 * UniversalRouter V4_SWAP + Permit2 route (dropped by FLOW 2026-10-16).
 *  - The router hops USDG ⇄ the coin's quote through an owner-registered pool, then the curve (pre-grad) or the coin's
 *    v4 pool (post-grad). Recipient is pinned on-chain to msg.sender (the account).
 *  - minOut is END-TO-END (coin on buys, USDG on sells), quoted with quoteUsdgRoute (eth_call), cached like every
 *    other quote (warm loop) ⇒ a warm tap makes no reads.
 *  - Session policy 1.3.0 accepts a USDG approve ONLY to the router and ONLY for exactly the batch's buyWithUsdg
 *    total (standalone USDG approves to curves / tramps are rejected) — the builders below always pair them.
 * Builders/ABI mirror sdk/session-keys (#65) 1:1; switch to `import … from "@disciple/session-keys"` once #65 merges.
 * Availability: detected per router (router.usdg() answers) ⇒ the deployed pre-#65 router falls back to the
 * coin's native quote path automatically; no flag flip needed at redeploy beyond NEXT_PUBLIC_PAY_USDG=1.
 */
import { encodeFunctionData, parseAbi, toFunctionSelector, type Address, type PublicClient } from "viem";
import type { Call } from "../aa/core";
import { LAST_QUOTE, QUOTES, REQUOTE, key as ckey, scaledQuote, isTapClient, firstOk } from "./hotCache";
import { MODEL } from "./quoteModel";

/* ---- mirror of sdk/session-keys (#65) ---- */
export const usdgRouterAbi = parseAbi([
  "function buyWithUsdg(address token, uint256 usdgIn, uint256 minTokensOut, uint256 deadline) returns (uint256 tokensOut)",
  "function sellToUsdg(address token, uint256 tokensIn, uint256 minUsdgOut, uint256 deadline) returns (uint256 usdgOut)",
  "function quoteUsdgRoute(address token, bool isBuy, uint256 amountIn) returns (uint256 amountOut, uint256 maxHopImpactBps)",
  // v4: curve mode rules / PVE login / PVE profit tax evaluated for `trader` (quoteUsdgRoute uses msg.sender = 0x0 in an eth_call)
  "function quoteUsdgRouteFor(address trader, address token, bool isBuy, uint256 amountIn) returns (uint256 amountOut, uint256 maxHopImpactBps)",
  "function usdg() view returns (address)",
]);
const erc20 = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
type SdkCall = { target: Address; value: bigint; data: `0x${string}` };
export function routerBuyWithUsdgCalls(a: { router: Address; usdg: Address; token: Address; usdgIn: bigint; minTokensOut: bigint; deadline: bigint }): SdkCall[] {
  if (a.minTokensOut <= BigInt(0)) throw new Error("minTokensOut must be > 0");
  return [
    { target: a.usdg, value: BigInt(0), data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [a.router, a.usdgIn] }) },
    { target: a.router, value: BigInt(0), data: encodeFunctionData({ abi: usdgRouterAbi, functionName: "buyWithUsdg", args: [a.token, a.usdgIn, a.minTokensOut, a.deadline] }) },
  ];
}
export function routerSellToUsdgCalls(a: { router: Address; token: Address; tokensIn: bigint; minUsdgOut: bigint; deadline: bigint }): SdkCall[] {
  if (a.minUsdgOut <= BigInt(0)) throw new Error("minUsdgOut must be > 0");
  return [
    { target: a.token, value: BigInt(0), data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [a.router, a.tokensIn] }) },
    { target: a.router, value: BigInt(0), data: encodeFunctionData({ abi: usdgRouterAbi, functionName: "sellToUsdg", args: [a.token, a.tokensIn, a.minUsdgOut, a.deadline] }) },
  ];
}
/* ---- end mirror ---- */

export const BUY_WITH_USDG = toFunctionSelector("buyWithUsdg(address,uint256,uint256,uint256)").toLowerCase();
export const SELL_TO_USDG = toFunctionSelector("sellToUsdg(address,uint256,uint256,uint256)").toLowerCase();
export const toCalls = (c: SdkCall[]): Call[] => c.map((x) => ({ to: x.target, data: x.data }));

/**
 * Pay in USDG (buys spend USDG, sells pay out USDG; the router hops through the coin's quote in the same tx)?
 * NEXT_PUBLIC_PAY_USDG=1 forces on, =0 forces off; UNSET ⇒ on for RH testnet (46630), where the v4 router has USDG
 * routing (router.usdg() = mUSDG) and policy 1.3.0 lets the session key sign it. Before this default the flag was
 * unset in Vercel ⇒ every buy silently spent STRATEGY and USDG never moved (bug #2). Still gated per router below:
 * a router without usdg() falls back to the native quote path.
 */
export const payUsdg = (v = process.env.NEXT_PUBLIC_PAY_USDG, chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 46630)) =>
  v === "1" || (v !== "0" && chainId === 46630);

/** router.usdg() per router (cached; a pre-#65 router reverts ⇒ null ⇒ native-quote fallback). */
const transportFailure = (e: unknown) => {
  for (let x = e as { name?: string; cause?: unknown } | undefined, i = 0; x && i < 10; x = x.cause as typeof x, i++)
    if (x.name === "HttpRequestError" || x.name === "TimeoutError") return true;
  return /fetch failed|timed out|took too long|network|ECONN/i.test(String((e as Error)?.message ?? e));
};
const ROUTER_USDG = new Map<string, Promise<Address | null>>();
const ROUTER_USDG_V = new Map<string, Address | null>();
export function routerUsdg(pc: PublicClient, router: Address): Promise<Address | null> {
  const k = router.toLowerCase();
  let p = ROUTER_USDG.get(k);
  if (!p) {
    // a transport failure is NOT "no USDG routing": forget it so the next call re-reads (was cached as null forever)
    p = pc.readContract({ address: router, abi: usdgRouterAbi, functionName: "usdg" }).then((u) => (u && !/^0x0{40}$/i.test(u) ? u : null), (e) => {
      if (!transportFailure(e)) return null;   // the node answered (revert / no data): a pre-#65 router
      ROUTER_USDG.delete(k); throw e;
    });
    p.then((v) => { ROUTER_USDG_V.set(k, v); }, () => undefined);
    ROUTER_USDG.set(k, p);
  }
  // a tap client never just joins a background read that may be stuck on the sequential failover (hung direct RPC)
  else if (isTapClient(pc) && !ROUTER_USDG_V.has(k)) {
    const own = pc.readContract({ address: router, abi: usdgRouterAbi, functionName: "usdg" }).then((u) => (u && !/^0x0{40}$/i.test(u) ? u : null), (e) => { if (!transportFailure(e)) return null; throw e; });
    own.then((v) => { ROUTER_USDG_V.set(k, v); }, () => undefined);
    return firstOk([p, own]).catch(() => null);
  }
  return p.catch(() => null);
}
/** router.usdg() if already resolved (zero-wait taps), else undefined. */
export function routerUsdgNow(router: Address): Address | null | undefined { return ROUTER_USDG_V.get(router.toLowerCase()); }
/** Route this trade through buyWithUsdg / sellToUsdg? (flag on and the router supports it) */
export async function useUsdgRouter(pc: PublicClient, router: Address): Promise<Address | null> {
  return payUsdg() ? routerUsdg(pc, router) : null;
}

/**
 * End-to-end quote (coin out on buy, USDG out on sell) + max per-hop impact; one eth_call, cached ≤ maxAge.
 * exact = true (trade minOut): never a linear down-scale of a bigger warmed quote. The down-scale is a safe lower
 * bound, but the session policy requires minOut ≥ liveQuote × (1 − max) — near graduation (output capped at the
 * remaining tokens) or on a concave sell it falls far below that floor ⇒ MinOutTooLow on the first try.
 */
/**
 * One quoteUsdgRoute(For) eth_call, no cache lookup (zero-wait taps call it with the bounded race client). Every result
 * is recorded: LAST_QUOTE, the 1.5 s QUOTES entry, and the tap quote model (lib/trade/quoteModel) with the time the
 * read STARTED (the state it saw is at least that old).
 */
export async function readUsdgRoute(pc: PublicClient, router: Address, token: Address, isBuy: boolean, amountIn: bigint, trader?: Address | null): Promise<bigint> {
  const side = isBuy ? "buy" : "sell", at = Date.now();
  const { result } = trader
    ? await pc.simulateContract({ address: router, abi: usdgRouterAbi, functionName: "quoteUsdgRouteFor", args: [trader, token, isBuy, amountIn] })
    : await pc.simulateContract({ address: router, abi: usdgRouterAbi, functionName: "quoteUsdgRoute", args: [token, isBuy, amountIn] });
  LAST_QUOTE.set(ckey("usdg", token, side), { amountIn, amountOut: result[0], at: Date.now() });
  MODEL.observe(usdgModelRoute(token), side, amountIn, result[0], at);
  return result[0];
}
/** Quote-model route key for the USDG router path of `token`. */
export const usdgModelRoute = (token: string) => ckey("usdg", token);
export async function usdgRouteQuote(pc: PublicClient, router: Address, token: Address, isBuy: boolean, amountIn: bigint, maxAge = 1500, trader?: Address | null, exact = false): Promise<bigint> {
  const side = isBuy ? "buy" : "sell", k = ckey("usdg", token, side, amountIn), lk = ckey("usdg", token, side);
  const read = async () => ({ amountOut: await readUsdgRoute(pc, router, token, isBuy, amountIn, trader) });
  REQUOTE.remember(k, read, { lk, amountIn });   // re-read right after our own trade (latency plan #5)
  const hit = QUOTES.fresh(k, maxAge); if (hit) return hit.amountOut;
  if (!exact) { const sc = scaledQuote(LAST_QUOTE.get(lk), amountIn, maxAge); if (sc !== undefined) return sc; }
  return (await QUOTES.get(k, read, maxAge)).amountOut;
}
