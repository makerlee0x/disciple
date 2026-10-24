/**
 * GAME-side ADAPTER of FLOW's gas reserve accessors (#145, which exports them from lib/wallet), same names + semantics:
 * SYNC, RAW USDG base units at the active USDG decimals (lib/usdg usdgDecimals(): 18 on today's testnet, 6 after the
 * redeploy; never hard-coded); 0n outside smart mode (gas isn't paid in USDG). peek: null = nothing warm yet.
 * TODO(#145): once #145 is in this stack (and its cold fallback is derived, as FLOW is doing), replace the two accessors
 * with ONE line:   export { gasReservePerOp, peekGasReservePerOp } from "@/lib/wallet";
 * and keep warmGasPrice() only if FLOW doesn't warm at session start.
 *
 * COLD VALUE (lee: never a flat 10 USDG): derived, never a constant cap —
 *   op gas limit (warm one-tap trade: STATIC_GAS call 1.8M + verification 350k + PVG 60k, + paymaster verification 300k
 *   + postOp 300k = 2.81M, lib/aa/fastPath + lib/aa/gasPolicy) × gas price (live eth_gasPrice, cached; config gwei until
 *   the first read) × CLIENT_FEE_HEADROOM 1.5 × ETH/USD (config GAS.ethUsd) → USDG raw, rounded up.
 *   ≈ $0.21 at today's testnet gas (0.0207 gwei, $2372 ETH). This is the most the op can be charged at that price
 *   (all limits × maxFee), so a $1 BOOST is never blocked when cash covers it plus the op's real gas.
 * Warm: min(FLOW's cached maxTokenCost, the derived value) — the per-sender allowance can be the paymaster's 10 USDG
 * maxCostCap, which is a ceiling, not what one op costs.
 */
import { GAS } from "@/lib/config";
import { usdgDecimals } from "@/lib/usdg";
import { isSmartMode } from "@/lib/wallet";

/** Gas limit of one warm one-tap trade op (lib/aa/fastPath STATIC_GAS + lib/aa/gasPolicy paymaster limits). */
export const OP_GAS_LIMIT = BigInt(1_800_000 + 350_000 + 60_000 + 300_000 + 300_000);
/** lib/aa/gasPolicy CLIENT_FEE_HEADROOM_PCT: the client's own fee headroom over the relayer floor. */
export const GAS_HEADROOM_PCT = BigInt(150);
const B0 = BigInt(0), GWEI = BigInt(1e9);
/** Config gas price in wei (until the first live read). */
const configGasPriceWei = () => BigInt(Math.ceil(GAS.robinhoodGwei * 1e9));
let liveGasPriceWei: bigint | null = null;
let peekHook: (() => bigint | null) | null = null;
/** Test hook only (FLOW's real accessor reads its AllowanceCache maxTokenCost). */
export function setGasReservePeek(fn: (() => bigint | null) | null) { peekHook = fn; }
/** The live gas price (wei), set off the trade path (warmGasPrice / tests). */
export function setGasPrice(wei: bigint | null) { liveGasPriceWei = typeof wei === "bigint" && wei > B0 ? wei : null; }
/** Read eth_gasPrice in the background (balance poll / session start); never on the trade path, never throws. */
export function warmGasPrice(pc: { getGasPrice: () => Promise<bigint> }): Promise<void> {
  return pc.getGasPrice().then((w) => setGasPrice(w), () => undefined);
}
const smart = () => { try { return isSmartMode(); } catch { return false; } };
/** Derived per-op reserve in raw USDG: OP_GAS_LIMIT × gas price × 1.5 × ETH/USD, rounded UP (bigint; $ only via config ETH/USD). */
export function derivedGasReserve(dec: number = usdgDecimals(), gasPriceWei: bigint = liveGasPriceWei ?? configGasPriceWei(), ethUsd: number = GAS.ethUsd): bigint {
  const wei = OP_GAS_LIMIT * gasPriceWei * GAS_HEADROOM_PCT / BigInt(100);
  const ethUsdMicro = BigInt(Math.round(ethUsd * 1e6));
  const num = wei * ethUsdMicro * BigInt(10) ** BigInt(dec), den = GWEI * GWEI * BigInt(1e6);   // wei/1e18 · $ · 10^dec
  return (num + den - BigInt(1)) / den;
}
/** FLOW's cached maxTokenCost (capped by the derived value), null when nothing is warm; 0n outside smart mode. */
export function peekGasReservePerOp(): bigint | null {
  if (!smart()) return B0;
  try { const v = peekHook?.(); return typeof v === "bigint" && v >= B0 ? (v < derivedGasReserve() ? v : derivedGasReserve()) : null; } catch { return null; }
}
/** Per-op gas reserve (raw USDG): peek, else the derived cold value; 0n outside smart mode. Sync, never throws. */
export function gasReservePerOp(): bigint {
  if (!smart()) return B0;
  try { return peekGasReservePerOp() ?? derivedGasReserve(); } catch { return B0; }
}
