/**
 * Launch call encoder — same API as PR #96's lib/launchAbi.ts (First BOOST), so the two branches compose:
 *  - "modes" (v4, DEFAULT now that lib/abi/Launchpad.ts is the v4 ABI): Launchpad.launchWithMode(LaunchParams, uint8 mode).
 *  - "current" (pre-v4 Launchpads): launchCoin(LaunchParams) — TRENCH WARFARE only.
 * Same LaunchParams struct either way (First BOOST = creatorBuyQuoteIn / creatorBuyMinTokensOut).
 * Override with NEXT_PUBLIC_LAUNCH_ABI=current only when pointing the site at an older stack.
 */
import { encodeFunctionData, type Hex } from "viem";
import { launchpadAbi } from "./abi";
import type { Address } from "./protocol";

export type LaunchAbiShape = "current" | "modes";
const HAS_MODES = launchpadAbi.some((x) => x.type === "function" && x.name === "launchWithMode");
export const LAUNCH_ABI_SHAPE: LaunchAbiShape = process.env.NEXT_PUBLIC_LAUNCH_ABI === "current" || !HAS_MODES ? "current" : "modes";

/** Must match contracts Constants.MODE_* (Launchpad.sol: 0 TRENCH WARFARE, 1 PVE, 2 PVP) — NOT 0=PVE. */
export const LaunchMode = { TRENCH_WARFARE: 0, PVE: 1, PVP: 2 } as const;
export type LaunchModeId = (typeof LaunchMode)[keyof typeof LaunchMode];

export interface LaunchParamsArg {
  name: string; ticker: string; imageURI: string; description: string; socialsURI: string;
  quote: Address; creatorTaxBps: bigint;
  /** First BOOST: quote raw the creator spends in the launch tx (0 = skip). */
  creatorBuyQuoteIn: bigint;
  creatorBuyMinTokensOut: bigint;
  deadline: bigint;
}

export function encodeLaunchCall(params: LaunchParamsArg, mode: number = LaunchMode.TRENCH_WARFARE, shape: LaunchAbiShape = LAUNCH_ABI_SHAPE): Hex {
  if (!Number.isInteger(mode) || mode < 0 || mode > 2) throw new Error(`Bad launch mode ${mode} (0 TRENCH, 1 PVE, 2 PVP).`);
  if (shape === "modes") return encodeFunctionData({ abi: launchpadAbi, functionName: "launchWithMode", args: [params, mode] });
  if (mode !== LaunchMode.TRENCH_WARFARE) throw new Error("This Launchpad has no modes (launchCoin = TRENCH WARFARE only).");
  return encodeFunctionData({ abi: launchpadAbi, functionName: "launchCoin", args: [params] });
}
