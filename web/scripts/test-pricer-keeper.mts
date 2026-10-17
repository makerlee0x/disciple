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
