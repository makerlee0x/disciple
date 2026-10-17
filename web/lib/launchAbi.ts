/**
 * Launch call encoder: ONE switch between the live Launchpad ABI and FLOW's modes redeploy (feat/modes-gas).
 *  - "current" (default, what is deployed today): Launchpad.launchCoin(LaunchParams).
 *  - "modes" (redeploy): Launchpad.launchWithMode(LaunchParams, uint8 mode). Same LaunchParams struct, so the
 *    First BOOST fields (creatorBuyQuoteIn / creatorBuyMinTokensOut) are unchanged. launchCoin on the redeploy is
 *    TRENCH WARFARE (mode 0), so leaving this on "current" keeps working after the redeploy too.
 * Flip with NEXT_PUBLIC_LAUNCH_ABI=modes once the redeploy's Launchpad address is in lib/chains.ts.
 */
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { launchpadAbi } from "./abi";
import type { Address } from "./protocol";

export type LaunchAbiShape = "current" | "modes";
export const LAUNCH_ABI_SHAPE: LaunchAbiShape = process.env.NEXT_PUBLIC_LAUNCH_ABI === "modes" ? "modes" : "current";

/** Must match Constants.MODE_* (sdk/session-keys/src/modes.ts on feat/modes-gas). */
export const LaunchMode = { TRENCH_WARFARE: 0, PVE: 1, PVP: 2 } as const;

/** launchWithMode from sdk/session-keys/src/modes.ts (feat/modes-gas). */
export const launchpadModesAbi = parseAbi([
  "struct LaunchParams { string name; string ticker; string imageURI; string description; string socialsURI; address quote; uint256 creatorTaxBps; uint256 creatorBuyQuoteIn; uint256 creatorBuyMinTokensOut; uint256 deadline; }",
  "struct LaunchResult { address token; address curve; uint256 creatorTokensBought; }",
  "function launchWithMode(LaunchParams params, uint8 mode) returns (LaunchResult)",
]);

export interface LaunchParamsArg {
  name: string; ticker: string; imageURI: string; description: string; socialsURI: string;
  quote: Address; creatorTaxBps: bigint;
  /** First BOOST: quote raw the creator spends in the launch tx (0 = skip). */
  creatorBuyQuoteIn: bigint;
  creatorBuyMinTokensOut: bigint;
  deadline: bigint;
}

export function encodeLaunchCall(params: LaunchParamsArg, mode: number = LaunchMode.TRENCH_WARFARE, shape: LaunchAbiShape = LAUNCH_ABI_SHAPE): Hex {
  if (shape === "modes") return encodeFunctionData({ abi: launchpadModesAbi, functionName: "launchWithMode", args: [params, mode] });
  if (mode !== LaunchMode.TRENCH_WARFARE) throw new Error("This Launchpad has no modes yet (launchCoin = TRENCH WARFARE only).");
  return encodeFunctionData({ abi: launchpadAbi, functionName: "launchCoin", args: [params] });
}
