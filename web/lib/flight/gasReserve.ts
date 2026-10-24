/**
 * GAME-side ADAPTER of FLOW's gas reserve accessors: exact names + semantics of FLOW's draft #145 (feat/rapid-tap @85652af3,
 * on #141), which exports them from lib/wallet.
 * TODO(#145): once #145 is in this stack, replace this file's body with ONE line:
 *   export { gasReservePerOp, peekGasReservePerOp } from "@/lib/wallet";
 * FLOW semantics: SYNC, RAW USDG base units (the deployment's decimals — 18 on today's testnet, 6 after the redeploy; never
 * hard-coded): the cached paymaster maxTokenCost, else a 10 USDG cap when cold; 0n outside smart mode. peek: null = not warmed.
 */
import { deployment } from "@/lib/chains";
import { isSmartMode } from "@/lib/wallet";

/** Cold-cache cap per op, in whole USDG (FLOW #145). */
export const GAS_RESERVE_COLD_USDG = 10;
let peekHook: (() => bigint | null) | null = null;
/** Test hook only (FLOW's real accessor reads its AllowanceCache). */
export function setGasReservePeek(fn: (() => bigint | null) | null) { peekHook = fn; }
const dec = () => deployment().usdgDecimals;
const smart = () => { try { return isSmartMode(); } catch { return false; } };
/** Cached per-op gas cap (raw USDG), null when not warmed yet; 0n outside smart mode. */
export function peekGasReservePerOp(): bigint | null {
  if (!smart()) return BigInt(0);
  try { const v = peekHook?.(); return typeof v === "bigint" && v >= BigInt(0) ? v : null; } catch { return null; }
}
/** Per-op gas reserve (raw USDG): the cached cap, else 10 USDG when cold; 0n outside smart mode. Sync, never throws. */
export function gasReservePerOp(): bigint {
  if (!smart()) return BigInt(0);
  return peekGasReservePerOp() ?? BigInt(GAS_RESERVE_COLD_USDG) * BigInt(10) ** BigInt(dec());
}
