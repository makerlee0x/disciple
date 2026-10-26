/**
 * Rapid taps (GAME cash reservation): the USDG a pending op may still take for gas, SYNC and in USDG base units.
 *   reserve = liveCash − Σ pending (amountIn + gasReservePerOp(kind))
 * The paymaster flow makes each op approve EXACTLY its signed maxTokenCost first (lib/aa/paymasterClient) and the
 * paymaster requires the sender to hold it, so maxTokenCost is what one op must have available for gas.
 *
 * WARM (allowance fresh — AllowanceCache.peek only returns an allowance still inside its window):
 *   trade (buy / sell): the allowance's maxTokenCost itself — exactly what the op approves (the op fits the envelope).
 *   gradBuy: per-op quote, above the envelope ⇒ tokenCost(GRAD_GAS_CAPS.total × max(allowance maxFee, cached op
 *            maxFee), allowance rate) + the allowance's debt — the relay never accepts more gas than GRAD_GAS_CAPS.
 *   Never min(cached, derived) (GAME #147's shim did): if gas spikes above the derived estimate, the min would reserve
 *   LESS than the op really approves. The warm value is the real signed amount, so it is used as is.
 * COLD (no allowance yet): derived, never a flat cap (lee: "$10 for gas is way too much") —
 *   tokenCost(gasLimit(kind) × maxFee(gasPrice), rate), where
 *     gasLimit: trade = ALLOWANCE_GAS sum (STATIC_GAS 1.8M + 350k + 60k + paymaster 120k + 80k = 2.41M);
 *               gradBuy = GRAD_GAS_CAPS.total (6M)
 *     maxFee(gp) = clientFees(gp).maxFeePerGas × ALLOWANCE_FEE_MULT (2) — the SAME formula the server signs the
 *               allowance with, so cold == warm at the same gas price. clientFees carries the 1.5× headroom
 *               (CLIENT_FEE_HEADROOM_PCT): (2·gp + tip·1.1) × 1.5, then ×2 for base-fee moves during the allowance.
 *     gasPrice: live eth_gasPrice cached at session start / warm(); config GAS.robinhoodGwei (0.0207) until then
 *     rate:     the last allowance's signed rate (the paymaster's rate), else config GAS.ethUsd at the USDG decimals
 *   Clamped to the paymaster's maxCostCap when known (the contract refuses more). No RPC data at all ⇒ the same
 *   formula on the config constants: that IS the small documented floor (0.73 USDG trade, 1.81 grad at 0.0207 gwei).
 *   Live today (eth_gasPrice 0.01 gwei, $2372): 0.36 USDG trade, 0.90 USDG grad buy.
 * Pure: no RPC on the read path.
 */
import type { Address, PublicClient } from "viem";
import { clientFees, GRAD_GAS_CAPS } from "./gasPolicy";
import { ALLOWANCE_GAS, tokenCost } from "./paymaster";
import { GAS } from "../config";

export type GasOpKind = "trade" | "gradBuy";
/** Mirrors lib/server/paymasterCore ALLOWANCE_FEE_MULT (server module; not imported into client code). */
export const ALLOWANCE_FEE_MULT = BigInt(2);
export const TRADE_GAS_LIMIT = Object.values(ALLOWANCE_GAS).reduce((a, b) => a + b, BigInt(0));   // 2.41M
export const GRAD_GAS_LIMIT = GRAD_GAS_CAPS.total;                                                 // 6M
export const gasLimitFor = (k: GasOpKind) => (k === "gradBuy" ? GRAD_GAS_LIMIT : TRADE_GAS_LIMIT);
/** Config fallbacks (lib/config GAS) used only until the first live read. */
export const CONFIG_GAS_PRICE_WEI = BigInt(Math.ceil(GAS.robinhoodGwei * 1e9));
/** USDG decimals before the token was read: 18 on RH testnet mUSDG (46630), 6 on mainnet USDG. */
export const fallbackUsdgDecimals = (chainId: number) => (chainId === 46630 ? 18 : 6);
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
/**
 * peekGasReservePerOp: 0n when gas isn't paid in USDG (ETH self-pay: no USDG reserve); the WARM value when a fresh
 * allowance is cached; else null (cold — gasReservePerOp derives).
 */
export function peekReserve(o: { usdgGas: boolean; kind?: GasOpKind; allowance?: WarmAllowance; opMaxFee?: bigint; cap?: bigint }): bigint | null {
  if (!o.usdgGas) return BigInt(0);
  const a = o.allowance; if (!a) return null;
  if ((o.kind ?? "trade") === "trade") return a.maxTokenCost;
  const fee = o.opMaxFee !== undefined && o.opMaxFee > a.maxFeePerGas ? o.opMaxFee : a.maxFeePerGas;
  const r = tokenCost(GRAD_GAS_LIMIT * fee, a.rate) + a.debt;
  return o.cap !== undefined && r > o.cap ? o.cap : r;
}
/** gasReservePerOp: never null — warm value, else derivedGasReserve. */
export function reserveOrDerived(peek: bigint | null, d: Parameters<typeof derivedGasReserve>[0]): bigint {
  return peek ?? derivedGasReserve(d);
}

// inline fragments (not ./paymaster's parseAbi): tiny and explicit
const maxCostCapAbi = [{ type: "function", name: "maxCostCap", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;
const erc20DecimalsAbi = [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const;
type Reader = Pick<PublicClient, "readContract" | "getGasPrice">;
export const GAS_PRICE_TTL_MS = 30_000;

/** paymaster.maxCostCap() + usdg.decimals() (read once) and eth_gasPrice (re-read when older than GAS_PRICE_TTL_MS).
 * Warmed at session start and on warm(); a failure keeps the previous value (or cold). */
export class PaymasterCapCache {
  private v?: { cap: bigint; decimals: number };
  private gp?: { wei: bigint; at: number };
  private inflight?: Promise<{ cap: bigint; decimals: number } | undefined>;
  constructor(private clock: () => number = Date.now) {}
  peek() { return this.v; }
  gasPrice(): bigint | undefined { return this.gp?.wei; }
  setGasPrice(wei: bigint) { if (wei > BigInt(0)) this.gp = { wei, at: this.clock() }; }
  warmGasPrice(pc: Pick<Reader, "getGasPrice">): Promise<void> {
    if (this.gp && this.clock() - this.gp.at < GAS_PRICE_TTL_MS) return Promise.resolve();
    return pc.getGasPrice().then((w) => this.setGasPrice(BigInt(w)), () => undefined);
  }
  warm(pc: Pick<Reader, "readContract">, paymaster: Address, usdg: Address): Promise<{ cap: bigint; decimals: number } | undefined> {
    if (this.v) return Promise.resolve(this.v);
    return (this.inflight ??= Promise.all([
      pc.readContract({ address: paymaster, abi: maxCostCapAbi, functionName: "maxCostCap" }) as Promise<bigint>,
      pc.readContract({ address: usdg, abi: erc20DecimalsAbi, functionName: "decimals" }) as Promise<number>,
    ]).then(([cap, decimals]) => (this.v = { cap: BigInt(cap), decimals: Number(decimals) }))
      .catch(() => undefined)
      .finally(() => { this.inflight = undefined; }));
  }
}
