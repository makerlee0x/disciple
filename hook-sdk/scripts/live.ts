#!/usr/bin/env node
// Read-only check of the SDK against the live v0.2 pool on Robinhood. Sends nothing, needs no key.
//   RH_RPC=https://... npm run live
import { createPublicClient, http } from "viem";
import { depthLadder, maxSizeWithinImpact, readPoolInfo, ROBINHOOD, watchSet } from "../src/index.ts";

const rpc = process.env.RH_RPC;
if (!rpc) throw new Error("set RH_RPC");
const c = createPublicClient({ transport: http(rpc) });
const { hook, strategyUsdg: pool } = ROBINHOOD;

const blockNumber = await c.getBlockNumber({ cacheTime: 0 });
const info = await readPoolInfo(c, hook, pool.id, blockNumber);
console.log(`block ${blockNumber}  live ${info.live}  fee ${info.feePips / 10_000}%  coinIs0 ${info.coinIs0}  remoteEid ${info.remoteEid}`);
const legsOk = JSON.stringify(watchSet(hook, info).v4PoolIds) === JSON.stringify(pool.sourceV4Ids);
console.log(`source legs ${info.legs.map((l) => `${l.kind}:${l.v4Id.slice(0, 10)}`).join(" x ")}  ${legsOk ? "OK" : "MISMATCH (check storage layout)"}`);

const usd = [1n, 5n, 20n, 100n].map((d) => d * 1_000_000n); // USDG has 6 decimals
// STRATEGY is currency0, so buying it is zeroForOne = false
const buys = await depthLadder(c, hook, pool.id, false, usd, { blockNumber });
for (const r of buys) {
  const usdIn = Number(r.amountIn) / 1e6;
  const out = r.quote ? Number(r.quote.amountOut) / 1e18 : 0;
  console.log(`buy  $${usdIn}: ${r.quote ? `${out.toFixed(2)} STRATEGY at $${(usdIn / out).toPrecision(5)}` : "no fill"}`);
}
const perUsd = buys[0].quote ? Number(buys[0].quote.amountOut) / 1e18 : 0; // STRATEGY per $1
if (perUsd > 0) {
  const coinSizes = usd.map((u) => BigInt(Math.round((Number(u) / 1e6) * perUsd)) * 10n ** 18n);
  for (const r of await depthLadder(c, hook, pool.id, true, coinSizes, { blockNumber })) {
    console.log(`sell ${Number(r.amountIn / 10n ** 18n)} STRATEGY: ${r.quote ? `$${(Number(r.quote.amountOut) / 1e6).toFixed(4)}` : "no fill"}`);
  }
}
for (const bps of [100, 500]) {
  const buy = await maxSizeWithinImpact(c, hook, pool.id, false, 1_000_000n, bps, { blockNumber });
  const sell =
    perUsd > 0 ? await maxSizeWithinImpact(c, hook, pool.id, true, BigInt(Math.round(perUsd)) * 10n ** 18n, bps, { blockNumber }) : 0n;
  console.log(`within ${bps / 100}% of the $1 price: buy up to ~$${(Number(buy) / 1e6).toFixed(2)}, sell up to ~${sell / 10n ** 18n} STRATEGY`);
}
