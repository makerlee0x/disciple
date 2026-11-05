/**
 * GAME-side ADAPTER of FLOW's gas reserve (#145 @e693cb5c: lib/aa/gasReserve + lib/wallet gasReservePerOp(kind) /
 * peekGasReservePerOp(kind)). Same API and the SAME math, copied from FLOW so the later swap is one line:
 *   TODO(#145): replace this file's two accessors with
 *     export { gasReservePerOp, peekGasReservePerOp, type GasOpKind } from "@/lib/wallet";
 *   (drop warmGasPrice / the test hooks once FLOW's session start warms its PaymasterCapCache).
 * SYNC, RAW USDG base units (lib/usdg decimals: 18 on today's testnet, 6 after the redeploy); 0n outside smart mode.
 *
 * WARM (a fresh signed allowance is cached):
 *   trade:   the allowance's maxTokenCost itself (exactly what the op approves).
 *   gradBuy: tokenCost(GRAD_GAS_LIMIT × max(allowance maxFee, cached op maxFee), allowance rate) + debt, capped at maxCostCap.
 *   Never min(cached, derived): on a gas spike that under-reserves and the paymaster fails the op with AA33.
 * COLD: tokenCost(gasLimit(kind) × allowanceMaxFee(gas price), rate), capped at the paymaster's maxCostCap when known —
 *   gasLimit: trade 2.41M (STATIC_GAS 1.8M + 350k + 60k + paymaster 120k + 80k), gradBuy 6M (GRAD_GAS_CAPS.total);
 *   allowanceMaxFee(gp) = clientFees(gp).maxFeePerGas × 2 = (2·gp + tip·1.1) × 1.5 × 2 (the server's allowance math);
 *   gas price: live eth_gasPrice (warmGasPrice, 30 s TTL), config 0.0207 gwei until then;
 *   rate: the last allowance's signed rate, else config GAS.ethUsd at the USDG decimals.
 *   ≈ 0.36 USDG / trade and 0.90 / grad buy at today's 0.01 gwei; 0.73 / 1.81 on the config constants (no RPC yet).
 *   (The old GAME-only ~$0.21 used the wrong limits + fee and was below what the paymaster charges: dropped.)
 */
import { GAS } from "@/lib/config";
import { clientFees } from "@/lib/aa/gasPolicy";
import { usdgDecimals } from "@/lib/usdg";
import { isSmartMode } from "@/lib/wallet";

/* ---- FLOW lib/aa/gasReserve.ts (e693cb5c), verbatim math. ALLOWANCE_GAS / tokenCost / GRAD_GAS_CAPS.total are inlined
 *      because lib/aa/paymaster + the grad caps aren't in this stack yet (same values as FLOW's). ---- */
export type GasOpKind = "trade" | "gradBuy";
/** FLOW lib/aa/paymaster ALLOWANCE_GAS (STATIC_GAS + PAYMASTER_GAS 120k / 80k). */
const ALLOWANCE_GAS = {
  callGasLimit: BigInt(1_800_000), verificationGasLimit: BigInt(350_000), preVerificationGas: BigInt(60_000),
  paymasterVerificationGasLimit: BigInt(120_000), paymasterPostOpGasLimit: BigInt(80_000),
} as const;
/** FLOW lib/aa/paymaster tokenCost: DisciplePaymaster's wei → USDG raw, rounded up. */
export function tokenCost(weiAmount: bigint, rate: bigint): bigint {
  const E = BigInt(10) ** BigInt(18);
  return (weiAmount * rate + E - BigInt(1)) / E;
}
/** Mirrors lib/server/paymasterCore ALLOWANCE_FEE_MULT (server module; not imported into client code). */
export const ALLOWANCE_FEE_MULT = BigInt(2);
export const TRADE_GAS_LIMIT = Object.values(ALLOWANCE_GAS).reduce((a, b) => a + b, BigInt(0));   // 2.41M
export const GRAD_GAS_LIMIT = BigInt(6_000_000);                                                    // GRAD_GAS_CAPS.total
export const gasLimitFor = (k: GasOpKind) => (k === "gradBuy" ? GRAD_GAS_LIMIT : TRADE_GAS_LIMIT);
/** Config fallbacks (lib/config GAS) used only until the first live read. */
export const CONFIG_GAS_PRICE_WEI = BigInt(Math.ceil(GAS.robinhoodGwei * 1e9));
/** Config ETH→USDG rate (USDG base units per 1 ETH) at `decimals`. */
export const configRate = (decimals: number) => BigInt(Math.round(GAS.ethUsd * 1e6)) * BigInt(10) ** BigInt(decimals) / BigInt(1e6);
/** maxFeePerGas the paymaster allowance is signed with at gas price `gp` (same formula as paymasterCore.allowanceQuote). */
export const allowanceMaxFee = (gp: bigint) => clientFees(gp).maxFeePerGas * ALLOWANCE_FEE_MULT;
/** COLD per-op reserve (raw USDG), rounded up like DisciplePaymaster.tokenCost. */
export function derivedGasReserve(o: { kind?: GasOpKind; gasPriceWei?: bigint; rate?: bigint; decimals: number; cap?: bigint }): bigint {
  const r = tokenCost(gasLimitFor(o.kind ?? "trade") * allowanceMaxFee(o.gasPriceWei ?? CONFIG_GAS_PRICE_WEI), o.rate ?? configRate(o.decimals));
  return o.cap !== undefined && r > o.cap ? o.cap : r;
}
export type WarmAllowance = { maxTokenCost: bigint; rate: bigint; debt: bigint; maxFeePerGas: bigint };
export function peekReserve(o: { usdgGas: boolean; kind?: GasOpKind; allowance?: WarmAllowance; opMaxFee?: bigint; cap?: bigint }): bigint | null {
  if (!o.usdgGas) return BigInt(0);
  const a = o.allowance; if (!a) return null;
  if ((o.kind ?? "trade") === "trade") return a.maxTokenCost;
  const fee = o.opMaxFee !== undefined && o.opMaxFee > a.maxFeePerGas ? o.opMaxFee : a.maxFeePerGas;
  const r = tokenCost(GRAD_GAS_LIMIT * fee, a.rate) + a.debt;
  return o.cap !== undefined && r > o.cap ? o.cap : r;
}
export function reserveOrDerived(peek: bigint | null, d: Parameters<typeof derivedGasReserve>[0]): bigint {
  return peek ?? derivedGasReserve(d);
}
export const GAS_PRICE_TTL_MS = 30_000;

/* ---- glue = FLOW mav2 peekGasReservePerOp / gasReservePerOp + lib/wallet (smart mode ⇔ USDG gas here) ---- */
let allowanceHook: (() => WarmAllowance | undefined) | null = null;
let capRaw: bigint | undefined, opMaxFeeWei: bigint | undefined, lastRate: bigint | undefined;
let gp: { wei: bigint; at: number } | undefined;
/** FLOW's AllowanceCache.peek (fresh allowance only) — test hook until #145 is in the stack. */
export function setWarmAllowance(fn: (() => WarmAllowance | undefined) | null) { allowanceHook = fn; }
/** paymaster.maxCostCap() (raw USDG) / FEES.peek().maxFeePerGas — test hooks until #145 (FLOW warms them at session start). */
export function setPaymasterCap(cap: bigint | undefined) { capRaw = cap; }
export function setOpMaxFee(wei: bigint | undefined) { opMaxFeeWei = wei; }
/** Live gas price (wei), set off the trade path. null resets to cold (config gwei). */
export function setGasPrice(wei: bigint | null) { gp = typeof wei === "bigint" && wei > BigInt(0) ? { wei, at: Date.now() } : undefined; }
/** eth_gasPrice in the background (cash poll); re-read when older than 30 s; never on the trade path, never throws. */
export function warmGasPrice(pc: { getGasPrice: () => Promise<bigint> }): Promise<void> {
  if (gp && Date.now() - gp.at < GAS_PRICE_TTL_MS) return Promise.resolve();
  return pc.getGasPrice().then((w) => setGasPrice(BigInt(w)), () => undefined);
}
const smart = () => { try { return isSmartMode(); } catch { return false; } };
/** Warm value (fresh allowance), else null (cold); 0n when gas isn't paid in USDG. */
export function peekGasReservePerOp(kind: GasOpKind = "trade"): bigint | null {
  try {
    const a = smart() ? allowanceHook?.() : undefined;
    if (a) lastRate = a.rate;
    return peekReserve({ usdgGas: smart(), kind, allowance: a, opMaxFee: opMaxFeeWei, cap: capRaw });
  } catch { return null; }
}
/** Never null: warm value, else derived. Sync, never throws. */
export function gasReservePerOp(kind: GasOpKind = "trade"): bigint {
  if (!smart()) return BigInt(0);
  try { return reserveOrDerived(peekGasReservePerOp(kind), { kind, gasPriceWei: gp?.wei, rate: lastRate, cap: capRaw, decimals: usdgDecimals() }); }
  catch { return BigInt(0); }
}
