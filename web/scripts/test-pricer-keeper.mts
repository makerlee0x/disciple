// pnpm test:pricer-keeper — pure: active-base selection + daily cost math for /api/cron/poke-pricer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { activeBases, dailyCost } from "../lib/pricerKeeper";
const S = "0xd4d0eB01960AACE441bFcb323Bfaf7c3d8b555a3", U = "0x25030Bff74764aD72b912276a603717DB1C00644", X = "0x1111111111111111111111111111111111111111";
test("bases: default quote + launched quotes, deduped (case-insensitive), USDG and zero skipped", () => {
  const b = activeBases({ defaultQuote: S, usdg: U, launchedQuotes: [S.toLowerCase(), U, X, "0x0000000000000000000000000000000000000000", "junk"] });
  assert.deepEqual(b, [S.toLowerCase(), X]);
});
test("cost: 1440 pokes/base/day", () => {
  const c = dailyCost({ bases: 2, gasPerPoke: BigInt(76_000), gasPriceWei: BigInt(1e7) });
  assert.equal(c.pokes, 2880); assert.equal(c.gas, BigInt(2880 * 76_000)); assert.equal(c.wei, BigInt(2880 * 76_000) * BigInt(1e7));
});
test("shouldPoke: only when needed (maker 2026-11-20: no gas while nothing happens)", async () => {
  const { shouldPoke, POKE_MAX_GAP_SEC } = await import("../lib/pricerKeeper");
  const P = BigInt(1_000_000), now = 10_000;
  assert.deepEqual(shouldPoke({ nowSec: now, lastPokeSec: null, twap: P, spot: P, fresh: true }), { poke: true, why: "never" });
  assert.equal(shouldPoke({ nowSec: now, lastPokeSec: now - 60, twap: null, spot: P }).why, "stale");
  assert.equal(shouldPoke({ nowSec: now, lastPokeSec: now - 60, twap: P, spot: P, fresh: false }).why, "stale");
  assert.equal(shouldPoke({ nowSec: now, lastPokeSec: now - POKE_MAX_GAP_SEC, twap: P, spot: P, fresh: true }).why, "gap");
  assert.equal(shouldPoke({ nowSec: now, lastPokeSec: now - 60, twap: P, spot: P + BigInt(10_000), fresh: true }).why, "moving");   // 1%
  assert.equal(shouldPoke({ nowSec: now, lastPokeSec: now - 60, twap: P, spot: P - BigInt(12_000), fresh: true }).why, "moving");
  assert.deepEqual(shouldPoke({ nowSec: now, lastPokeSec: now - 60, twap: P, spot: P + BigInt(9_999), fresh: true }), { poke: false, why: "quiet" });
  assert.ok(POKE_MAX_GAP_SEC < 900, "under QuotePricer's 15 min max gap");
});
