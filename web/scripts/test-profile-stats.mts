/** Public profile stats (lib/profileStatsCore) + default rocket art chain (lib/rocketDefault). Run: npm run test:profile-stats */
import test from "node:test";
import assert from "node:assert/strict";
import { BOMB_MIN_IMPACT_BPS, impactBpsOf, publicSummaryOf, statsTradeOf } from "../lib/profileStatsCore";
import { BOMB_PCT } from "../lib/config";
import { artSlotOf, defaultRocketArtChain, rocketArtTier, DEFAULT_ROCKET_IMAGE, LAUNCH_TIER } from "../lib/rocketDefault";
import type { Fill } from "../lib/trades";

const C = "0x00000000000000000000000000000000000000c1";
let i = 0;
const fill = (side: "buy" | "sell", usd: number, priceUsd: number, extra: Partial<Fill> & { impactBps?: number } = {}): Fill & { impactBps?: number } => ({
  id: `t${i}:0`, tx: `0x${(++i).toString(16).padStart(64, "0")}`, logIndex: 0, block: i, ts: 1_700_000_000_000 + i * 60_000, coin: C,
  trader: "0x00000000000000000000000000000000000000aa", side, venue: "curve", tokens: usd / priceUsd, usd, priceUsd, mcapUsd: priceUsd * 1e6, ...extra,
});
const meta = { ticker: "TST", name: "Test" };

test("bomb threshold is the grenade, read by name from BOMB_PCT (not BOMB_TIERS[0], which is PUFF)", () => {
  assert.equal(BOMB_MIN_IMPACT_BPS, BOMB_PCT.GRENADE * 100);
  assert.equal(BOMB_MIN_IMPACT_BPS, 200);
});

test("indexed impactBps wins; each sell ≥ grenade counts once whatever its tier; buys never count", () => {
  const fills = [fill("buy", 100, 1, { impactBps: 900 }), fill("sell", 30, 1.1, { impactBps: 199 }), fill("sell", 30, 1.1, { impactBps: 200 }), fill("sell", 30, 1.1, { impactBps: 5000 })];
  const trades = fills.map((f) => statsTradeOf(f, meta));
  const s = publicSummaryOf(trades, fills);
  assert.equal(s.bombsDropped, 2);
  assert.equal(s.impactSource, "indexed");
  assert.equal(s.trades, 4);
});

test("without indexed impact: estimated from pre/post price, flagged 'estimated'", () => {
  const f = fill("sell", 10, 1);
  assert.equal(typeof impactBpsOf(f), "number");
  assert.ok(Number.isFinite(impactBpsOf(f)));
  const s = publicSummaryOf([statsTradeOf(f, meta)], [f]);
  assert.equal(s.impactSource, "estimated");
});

test("PnL / win rate: a profitable round trip is one closed winning trade", () => {
  const fills = [fill("buy", 100, 1, { impactBps: 10 }), fill("sell", 150, 1.5, { impactBps: 10, tokens: 100 })];
  const s = publicSummaryOf(fills.map((f) => statsTradeOf(f, meta)), fills);
  assert.ok(s.realizedPnlUsd > 0, `pnl ${s.realizedPnlUsd}`);
  assert.equal(s.closedTrades, 1);
  assert.equal(s.winRate, 1);
});

test("no trades ⇒ zeros, no NaN", () => {
  const s = publicSummaryOf([], []);
  assert.deepEqual([s.realizedPnlUsd, s.winRate, s.closedTrades, s.bombsDropped], [0, 0, 0, 0]);
});

test("default art: size rule, tier variant only on md/lg, generic fallback, never for test coins", () => {
  assert.equal(artSlotOf(30), "sm"); assert.equal(artSlotOf(64), "sm"); assert.equal(artSlotOf(120), "md"); assert.equal(artSlotOf(140), "lg");
  assert.deepEqual(defaultRocketArtChain({ slot: "sm", tier: 3 }), ["/assets/rocket-default/rocket-default-sm_128.webp"]);
  assert.deepEqual(defaultRocketArtChain({ slot: "md", tier: 3 }), ["/assets/rocket-default/tier/rocket-default_tier3_256.webp", "/assets/rocket-default/rocket-default_256.webp"]);
  assert.deepEqual(defaultRocketArtChain({ slot: "lg", tier: 99 }), [DEFAULT_ROCKET_IMAGE]);
  assert.deepEqual(defaultRocketArtChain({ slot: "md", tier: 0, coin: "0x4C0B30188F5FF953AC81499EC421C71074A2CB99" }), [], "test coin (SGRAD) gets no default art");
  assert.equal(rocketArtTier({ mcap: 5e6 }), LAUNCH_TIER, "launch tier for now (lee)");
});
