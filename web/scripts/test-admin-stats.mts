/** lib/adminStats roll-ups (Team /admin/stats): UTC windows, guests left out, anon launches not credited, real USDG preferred. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { launchStats, tradeStats, userStats, windowOf, fillVolume } from "../lib/adminStats";

const NOW = Date.parse("2026-11-20T15:00:00Z");
const H = 3600_000, D = 24 * H;

test("windowOf counts today / 7d / 30d by UTC day", () => {
  const w = windowOf([NOW - H, NOW - 16 * H, NOW - 6 * D, NOW - 7 * D, NOW - 40 * D], NOW);
  assert.deepEqual(w, { today: 1, d7: 3, d30: 4, total: 5 });
});

test("userStats drops guests and labels logins", () => {
  const s = userStats([
    { id: "a", createdMs: NOW - H, logins: ["email", "wallet"] },
    { id: "b", createdMs: NOW - 2 * D, logins: ["google_oauth", "smart_wallet"] },
    { id: "g", createdMs: NOW - H, logins: [], guest: true },
  ], NOW, 3);
  assert.equal(s.total, 2); assert.equal(s.today, 1);
  assert.deepEqual(s.logins, { Email: 1, Wallet: 2, Google: 1 });
  assert.deepEqual(s.byDay.map((x) => x.signups), [1, 0, 1]);
});

test("launchStats ranks launchers and skips anon in the top list", () => {
  const L = (creator: string, ts: number, anon = false) => ({ token: `0x${ts}`, name: "n", ticker: "T", creator, ts, mcapUsd: 1, graduated: false, anon });
  const s = launchStats([L("0xA", NOW - H), L("0xa", NOW - 2 * H), L("0xB", NOW - 3 * D), L("0xANON", NOW - H, true)], NOW);
  assert.equal(s.total, 4); assert.equal(s.today, 3); assert.equal(s.anon, 1); assert.equal(s.launchers, 2);
  assert.deepEqual(s.top[0], { wallet: "0xa", launches: 2 });
});

test("tradeStats: volume prefers real USDG, unique + new traders", () => {
  const f = (trader: string, ts: number, usd: number, extra = {}) => ({ coin: "0xc", trader, ts, usd, side: "buy" as const, ...extra });
  assert.equal(fillVolume(f("x", NOW, 10, { usdIn: 9.5 })), 9.5);
  const s = tradeStats([f("0xA", NOW - 10 * D, 5), f("0xA", NOW - H, 10), f("0xB", NOW - H, 20, { usdIn: 19 })], NOW, 2);
  assert.deepEqual(s.today, { trades: 2, volume: 29, traders: 2 });
  assert.equal(s.total.traders, 2);
  assert.equal(s.newTraders.today, 1);
  assert.equal(s.top[0].wallet, "0xb");
  assert.equal(s.byDay[1].newTraders, 1);
});
