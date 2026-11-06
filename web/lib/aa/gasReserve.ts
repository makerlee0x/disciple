/** Pending-cash reserve, in USDG base units, computed synchronously.
 * Warm: reserve the signed consent ceiling conservatively; validation collects only the op's own maximum.
 * Cold: gas units x current fee headroom x signed/config price. The on-chain limit is GAS UNITS, not USDG.
 * Any cached gas-unit bound is converted at the current fee/rate; there is no static token clamp or tap RPC.
 */
import type { Address, PublicClient } from "viem";
import { clientFees, GRAD_GAS_CAPS } from "./gasPolicy";
import { ALLOWANCE_GAS, tokenCost } from "./paymaster";
import { GAS } from "../config";
import { DEPLOYMENTS } from "../chains";

export type GasOpKind = "trade" | "gradBuy";
/** Mirrors lib/server/paymasterCore ALLOWANCE_FEE_MULT (server module; not imported into client code). */
export const ALLOWANCE_FEE_MULT = BigInt(2);
export const TRADE_GAS_LIMIT = Object.values(ALLOWANCE_GAS).reduce((a, b) => a + b, BigInt(0));   // 2,539,596
export const GRAD_GAS_LIMIT = GRAD_GAS_CAPS.total;                                                 // 6M
export const gasLimitFor = (k: GasOpKind) => (k === "gradBuy" ? GRAD_GAS_LIMIT : TRADE_GAS_LIMIT);
/** Config fallbacks (lib/config GAS) used only until the first live read. */
export const CONFIG_GAS_PRICE_WEI = BigInt(Math.ceil(GAS.robinhoodGwei * 1e9));
/** Deployment decimals before the token is read; current RH testnet USDG is 6-decimal. */
export const fallbackUsdgDecimals = (chainId: number) => DEPLOYMENTS[chainId]?.usdgDecimals ?? 6;
/** Config ETH→USDG rate (USDG base units per 1 ETH) at `decimals`. */
export const configRate = (decimals: number) => BigInt(Math.round(GAS.ethUsd * 1e6)) * BigInt(10) ** BigInt(decimals) / BigInt(1e6);

/** maxFeePerGas the paymaster allowance is signed with at gas price `gp` (same formula as paymasterCore.allowanceQuote). */
export const allowanceMaxFee = (gp: bigint) => clientFees(gp).maxFeePerGas * ALLOWANCE_FEE_MULT;

/** COLD per-op reserve (raw USDG), rounded up like DisciplePaymaster.tokenCost. */
export function derivedGasReserve(o: { kind?: GasOpKind; gasPriceWei?: bigint; rate?: bigint; decimals: number; maxGasPerOp?: bigint }): bigint {
  const r = tokenCost((o.maxGasPerOp !== undefined && o.maxGasPerOp < gasLimitFor(o.kind ?? "trade") ? o.maxGasPerOp : gasLimitFor(o.kind ?? "trade")) * allowanceMaxFee(o.gasPriceWei ?? CONFIG_GAS_PRICE_WEI), o.rate ?? configRate(o.decimals));
  return r;
}

export type WarmAllowance = { maxTokenCost: bigint; rate: bigint; debt: bigint; maxFeePerGas: bigint };
/**
 * peekGasReservePerOp: 0n when gas isn't paid in USDG (ETH self-pay: no USDG reserve); the WARM value when a fresh
 * allowance is cached; else null (cold — gasReservePerOp derives).
 */
export function peekReserve(o: { usdgGas: boolean; kind?: GasOpKind; allowance?: WarmAllowance; opMaxFee?: bigint; maxGasPerOp?: bigint }): bigint | null {
  if (!o.usdgGas) return BigInt(0);
  const a = o.allowance; if (!a) return null;
  if ((o.kind ?? "trade") === "trade") return a.maxTokenCost;
  const fee = o.opMaxFee !== undefined && o.opMaxFee > a.maxFeePerGas ? o.opMaxFee : a.maxFeePerGas;
  const r = tokenCost((o.maxGasPerOp !== undefined && o.maxGasPerOp < GRAD_GAS_LIMIT ? o.maxGasPerOp : GRAD_GAS_LIMIT) * fee, a.rate) + a.debt;
  return r;
}
/** gasReservePerOp: never null — warm value, else derivedGasReserve. */
export function reserveOrDerived(peek: bigint | null, d: Parameters<typeof derivedGasReserve>[0]): bigint {
  return peek ?? derivedGasReserve(d);
}

// inline fragments (not ./paymaster's parseAbi): tiny and explicit
const maxGasPerOpAbi = [{ type: "function", name: "maxGasPerOp", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;
const erc20DecimalsAbi = [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const;
type Reader = Pick<PublicClient, "readContract" | "getGasPrice">;
export const GAS_PRICE_TTL_MS = 30_000;

/** paymaster.maxGasPerOp() + usdg.decimals() (read once) and eth_gasPrice (re-read when older than GAS_PRICE_TTL_MS).
 * Warmed at session start and on warm(); a failure keeps the previous value (or cold). */
export class PaymasterCapCache {
  private v?: { maxGasPerOp: bigint; decimals: number };
  private gp?: { wei: bigint; at: number };
  private inflight?: Promise<{ maxGasPerOp: bigint; decimals: number } | undefined>;
  constructor(private clock: () => number = Date.now) {}
  peek() { return this.v; }
  gasPrice(): bigint | undefined { return this.gp?.wei; }
  setGasPrice(wei: bigint) { if (wei > BigInt(0)) this.gp = { wei, at: this.clock() }; }
  warmGasPrice(pc: Pick<Reader, "getGasPrice">): Promise<void> {
    if (this.gp && this.clock() - this.gp.at < GAS_PRICE_TTL_MS) return Promise.resolve();
    return pc.getGasPrice().then((w) => this.setGasPrice(BigInt(w)), () => undefined);
  }
  warm(pc: Pick<Reader, "readContract">, paymaster: Address, usdg: Address): Promise<{ maxGasPerOp: bigint; decimals: number } | undefined> {
    if (this.v) return Promise.resolve(this.v);
    return (this.inflight ??= Promise.all([
      pc.readContract({ address: paymaster, abi: maxGasPerOpAbi, functionName: "maxGasPerOp" }) as Promise<bigint>,
      pc.readContract({ address: usdg, abi: erc20DecimalsAbi, functionName: "decimals" }) as Promise<number>,
    ]).then(([maxGasPerOp, decimals]) => (this.v = { maxGasPerOp: BigInt(maxGasPerOp), decimals: Number(decimals) }))
      .catch(() => undefined)
      .finally(() => { this.inflight = undefined; }));
  }
}
