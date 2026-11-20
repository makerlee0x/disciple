/**
 * USDG-per-ETH rate helpers. These are the same rateFromEnv / unmarkedRate functions that lived in
 * paymasterCore.ts (deleted with the 4337 path). Gasless withdrawals reuse this exact source: PAYMASTER_RATE
 * (USDG base units per 1 ETH, integer) wins; else PAYMASTER_USD_PER_ETH (decimal string) scaled by the token's
 * on-chain decimals. unmarkedRate is 1.0x (no markup).
 */
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { serverReadTransport } from "@/lib/rpc/serverRead";
import { ACTIVE_CHAIN, deployment } from "../chains";
import { refillConfig, usdgPerEthAtSpot } from "../gasRefill";
export function rateFromEnv(env: { PAYMASTER_RATE?: string; PAYMASTER_USD_PER_ETH?: string }, usdgDecimals: number): bigint {
  if (env.PAYMASTER_RATE) {
    if (!/^\d+$/.test(env.PAYMASTER_RATE)) throw new Error("PAYMASTER_RATE must be an integer (USDG base units per 1 ETH)");
    return BigInt(env.PAYMASTER_RATE);
  }
  const usd = env.PAYMASTER_USD_PER_ETH || "";
  const m = /^(\d+)(?:\.(\d+))?$/.exec(usd);
  if (!m) throw new Error("set PAYMASTER_RATE or PAYMASTER_USD_PER_ETH");
  const frac = (m[2] || "").slice(0, usdgDecimals).padEnd(usdgDecimals, "0");
  return BigInt(m[1]) * BigInt(10) ** BigInt(usdgDecimals) + (usdgDecimals ? BigInt(frac || "0") : BigInt(0));
}

/** No gas markup: use the price-source rate unchanged (1.0x). */
export function unmarkedRate(baseRate: bigint): bigint { return baseRate; }

/* ---------------- live rate (maker 2026-11-19: "eth isnt a fixed price") ---------------- */

/** Markup on the live price, so the refill's pool fee, slippage and price drift between runs are covered (default 3%). */
export const LIVE_RATE_MARKUP_BPS = 300;
/** A signed fee may sit this far under today's re-quote (the cached price can roll between quote and send). */
export const FEE_SLACK_BPS = BigInt(300);
const CACHE_MS = 60_000;
const poolAbi = parseAbi([
  "function token0() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);
let memo: { at: number; rate: bigint } | null = null;
let lastGood: bigint | null = null;

/** fee × (1 − slack): the lowest signed fee the relay still accepts against today's quote. */
export const feeFloor = (fee: bigint) => (fee * (BigInt(10_000) - FEE_SLACK_BPS)) / BigInt(10_000);

/**
 * USDG base units per 1 ETH for gas fees: the WETH/USDG pool the refill cron swaps on (GAS_REFILL_POOL, mainnet default),
 * read at spot, cached 60 s, plus LIVE_RATE_MARKUP_BPS (GAS_FEE_MARKUP_BPS overrides, 0–2000). Outside the refill's sanity
 * band, or when the pool can't be read, it falls back to the last good live price, and only then to the env rate
 * (PAYMASTER_RATE / PAYMASTER_USD_PER_ETH: testnet and local, where there is no pool).
 */
export async function liveUsdgPerEth(env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<bigint> {
  if (memo && now - memo.at < CACHE_MS) return memo.rate;
  const dep = deployment();
  const cfg = refillConfig(env, ACTIVE_CHAIN.id, dep.usdgDecimals);
  const n = Number(env.GAS_FEE_MARKUP_BPS);
  const markup = BigInt(Number.isFinite(n) && n >= 0 && n <= 2000 ? Math.floor(n) : LIVE_RATE_MARKUP_BPS);
  const mark = (r: bigint) => (r * (BigInt(10_000) + markup)) / BigInt(10_000);
  if (cfg.pool) {
    try {
      const pc = createPublicClient({ chain: ACTIVE_CHAIN, transport: serverReadTransport({ timeout: 3000, retryCount: 0 }) });
      const [t0, s0] = await Promise.all([
        pc.readContract({ address: cfg.pool as Address, abi: poolAbi, functionName: "token0" }),
        pc.readContract({ address: cfg.pool as Address, abi: poolAbi, functionName: "slot0" }),
      ]);
      const spot = usdgPerEthAtSpot(s0[0], t0.toLowerCase() === dep.usdg.toLowerCase());
      const usd = Number(spot / BigInt(10) ** BigInt(dep.usdgDecimals));
      if (usd >= cfg.minUsdPerEth && usd <= cfg.maxUsdPerEth) {
        lastGood = mark(spot);
        memo = { at: now, rate: lastGood };
        return lastGood;
      }
      console.error("[gas-fee] pool price outside the sanity band", { usd });
    } catch (e) {
      console.error("[gas-fee] pool read failed", String((e as Error).message).split("\n")[0].slice(0, 160));
    }
    if (lastGood) return lastGood;
  }
  const r = unmarkedRate(rateFromEnv({ PAYMASTER_RATE: env.PAYMASTER_RATE, PAYMASTER_USD_PER_ETH: env.PAYMASTER_USD_PER_ETH }, dep.usdgDecimals));
  memo = { at: now, rate: r };
  return r;
}
/** Tests only. */
export const liveRateCache = { clear() { memo = null; lastGood = null; } };
