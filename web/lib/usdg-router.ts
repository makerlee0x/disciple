// USDG-in / USDG-out trading through DiscipleRouter (buyWithUsdg / sellToUsdg). Not yet wired into trade();
// the auto-generated lib/abi/DiscipleRouter.ts picks these up on the next web-bundle regen after deploy.
import { encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient } from "viem";

export const usdgRouterAbi = parseAbi([
  "function buyWithUsdg(address token, uint256 usdgIn, uint256 minTokensOut, uint256 deadline) returns (uint256 tokensOut)",
  "function sellToUsdg(address token, uint256 tokensIn, uint256 minUsdgOut, uint256 deadline) returns (uint256 usdgOut)",
  "function quoteUsdgRoute(address token, bool isBuy, uint256 amountIn) returns (uint256 amountOut, uint256 maxHopImpactBps)",
]);

/** End-to-end quote (tokens out on buy, USDG out on sell) + the largest per-hop impact, via eth_call. */
export async function quoteUsdgRoute(pc: PublicClient, router: Address, token: Address, isBuy: boolean, amountIn: bigint) {
  const { result } = await pc.simulateContract({ address: router, abi: usdgRouterAbi, functionName: "quoteUsdgRoute", args: [token, isBuy, amountIn] });
  return { amountOut: result[0], maxHopImpactBps: result[1] };
}

export function encodeBuyWithUsdg(token: Address, usdgIn: bigint, minTokensOut: bigint, deadline: bigint): Hex {
  if (minTokensOut <= 0n) throw new Error("minTokensOut must be > 0");
  return encodeFunctionData({ abi: usdgRouterAbi, functionName: "buyWithUsdg", args: [token, usdgIn, minTokensOut, deadline] });
}

export function encodeSellToUsdg(token: Address, tokensIn: bigint, minUsdgOut: bigint, deadline: bigint): Hex {
  if (minUsdgOut <= 0n) throw new Error("minUsdgOut must be > 0");
  return encodeFunctionData({ abi: usdgRouterAbi, functionName: "sellToUsdg", args: [token, tokensIn, minUsdgOut, deadline] });
}
