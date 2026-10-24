/**
 * Rapid taps (GAME cash reservation): the USDG a pending op may still take for gas, SYNC and in USDG base units.
 *   reserve = liveCash − Σ pending (amountIn + gasReservePerOp())
 * Per op the paymaster flow approves exactly `maxTokenCost` USDG first (lib/aa/paymasterClient), so that is the most
 * one op can take for gas: the warm per-sender allowance's maxTokenCost, else the paymaster's maxCostCap() (every
 * maxTokenCost is ≤ maxCostCap on-chain), else — fully cold — FALLBACK_MAX_COST_USDG whole USDG (the deploy default
 * DEFAULT_MAX_COST_USDG in contracts/script/DeployPaymaster.s.sol). Pure: no RPC on the read path.
 */
import type { Address, PublicClient } from "viem";

/** Whole USDG = DeployPaymaster.s.sol DEFAULT_MAX_COST_USDG (the deployed maxCostCap unless an admin lowered/raised it). */
export const FALLBACK_MAX_COST_USDG = 10;
/** USDG decimals before the token was read: 18 on RH testnet mUSDG (46630), 6 on mainnet USDG. */
export const fallbackUsdgDecimals = (chainId: number) => (chainId === 46630 ? 18 : 6);
/** The cold-cache reserve: FALLBACK_MAX_COST_USDG at `decimals`. */
export const fallbackGasReserve = (decimals: number) => BigInt(FALLBACK_MAX_COST_USDG) * BigInt(10) ** BigInt(decimals);

// inline fragments (not ./paymaster): session.ts imports this statically and stays light in first-load JS
const maxCostCapAbi = [{ type: "function", name: "maxCostCap", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;
const erc20DecimalsAbi = [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const;
type Reader = Pick<PublicClient, "readContract">;

/** paymaster.maxCostCap() + usdg.decimals(), read once at warm (deduped; a failure just leaves it cold until the next warm). */
export class PaymasterCapCache {
  private v?: { cap: bigint; decimals: number };
  private inflight?: Promise<{ cap: bigint; decimals: number } | undefined>;
  peek() { return this.v; }
  warm(pc: Reader, paymaster: Address, usdg: Address): Promise<{ cap: bigint; decimals: number } | undefined> {
    if (this.v) return Promise.resolve(this.v);
    return (this.inflight ??= Promise.all([
      pc.readContract({ address: paymaster, abi: maxCostCapAbi, functionName: "maxCostCap" }) as Promise<bigint>,
      pc.readContract({ address: usdg, abi: erc20DecimalsAbi, functionName: "decimals" }) as Promise<number>,
    ]).then(([cap, decimals]) => (this.v = { cap: BigInt(cap), decimals: Number(decimals) }))
      .catch(() => undefined)
      .finally(() => { this.inflight = undefined; }));
  }
}

/**
 * peekGasReservePerOp: 0n when gas isn't paid in USDG (ETH self-pay: no USDG reserve), the warm allowance's
 * maxTokenCost, else the cached maxCostCap, else null (cold — caller decides; gasReservePerOp falls back).
 */
export function peekReserve(o: { usdgGas: boolean; allowanceMaxTokenCost?: bigint; cap?: bigint }): bigint | null {
  if (!o.usdgGas) return BigInt(0);
  return o.allowanceMaxTokenCost ?? o.cap ?? null;
}
/** gasReservePerOp: never null — the cold value is fallbackGasReserve(decimals). */
export function reserveOrFallback(peek: bigint | null, decimals: number): bigint {
  return peek ?? fallbackGasReserve(decimals);
}
