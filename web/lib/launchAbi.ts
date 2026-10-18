/**
 * Launch call encoder + bonding-mode rules: ONE switch between the pre-modes Launchpad ABI and FLOW's modes (v4) stack.
 *  - "current" (pre-modes ABI, main today): Launchpad.launchCoin(LaunchParams). No modes exist on-chain.
 *  - "modes" (v4, #98's ABIs): EVERY launch goes through Launchpad.launchWithMode(LaunchParams, uint8 mode), TRENCH
 *    included. Same LaunchParams struct, so First BOOST (creatorBuyQuoteIn / creatorBuyMinTokensOut) is unchanged.
 * The shape follows the generated Launchpad ABI (lib/abi): it is "modes" as soon as that ABI has launchWithMode, so
 * the ABI + address switch in #98 flips it with no extra flag. NEXT_PUBLIC_LAUNCH_ABI=modes|current overrides.
 * /create has no mode selector yet: the mode comes from DEFAULT_LAUNCH_MODE (NEXT_PUBLIC_LAUNCH_MODE, default TRENCH).
 */
import { encodeFunctionData, parseAbi, type Hex, type PublicClient } from "viem";
import { launchpadAbi } from "./abi";
import type { Address } from "./protocol";

export type LaunchAbiShape = "current" | "modes";
/** True when the generated Launchpad ABI (lib/abi/Launchpad.ts) is the modes stack (has launchWithMode). */
export const ABI_HAS_MODES = (launchpadAbi as readonly { type: string; name?: string }[]).some((f) => f.type === "function" && f.name === "launchWithMode");
const envShape = process.env.NEXT_PUBLIC_LAUNCH_ABI;
export const LAUNCH_ABI_SHAPE: LaunchAbiShape = envShape === "modes" ? "modes" : envShape === "current" ? "current" : ABI_HAS_MODES ? "modes" : "current";
export const modesActive = (shape: LaunchAbiShape = LAUNCH_ABI_SHAPE) => shape === "modes";

/**
 * Must match Constants.MODE_* in the live v4 contracts (contracts/src/libraries/Constants.sol, Launchpad.launchWithMode
 * natspec "0 TRENCH WARFARE, 1 PVE, 2 PVP", sdk/session-keys/src/modes.ts on #98): MODE_TRENCH = 0, MODE_PVE = 1,
 * MODE_PVP = 2. Checked 2026-10-17 against #98 (6838465a); FLOW's note said 0=PVE/1=PVP/2=TRENCH, but the deployed
 * contract is authoritative (sending 0 for PVE would launch a TRENCH rocket).
 */
export const LaunchMode = { TRENCH_WARFARE: 0, PVE: 1, PVP: 2 } as const;
export type LaunchModeId = (typeof LaunchMode)[keyof typeof LaunchMode];
export const LAUNCH_MODE_NAME: Record<number, string> = { 0: "TRENCH WARFARE", 1: "PVE", 2: "PVP" };

function envMode(): LaunchModeId {
  const v = (process.env.NEXT_PUBLIC_LAUNCH_MODE || "").trim().toUpperCase();
  if (v === "1" || v === "PVE") return LaunchMode.PVE;
  if (v === "2" || v === "PVP") return LaunchMode.PVP;
  return LaunchMode.TRENCH_WARFARE;
}
/** Mode /create launches with until it has a selector (modes ABI only; the current ABI is always TRENCH). */
export const DEFAULT_LAUNCH_MODE: LaunchModeId = modesActive() ? envMode() : LaunchMode.TRENCH_WARFARE;

/**
 * Per-buy token cap (bps of supply) a mode puts on the creator's launch buy, on top of Launchpad.creatorBuyMaxBps().
 * Caps stack; the strictest wins (FLOW: PVE 0.25%, PVP and TRENCH 0.77% with today's creatorBuyMaxBps = 77).
 * Mirrors BondingCurve.maxBuyNow()/netCapNow() at launch (sold = 0, inside the window):
 *  - PVE: PVE_WINDOW_BUY_CAP_BPS 25 (0.25%/buy for the first 7 min; NET cap 1% is looser) → 0.25%. The creator must
 *    also be login-verified (LoginGate), or the launch buy reverts NotVerified.
 *  - PVP: PVP_MAX_BUY_BPS 333 (3.33%/buy; NET cap 4% at launch) → looser, so creatorBuyMaxBps (0.77%) wins
 *  - TRENCH: none (walletCapBps 7% is looser) → creatorBuyMaxBps (0.77%)
 * quoteCreatorBuy().exceedsCap only knows creatorBuyMaxBps, so MAX and validation clamp to this client-side.
 */
export const MODE_BUY_CAP_BPS: Record<number, number | null> = { 0: null, 1: 25, 2: 333 };

/** Effective launch-buy cap in bps: min(creatorBuyMaxBps, mode cap) when modes are live, else creatorBuyMaxBps. */
export function effectiveCreatorBuyCapBps(creatorBuyMaxBps: number, mode: number, shape: LaunchAbiShape = LAUNCH_ABI_SHAPE) {
  const m = modesActive(shape) ? MODE_BUY_CAP_BPS[mode] ?? null : null;
  return m == null ? { bps: creatorBuyMaxBps, by: "launchpad" as const } : m < creatorBuyMaxBps ? { bps: m, by: "mode" as const } : { bps: creatorBuyMaxBps, by: "launchpad" as const };
}

/** launchWithMode + loginGate from sdk/session-keys/src/modes.ts (feat/modes-gas). */
export const launchpadModesAbi = parseAbi([
  "struct LaunchParams { string name; string ticker; string imageURI; string description; string socialsURI; address quote; uint256 creatorTaxBps; uint256 creatorBuyQuoteIn; uint256 creatorBuyMinTokensOut; uint256 deadline; }",
  "struct LaunchResult { address token; address curve; uint256 creatorTokensBought; }",
  "function launchWithMode(LaunchParams params, uint8 mode) returns (LaunchResult)",
  "function loginGate() view returns (address)",
  "event LaunchMode(address indexed token, address indexed curve, uint8 mode)",
]);
/** Errors the modes redeploy can raise on a launch / launch buy (Launchpad + BondingCurve). */
export const modesErrorsAbi = parseAbi([
  "error BadMode()", "error LoginGateUnset()", "error NotVerified()", "error BuyTooLarge()", "error LaunchBlock()",
]);
const loginGateAbi = parseAbi(["function verifiedUntil(address wallet, address coin) view returns (uint64)"]);

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
/**
 * PVE: the creator's launch buy reverts NotVerified unless the creator holds a live LoginGate attestation. The coin
 * doesn't exist before the launch, so only a GLOBAL attestation (coin = address(0)) can count. Reads
 * Launchpad.loginGate() → LoginGate.verifiedUntil(wallet, 0). Needs 60 s of headroom so it can't expire mid-tx.
 */
export async function readPveLoginVerified(pc: PublicClient, launchpad: Address, wallet: Address): Promise<{ verified: boolean; until: number; gate: Address }> {
  const gate = await pc.readContract({ address: launchpad, abi: launchpadModesAbi, functionName: "loginGate" });
  if (gate === ZERO) return { verified: false, until: 0, gate };
  const until = Number(await pc.readContract({ address: gate, abi: loginGateAbi, functionName: "verifiedUntil", args: [wallet, ZERO] }));
  return { verified: until > Math.floor(Date.now() / 1000) + 60, until, gate };
}

export interface LaunchParamsArg {
  name: string; ticker: string; imageURI: string; description: string; socialsURI: string;
  quote: Address; creatorTaxBps: bigint;
  /** First BOOST: quote raw the creator spends in the launch tx (0 = skip). */
  creatorBuyQuoteIn: bigint;
  creatorBuyMinTokensOut: bigint;
  deadline: bigint;
}

export function encodeLaunchCall(params: LaunchParamsArg, mode: number = LaunchMode.TRENCH_WARFARE, shape: LaunchAbiShape = LAUNCH_ABI_SHAPE): Hex {
  // #99: validate against the on-chain enum (0 TRENCH, 1 PVE, 2 PVP) and encode with the generated v4 Launchpad ABI.
  if (!Number.isInteger(mode) || !(mode in LAUNCH_MODE_NAME)) throw new Error(`Bad launch mode ${mode} (0 TRENCH, 1 PVE, 2 PVP).`);
  if (shape === "modes") {
    return ABI_HAS_MODES
      ? encodeFunctionData({ abi: launchpadAbi, functionName: "launchWithMode", args: [params, mode] } as never)
      : encodeFunctionData({ abi: launchpadModesAbi, functionName: "launchWithMode", args: [params, mode] });
  }
  // Current ABI: launchCoin only. Refuse a non-TRENCH mode rather than silently launching TRENCH.
  if (mode !== LaunchMode.TRENCH_WARFARE) throw new Error("This Launchpad has no modes yet (launchCoin = TRENCH WARFARE only).");
  return encodeFunctionData({ abi: launchpadAbi, functionName: "launchCoin", args: [params] });
}
