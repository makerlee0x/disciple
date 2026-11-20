// The Turbo page's PnL windows and trading numbers (lib/turbo/profile).   npx tsx --test scripts/test-turbo-profile.mts
import { test } from "node:test";
import assert from "node:assert/strict";
const P = await import("../lib/turbo/profile");

const H = 3_600_000, now = 1_800_000_000_000;
const f = (hAgo: number, pnl: number | null, fee = 0.01, usd = 100) => ({ at: now - hAgo * H, market: "BTC", side: "sell" as const, size: 0.001, price: 100_000, usd, fee, pnl, liq: false });

test("PnL windows: realized PnL net of fees, by fill time", () => {
  const fills = [f(1, 2), f(30, -1), f(24 * 10, 5), f(24 * 40, 10), f(2, null)];
  const p = P.pnlOf(fills, now);
  assert.equal(p.d1, Math.round((2 - 0.01 - 0.01) * 100) / 100);
  assert.equal(p.d7, Math.round((2 - 1 - 0.03) * 100) / 100);
  assert.equal(p.d30, Math.round((2 - 1 + 5 - 0.04) * 100) / 100);
  assert.equal(p.all, Math.round((2 - 1 + 5 + 10 - 0.05) * 100) / 100);
});

test("trading: green closes count only closing fills; no fills = null", () => {
  assert.equal(P.tradingOf([]), null);
  const t = P.tradingOf([f(1, 2), f(2, -1), f(3, null), f(4, 3)])!;
  assert.equal(t.fills, 4); assert.equal(t.volume, 400); assert.equal(t.winRate, 2 / 3);
});
