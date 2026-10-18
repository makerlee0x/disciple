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
import { LAST_QUOTE, QUOTES, key as ckey, scaledQuote } from "./hotCache";

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
const ROUTER_USDG = new Map<string, Promise<Address | null>>();
export function routerUsdg(pc: PublicClient, router: Address): Promise<Address | null> {
  const k = router.toLowerCase();
  let p = ROUTER_USDG.get(k);
  if (!p) {
    p = pc.readContract({ address: router, abi: usdgRouterAbi, functionName: "usdg" }).then((u) => (u && !/^0x0{40}$/i.test(u) ? u : null)).catch(() => null);
    ROUTER_USDG.set(k, p);
  }
  return p;
}
/** Route this trade through buyWithUsdg / sellToUsdg? (flag on and the router supports it) */
export async function useUsdgRouter(pc: PublicClient, router: Address): Promise<Address | null> {
  return payUsdg() ? routerUsdg(pc, router) : null;
}

/** End-to-end quote (coin out on buy, USDG out on sell) + max per-hop impact; one eth_call, cached ≤ maxAge. */
export async function usdgRouteQuote(pc: PublicClient, router: Address, token: Address, isBuy: boolean, amountIn: bigint, maxAge = 1500, trader?: Address | null): Promise<bigint> {
  const side = isBuy ? "buy" : "sell", k = ckey("usdg", token, side, amountIn), lk = ckey("usdg", token, side);
  const hit = QUOTES.fresh(k, maxAge); if (hit) return hit.amountOut;
  const sc = scaledQuote(LAST_QUOTE.get(lk), amountIn, maxAge); if (sc !== undefined) return sc;
  return (await QUOTES.get(k, async () => {
    const { result } = trader
      ? await pc.simulateContract({ address: router, abi: usdgRouterAbi, functionName: "quoteUsdgRouteFor", args: [trader, token, isBuy, amountIn] })
      : await pc.simulateContract({ address: router, abi: usdgRouterAbi, functionName: "quoteUsdgRoute", args: [token, isBuy, amountIn] });
    LAST_QUOTE.set(lk, { amountIn, amountOut: result[0], at: Date.now() });
    return { amountOut: result[0] };
  }, maxAge)).amountOut;
}
