/** lib/gasRefill: relay wallet refill planning (swap size, caps, top-ups), config, spot math; cron wiring. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAINNET_WETH, MAINNET_WETH_USDG_POOL, dayKey, minOutWithSlippage, parseUnitsSafe, planRefill, planTopUps, refillConfig, spotWethOut, usdgPerEthAtSpot,
  type RelayWallet,
} from "../lib/gasRefill";

const E18 = 10n ** 18n, U = 10n ** 6n;
const eth = (s: string) => parseUnitsSafe(s, 18, "0");
const usdg = (s: string) => parseUnitsSafe(s, 6, "0");
const A = (c: string) => (`0x${c.repeat(40)}`) as `0x${string}`;
const cfg = refillConfig({ GAS_REFILL_ENABLED: "1" }, 4663, 6);
const w = (name: string, bal: string, main = false): RelayWallet => ({ name, address: A(name[0].toLowerCase()), balance: eth(bal), main });
const PRICE = 3000n * U;   // 3,000 USDG per ETH

test("config: off by default (kill switch), mainnet defaults, bad values fall back", () => {
  assert.equal(refillConfig({}, 4663, 6).enabled, false);
  assert.equal(refillConfig({ GAS_REFILL_ENABLED: "true" }, 4663, 6).enabled, false);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.pool, MAINNET_WETH_USDG_POOL);
  assert.equal(cfg.weth, MAINNET_WETH);
  assert.equal(refillConfig({}, 46630, 6).pool, undefined);   // no default pool off mainnet
  assert.equal(cfg.minWei, eth("0.002"));
  assert.equal(cfg.targetWei, eth("0.005"));
  const c = refillConfig({ GAS_REFILL_MIN_ETH: "0.01", GAS_REFILL_TARGET_ETH: "0.001", GAS_REFILL_SLIPPAGE_BPS: "9999", GAS_REFILL_MAX_SWAP_USDG: "abc" }, 4663, 6);
  assert.equal(c.targetWei, eth("0.01"));      // target never below min
  assert.equal(c.slippageBps, 100n);            // out of range ⇒ default
  assert.equal(c.maxSwapUsdg, usdg("100"));
});

test("spot math: both token orders give the same USDG/ETH price and WETH out", () => {
  // USDG token1 (6 dec), WETH token0 (18 dec): price token1/token0 raw = 3000e6/1e18
  const p = (3000n * U * 2n ** 192n) / E18;
  const sqrtA = BigInt(Math.floor(Math.sqrt(Number(p))));
  const perEthA = usdgPerEthAtSpot(sqrtA, false);
  assert.ok(perEthA > 2999n * U && perEthA < 3001n * U, String(perEthA));
  const outA = spotWethOut(3000n * U, sqrtA, false, 0);
  assert.ok(outA > eth("0.999") && outA < eth("1.001"));
  // reversed order: USDG token0
  const q = (E18 * 2n ** 192n) / (3000n * U);
  const sqrtB = BigInt(Math.floor(Math.sqrt(Number(q))));
  const perEthB = usdgPerEthAtSpot(sqrtB, true);
  assert.ok(perEthB > 2999n * U && perEthB < 3001n * U, String(perEthB));
  const withFee = spotWethOut(3000n * U, sqrtB, true, 500);
  assert.ok(withFee < spotWethOut(3000n * U, sqrtB, true, 0));
  assert.equal(minOutWithSlippage(10_000n, 100n), 9_900n);
  assert.equal(spotWethOut(0n, sqrtB, true, 500), 0n);
});

test("no swap while every wallet is above min", () => {
  const p = planRefill({ wallets: [w("MAIN", "0.004", true), w("K1", "0.003")], usdgBalance: usdg("50"), usdgPerEth: PRICE, dayUsdgUsed: 0n, cfg });
  assert.equal(p.swapUsdg, 0n);
  assert.equal(p.skipReason, "all wallets above min");
});

test("a low pool wallet + low main ⇒ swap covers both, with headroom", () => {
  const p = planRefill({ wallets: [w("MAIN", "0.001", true), w("K1", "0.0005"), w("K2", "0.004")], usdgBalance: usdg("500"), usdgPerEth: PRICE, dayUsdgUsed: 0n, cfg });
  // need: main to 0.005 (0.004) + K1 to 0.005 (0.0045) = 0.0085 ETH ≈ 25.5 USDG, + 2% headroom
  assert.equal(p.weiToBuy, eth("0.0085"));
  assert.ok(p.swapUsdg >= usdg("25.5") && p.swapUsdg <= usdg("26.1"), String(p.swapUsdg));
  assert.deepEqual(p.low, ["MAIN", "K1"]);
});

test("main relayer with spare ETH funds pool wallets without a swap", () => {
  const p = planRefill({ wallets: [w("MAIN", "0.05", true), w("K1", "0.0001")], usdgBalance: usdg("500"), usdgPerEth: PRICE, dayUsdgUsed: 0n, cfg });
  assert.equal(p.swapUsdg, 0n);
  assert.equal(p.skipReason, "main relayer has spare ETH");
});

test("min swap size: a tiny need still swaps the minimum (no dust swaps)", () => {
  const p = planRefill({ wallets: [w("MAIN", "0.0019", true)], usdgBalance: usdg("500"), usdgPerEth: 1000n * U, dayUsdgUsed: 0n, cfg });
  assert.equal(p.weiToBuy, eth("0.0031"));   // ≈ 3.2 USDG at 1,000 USDG/ETH, under the 5 USDG minimum
  assert.equal(p.swapUsdg, cfg.minSwapUsdg);
});

test("caps: per run, per day, USDG on hand; below min after caps ⇒ no swap + alert", () => {
  const big = [w("MAIN", "0", true), w("K1", "0"), w("K2", "0"), w("K3", "0"), w("K4", "0"), w("K5", "0"), w("K6", "0"), w("K7", "0")];
  const many = Array.from({ length: 30 }, (_, i) => w(`K${i}x`, "0"));
  const run = planRefill({ wallets: [...big, ...many], usdgBalance: usdg("10000"), usdgPerEth: PRICE, dayUsdgUsed: 0n, cfg });
  assert.equal(run.swapUsdg, cfg.maxSwapUsdg);
  assert.ok(run.alerts.some((a) => a.startsWith("run_cap")));
  const day = planRefill({ wallets: big, usdgBalance: usdg("10000"), usdgPerEth: PRICE, dayUsdgUsed: usdg("260"), cfg });
  assert.equal(day.swapUsdg, usdg("40"));
  assert.ok(day.alerts.some((a) => a.startsWith("day_cap")));
  const done = planRefill({ wallets: big, usdgBalance: usdg("10000"), usdgPerEth: PRICE, dayUsdgUsed: usdg("298"), cfg });
  assert.equal(done.swapUsdg, 0n);
  const poor = planRefill({ wallets: big, usdgBalance: usdg("3"), usdgPerEth: PRICE, dayUsdgUsed: 0n, cfg });
  assert.equal(poor.swapUsdg, 0n);
  assert.ok(poor.alerts.some((a) => a.startsWith("low_usdg")));
  assert.ok(poor.alerts.some((a) => a.startsWith("usdg_short")));
});

test("no price (bad / thin pool) ⇒ no swap", () => {
  const p = planRefill({ wallets: [w("MAIN", "0", true)], usdgBalance: usdg("500"), usdgPerEth: 0n, dayUsdgUsed: 0n, cfg });
  assert.equal(p.swapUsdg, 0n);
  assert.equal(p.skipReason, "no price");
});

test("top-ups: lowest first, up to target, main keeps its floor + gas reserve, day ETH cap", () => {
  const wallets = [w("MAIN", "0.02", true), w("K1", "0.0015"), w("K2", "0.0001"), w("K3", "0.004")];
  const t = planTopUps({ wallets, mainBalance: eth("0.02"), gasReserveWei: eth("0.0003"), dayWeiUsed: 0n, cfg });
  assert.deepEqual(t.sends.map((s) => [s.name, s.wei]), [["K2", eth("0.0049")], ["K1", eth("0.0035")]]);
  const short = planTopUps({ wallets, mainBalance: eth("0.0073"), gasReserveWei: eth("0.0003"), dayWeiUsed: 0n, cfg });
  assert.deepEqual(short.sends.map((s) => [s.name, s.wei]), [["K2", eth("0.0049")], ["K1", eth("0.0001")]]);
  assert.ok(short.alerts.some((a) => a.startsWith("main_short")));
  const capped = planTopUps({ wallets, mainBalance: eth("1"), gasReserveWei: 0n, dayWeiUsed: cfg.maxDayWei - eth("0.001"), cfg });
  assert.deepEqual(capped.sends.map((s) => s.wei), [eth("0.001")]);
  const none = planTopUps({ wallets, mainBalance: eth("0.002"), gasReserveWei: eth("0.0003"), dayWeiUsed: 0n, cfg });
  assert.equal(none.sends.length, 0);
});

test("dayKey is the UTC date", () => {
  assert.equal(dayKey(Date.UTC(2026, 10, 19, 23, 59)), "2026-11-19");
});

test("the cron is scheduled and authenticated; sends go through the main relayer's shared nonce allocator", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const vercel = JSON.parse(readFileSync(join(here, "../vercel.json"), "utf8")) as { crons: { path: string }[] };
  assert.ok(vercel.crons.some((c) => c.path === "/api/cron/gas-refill"));
  const route = readFileSync(join(here, "../app/api/cron/gas-refill/route.ts"), "utf8");
  assert.match(route, /CRON_SECRET/);
  assert.match(route, /timingSafeEqual/);
  const srv = readFileSync(join(here, "../lib/server/gasRefill.ts"), "utf8");
  assert.match(srv, /sendWithRelayerNonce/);
  assert.match(srv, /estimateGas/);            // simulate before every send
  assert.match(srv, /gas-refill:lock/);
  assert.doesNotMatch(srv, /signTransaction\(|poolKey\(env, n\)\)\.sign/);   // pool keys never sign
});
