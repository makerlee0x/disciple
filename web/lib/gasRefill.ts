/**
 * Relay wallet gas refill (cron /api/cron/gas-refill). Pure planning only: no RPC, no KV, no keys, so
 * scripts/test-gas-refill.mts covers every branch. The server side (lib/server/gasRefill) reads balances, runs the plan,
 * and sends.
 *
 * Money flow: players pay gas back in USDG to the MAIN relayer (withdrawFeeTo, the flat gasless trade fee). When any relay
 * wallet (main or pool) drops below GAS_REFILL_MIN_ETH, the main relayer swaps some of that USDG to ETH on the deep
 * Uniswap v3 WETH/USDG pool, then sends ETH to each low pool wallet up to GAS_REFILL_TARGET_ETH. Only the main relayer
 * ever signs (its shared KV nonce allocator); pool wallets only receive ETH, so their leased nonces are never touched.
 */
import { getAddress, isAddress, type Address } from "viem";

type Env = Record<string, string | undefined>;
const E18 = BigInt(10) ** BigInt(18);
const BPS = BigInt(10_000);
const Q192 = BigInt(2) ** BigInt(192);

/** Uniswap v3 WETH/USDG on Robinhood Chain 4663 (fee tier read on chain): the deepest USDG/ETH pool (~$10M, Nov 2026). */
export const MAINNET_WETH_USDG_POOL = "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca" as Address;
export const MAINNET_WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;

export type RefillConfig = {
  enabled: boolean;
  dryRun: boolean;
  /** a wallet below this is topped up */
  minWei: bigint;
  /** ...back up to this */
  targetWei: bigint;
  /** the main relayer is the source: it keeps at least this after sending (covers its own relaying + the next run's gas) */
  mainFloorWei: bigint;
  /** USDG base units */
  minSwapUsdg: bigint;
  maxSwapUsdg: bigint;
  maxDayUsdg: bigint;
  maxDayWei: bigint;
  /** applied to the pool's spot price (after its fee) for amountOutMin */
  slippageBps: bigint;
  /** alert when the main relayer's USDG is below this (USDG base units) */
  lowUsdg: bigint;
  /** refuse to swap when the pool holds less than this much WETH (depth guard) */
  minPoolWei: bigint;
  /** spot sanity band, whole USD per ETH: outside it the pool is treated as broken */
  minUsdPerEth: number;
  maxUsdPerEth: number;
  pool?: Address;
  weth?: Address;
  router?: Address;
};

/** "0.005" → wei / base units. Invalid ⇒ fallback. */
export function parseUnitsSafe(v: string | undefined, decimals: number, fallback: string): bigint {
  const s = (v ?? "").trim() || fallback;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s) ?? /^(\d+)(?:\.(\d+))?$/.exec(fallback)!;
  const frac = (m[2] || "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(m[1]) * BigInt(10) ** BigInt(decimals) + (decimals ? BigInt(frac || "0") : BigInt(0));
}
const int = (v: string | undefined, fallback: number, lo: number, hi: number) => {
  const n = Number((v ?? "").trim());
  return v && Number.isFinite(n) && n >= lo && n <= hi ? Math.floor(n) : fallback;
};
const optAddr = (v: string | undefined, fallback?: Address) => (v && isAddress(v.trim()) ? getAddress(v.trim()) : fallback);

/**
 * Env → config. Kill switch: GAS_REFILL_ENABLED must be "1" (off by default, and off again the moment it is unset).
 * GAS_REFILL_DRY_RUN=1 plans and reports without sending anything.
 */
export function refillConfig(env: Env, chainId: number, usdgDecimals: number): RefillConfig {
  const minWei = parseUnitsSafe(env.GAS_REFILL_MIN_ETH, 18, "0.002");
  let targetWei = parseUnitsSafe(env.GAS_REFILL_TARGET_ETH, 18, "0.005");
  if (targetWei < minWei) targetWei = minWei;
  const minSwapUsdg = parseUnitsSafe(env.GAS_REFILL_MIN_SWAP_USDG, usdgDecimals, "5");
  let maxSwapUsdg = parseUnitsSafe(env.GAS_REFILL_MAX_SWAP_USDG, usdgDecimals, "100");
  if (maxSwapUsdg < minSwapUsdg) maxSwapUsdg = minSwapUsdg;
  const mainnet = chainId === 4663;
  return {
    enabled: env.GAS_REFILL_ENABLED === "1",
    dryRun: env.GAS_REFILL_DRY_RUN === "1",
    minWei, targetWei,
    mainFloorWei: parseUnitsSafe(env.GAS_REFILL_MAIN_FLOOR_ETH, 18, "0.002"),
    minSwapUsdg, maxSwapUsdg,
    maxDayUsdg: parseUnitsSafe(env.GAS_REFILL_MAX_DAY_USDG, usdgDecimals, "300"),
    maxDayWei: parseUnitsSafe(env.GAS_REFILL_MAX_DAY_ETH, 18, "0.1"),
    slippageBps: BigInt(int(env.GAS_REFILL_SLIPPAGE_BPS, 100, 1, 1000)),
    lowUsdg: parseUnitsSafe(env.GAS_REFILL_LOW_USDG, usdgDecimals, "20"),
    minPoolWei: parseUnitsSafe(env.GAS_REFILL_MIN_POOL_ETH, 18, "20"),
    minUsdPerEth: int(env.GAS_REFILL_MIN_USD_PER_ETH, 500, 1, 1e7),
    maxUsdPerEth: int(env.GAS_REFILL_MAX_USD_PER_ETH, 50_000, 1, 1e7),
    pool: optAddr(env.GAS_REFILL_POOL, mainnet ? MAINNET_WETH_USDG_POOL : undefined),
    weth: optAddr(env.GAS_REFILL_WETH, mainnet ? MAINNET_WETH : undefined),
    router: optAddr(env.GAS_REFILL_ROUTER),
  };
}

/**
 * WETH out for `usdgIn` at the pool's spot sqrtPriceX96, after the pool fee (fee in hundredths of a bip, e.g. 500),
 * before price impact. token0/token1 order decides the direction.
 */
export function spotWethOut(usdgIn: bigint, sqrtPriceX96: bigint, usdgIsToken0: boolean, fee: number): bigint {
  if (usdgIn <= BigInt(0) || sqrtPriceX96 <= BigInt(0)) return BigInt(0);
  const p2 = sqrtPriceX96 * sqrtPriceX96;
  const gross = usdgIsToken0 ? (usdgIn * p2) / Q192 : (usdgIn * Q192) / p2;
  return (gross * BigInt(1_000_000 - fee)) / BigInt(1_000_000);
}
/** USDG base units per 1 ETH at spot (no fee): the price the planner and the sanity band use. */
export function usdgPerEthAtSpot(sqrtPriceX96: bigint, usdgIsToken0: boolean): bigint {
  if (sqrtPriceX96 <= BigInt(0)) return BigInt(0);
  const p2 = sqrtPriceX96 * sqrtPriceX96;
  return usdgIsToken0 ? (E18 * Q192) / p2 : (E18 * p2) / Q192;
}
export const minOutWithSlippage = (out: bigint, bps: bigint) => (out * (BPS - bps)) / BPS;

export type RelayWallet = { name: string; address: Address; balance: bigint; main: boolean };
export type TopUp = { name: string; address: Address; wei: bigint };
export type RefillPlan = {
  low: string[];
  /** ETH the main relayer needs to end at target after funding every low pool wallet */
  weiToBuy: bigint;
  swapUsdg: bigint;
  skipReason?: string;
  alerts: string[];
};

/**
 * What to swap this run. Triggers only when some wallet is below min. Buys enough ETH for the main relayer to fund every
 * low pool wallet up to target and still sit at target itself, priced with slippage headroom, then clamped to
 * [minSwap, maxSwap] ∩ day cap ∩ the USDG it holds. A need under minSwap still swaps minSwap (no dust swaps).
 */
export function planRefill(i: {
  wallets: RelayWallet[]; usdgBalance: bigint; usdgPerEth: bigint; dayUsdgUsed: bigint; cfg: RefillConfig;
}): RefillPlan {
  const { cfg } = i;
  const alerts: string[] = [];
  const main = i.wallets.find((w) => w.main);
  if (i.usdgBalance < cfg.lowUsdg) alerts.push(`low_usdg: main relayer holds ${i.usdgBalance} USDG base units (alert below ${cfg.lowUsdg})`);
  const low = i.wallets.filter((w) => w.balance < cfg.minWei);
  if (!main) return { low: low.map((w) => w.name), weiToBuy: BigInt(0), swapUsdg: BigInt(0), skipReason: "no main relayer", alerts };
  if (!low.length) return { low: [], weiToBuy: BigInt(0), swapUsdg: BigInt(0), skipReason: "all wallets above min", alerts };
  const poolNeed = low.filter((w) => !w.main).reduce((s, w) => s + (cfg.targetWei - w.balance), BigInt(0));
  const short = cfg.targetWei + poolNeed - main.balance;
  const weiToBuy = short > BigInt(0) ? short : BigInt(0);
  const base = { low: low.map((w) => w.name), weiToBuy, alerts };
  if (weiToBuy === BigInt(0)) return { ...base, swapUsdg: BigInt(0), skipReason: "main relayer has spare ETH" };
  if (i.usdgPerEth <= BigInt(0)) return { ...base, swapUsdg: BigInt(0), skipReason: "no price" };
  // USDG for weiToBuy at spot, + slippage headroom + 1% for the pool fee and impact, rounded up
  const raw = (weiToBuy * i.usdgPerEth + E18 - BigInt(1)) / E18;
  let want = (raw * (BPS + cfg.slippageBps + BigInt(100)) + BPS - BigInt(1)) / BPS;
  if (want < cfg.minSwapUsdg) want = cfg.minSwapUsdg;
  if (want > cfg.maxSwapUsdg) { want = cfg.maxSwapUsdg; alerts.push(`run_cap: needed more than GAS_REFILL_MAX_SWAP_USDG this run`); }
  const dayLeft = cfg.maxDayUsdg > i.dayUsdgUsed ? cfg.maxDayUsdg - i.dayUsdgUsed : BigInt(0);
  if (want > dayLeft) { want = dayLeft; alerts.push(`day_cap: GAS_REFILL_MAX_DAY_USDG reached (${i.dayUsdgUsed} used)`); }
  if (want > i.usdgBalance) { want = i.usdgBalance; alerts.push(`usdg_short: main relayer USDG can't cover the refill`); }
  if (want < cfg.minSwapUsdg) return { ...base, swapUsdg: BigInt(0), skipReason: "below min swap after caps", alerts };
  return { ...base, swapUsdg: want };
}

/**
 * ETH sends from the main relayer after the swap: lowest balance first, each up to target, never taking the main relayer
 * below mainFloorWei + gasReserveWei, and never past the day ETH cap. Pure.
 */
export function planTopUps(i: {
  wallets: RelayWallet[]; mainBalance: bigint; gasReserveWei: bigint; dayWeiUsed: bigint; cfg: RefillConfig;
}): { sends: TopUp[]; alerts: string[] } {
  const { cfg } = i;
  const alerts: string[] = [];
  const low = i.wallets.filter((w) => !w.main && w.balance < cfg.minWei).sort((a, b) => (a.balance < b.balance ? -1 : a.balance > b.balance ? 1 : 0));
  let spare = i.mainBalance - cfg.mainFloorWei - i.gasReserveWei;
  let dayLeft = cfg.maxDayWei - i.dayWeiUsed;
  const sends: TopUp[] = [];
  for (const w of low) {
    let wei = cfg.targetWei - w.balance;
    if (wei > dayLeft) { wei = dayLeft; alerts.push(`day_cap_eth: GAS_REFILL_MAX_DAY_ETH reached`); }
    if (wei > spare) { wei = spare; alerts.push(`main_short: main relayer can't fund ${w.name} to target`); }
    if (wei <= BigInt(0)) break;
    sends.push({ name: w.name, address: w.address, wei });
    spare -= wei; dayLeft -= wei;
  }
  return { sends, alerts: Array.from(new Set(alerts)) };
}

/** UTC day key for the daily caps. */
export const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
