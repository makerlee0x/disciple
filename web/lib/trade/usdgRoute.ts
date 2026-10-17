/**
 * Pay-in-USDG routing (NEXT_PUBLIC_PAY_USDG=1). Players always spend / receive mUSDG (USDG on mainnet) whatever the
 * coin's quote. For a coin quoted in X ≠ USDG we batch BOTH hops into the SAME userOp (no extra round trip):
 *   buy : mUSDG ─(v4 ref pool USDG/X via UniversalRouter)→ X ─(DiscipleRouter.buyExactIn | curve.buy)→ coin
 *   sell: coin ─(sellExactIn | curve.sell)→ X ─(v4 ref pool via UniversalRouter)→ mUSDG
 * Exact-in on both hops; the slippage budget is split in half per hop, and hop 2's amountIn = hop 1's minOut, so hop 2
 * never pulls more than hop 1 guarantees (surplus ≤ half the budget stays in the account as X dust).
 * Approvals: exact amounts, ERC20 → Permit2 and Permit2 → UniversalRouter (expiry now+10 min) — nothing standing.
 */
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, type Address, type Hex, type PublicClient } from "viem";
import type { Call } from "../aa/core";
import { LAST_QUOTE, QUOTES, key as ckey, scaledQuote } from "./hotCache";

export const RH_TESTNET_USDG = "0x25030Bff74764aD72b912276a603717DB1C00644" as Address;
export const UNIVERSAL_ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904" as Address;
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
export const V4_QUOTER = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94" as Address;

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
/** USDG/<quote> reference pools (deployments/rh-testnet-46630.json → strategyUsdgRefPool). Add more quotes here. */
const REF_POOLS: Record<string, PoolKey> = {
  "0xd4d0eb01960aace441bfcb323bfaf7c3d8b555a3": { currency0: RH_TESTNET_USDG, currency1: "0xd4d0eB01960AACE441bFcb323Bfaf7c3d8b555a3", fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000" },
};
export const payUsdg = () => process.env.NEXT_PUBLIC_PAY_USDG === "1";
export const usdgAddress = () => (process.env.NEXT_PUBLIC_USDG as Address | undefined) || RH_TESTNET_USDG;
export const refPool = (quote: Address) => REF_POOLS[quote.toLowerCase()];
/** Route through USDG? (flag on, quote isn't USDG, and a ref pool exists) */
export const needsHop = (quote: Address) => payUsdg() && quote.toLowerCase() !== usdgAddress().toLowerCase() && !!refPool(quote);

const lc = (a: string) => a.toLowerCase();
const quoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const urAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const permit2Abi = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);
const erc20Abi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

const V4_SWAP = "0x10";
const A = { SWAP_EXACT_IN_SINGLE: 0x06, SWAP_EXACT_OUT_SINGLE: 0x08, SETTLE: 0x0b, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f } as const;
const CONTRACT_BALANCE = BigInt(1) << BigInt(255), OPEN_DELTA = BigInt(0);
const acts = (...a: number[]) => `0x${a.map((x) => x.toString(16).padStart(2, "0")).join("")}` as Hex;
/** deployed UniversalRouter = current v4-periphery: Exact{In,Out}putSingleParams carry a uint256 min/maxHopPriceX36
 * (0 = off) before hookData — the original 5-field struct reverts with empty data (verified by eth_call on RH testnet). */
const singleParams = parseAbiParameters("((address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)");
const keyT = (p: PoolKey) => [p.currency0, p.currency1, p.fee, p.tickSpacing, p.hooks] as const;
const urCall = (actions: Hex, params: Hex[], deadline: bigint): Call => ({ to: UNIVERSAL_ROUTER,
  data: encodeFunctionData({ abi: urAbi, functionName: "execute", args: [V4_SWAP, [encodeAbiParameters(parseAbiParameters("bytes,bytes[]"), [actions, params])], deadline] }) });
const permit = (tok: Address, amt: bigint): Call[] => [
  { to: tok, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PERMIT2, amt] }) },
  { to: PERMIT2, data: encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [tok, UNIVERSAL_ROUTER, amt, Math.floor(Date.now() / 1000) + 600] }) },
];

/**
 * BUY hop (dust-free): EXACT-OUT — receive exactly `quoteOut` of the pair token for at most `usdgMax` mUSDG
 * (unspent mUSDG simply stays mUSDG). The coin buy then spends exactly `quoteOut`.
 */
export function buyHopCalls(usdg: Address, quote: Address, usdgMax: bigint, quoteOut: bigint, deadline: bigint): Call[] {
  const pool = refPool(quote)!, zeroForOne = lc(usdg) === lc(pool.currency0);
  return [...permit(usdg, usdgMax), urCall(acts(A.SWAP_EXACT_OUT_SINGLE, A.SETTLE_ALL, A.TAKE_ALL), [
    encodeAbiParameters(singleParams, [[keyT(pool), zeroForOne, quoteOut, usdgMax, BigInt(0), "0x"]]),
    encodeAbiParameters(parseAbiParameters("address,uint256"), [usdg, usdgMax]),
    encodeAbiParameters(parseAbiParameters("address,uint256"), [quote, quoteOut]),
  ], deadline)];
}
/**
 * SELL hop (dust-free): the coin sell pays its proceeds to the UniversalRouter itself (recipient = UR, same tx), then
 * SETTLE(quote, CONTRACT_BALANCE, payerIsUser=false) + SWAP_EXACT_IN_SINGLE(amountIn = OPEN_DELTA) swaps ALL of it and
 * TAKE_ALL(usdg, minOut) pays the account. No approvals / Permit2 needed for this hop.
 */
export function sellHopCall(quote: Address, usdg: Address, minUsdg: bigint, deadline: bigint): Call {
  const pool = refPool(quote)!, zeroForOne = lc(quote) === lc(pool.currency0);
  return urCall(acts(A.SETTLE, A.SWAP_EXACT_IN_SINGLE, A.TAKE_ALL), [
    encodeAbiParameters(parseAbiParameters("address,uint256,bool"), [quote, CONTRACT_BALANCE, false]),
    encodeAbiParameters(singleParams, [[keyT(pool), zeroForOne, OPEN_DELTA, minUsdg, BigInt(0), "0x"]]),
    encodeAbiParameters(parseAbiParameters("address,uint256"), [usdg, minUsdg]),
  ], deadline);
}

/** One eth_call to the V4Quoter; cached 1.5 s (+ safe linear down-scale of the last quote, see hotCache). */
export async function swapQuote(pc: PublicClient, from: Address, to: Address, amountIn: bigint, maxAge = 1500): Promise<bigint> {
  const pool = refPool(lc(from) === lc(usdgAddress()) ? to : from)!;
  const k = ckey("swap", from, to, amountIn), lk = ckey("swap", from, to);
  const hit = QUOTES.fresh(k, maxAge); if (hit) return hit.amountOut;
  const sc = scaledQuote(LAST_QUOTE.get(lk), amountIn, maxAge); if (sc !== undefined) return sc;
  return (await QUOTES.get(k, async () => {
    const { result } = await pc.simulateContract({ address: V4_QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle",
      args: [{ poolKey: pool, zeroForOne: lc(from) === lc(pool.currency0), exactAmount: amountIn, hookData: "0x" }] });
    LAST_QUOTE.set(lk, { amountIn, amountOut: result[0], at: Date.now() });
    return { amountOut: result[0] };
  }, maxAge)).amountOut;
}

/** Half the total budget per hop (≈ total when compounded: (1-s/2)² ≥ 1-s). */
export const hopBps = (totalBps: number) => Math.floor(totalBps / 2);
