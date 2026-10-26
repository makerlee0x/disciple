// Real-data achievements (GAME): every V1 rule through SITE's shared evaluator (edge cases: refund-net $, realized-only,
// impact thresholds 2 / 12 / 25 / 50 %), legacy catalog fixes, display entries, client + view merge + toast feed.
//   pnpm test:achievements
import test from "node:test";
import assert from "node:assert/strict";
import {
  V1_ACHIEVEMENT_IDS, fetchAchievements, parseAchievementsBody, parseFeedBody, realAchievementViews, unlockFromRow, watchUnlocks,
} from "../lib/game/achievementsClient.ts";
import { ACHIEVEMENTS, V1_RULES, achievementDisplay, achievementIconPath, type AchEvent, type AchFillEvent } from "../lib/achievements.ts";
import { evaluateWallet } from "../lib/achievementsEval.ts";
import { BOMB_PCT, BOMB_TIERS } from "../lib/config.ts";
import { playerUsd, usdgAmounts } from "../lib/trades.ts";
import { existsSync } from "node:fs";

const W = "0x" + "ab".repeat(20);
const res = (status: number, body: unknown) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("client: API body → items; seconds normalized to ms; junk rows dropped", async () => {
  const r = await fetchAchievements(W, { fetchImpl: res(200, { wallet: W, items: [{ id: "nuke_ach", rarity: "EPIC", unlockedAt: 1_760_000_000, tx: "0x1", target: 1 }, { nope: 1 }, null] }) });
  assert.equal(r.source, "api");
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].unlockedAt, 1_760_000_000_000);
});

test("client fallback: 404 / 500 / throw / bad shape / bad wallet → unavailable, never sample data", async () => {
  for (const f of [res(404, {}), res(500, {}), res(200, { items: "x" }), async () => { throw new Error("offline"); }]) {
    const r = await fetchAchievements(W, { fetchImpl: f as never });
    assert.deepEqual({ s: r.source, n: r.items.length }, { s: "unavailable", n: 0 });
  }
  let called = false;
  const r = await fetchAchievements("not-a-wallet", { fetchImpl: (async () => { called = true; return { ok: true, status: 200, json: async () => ({ items: [] }) }; }) as never });
  assert.equal(r.source, "unavailable"); assert.equal(called, false);
});

test("views: V1 set only (10 picks + atom_bomber), unlocked/in-progress/locked from API", () => {
  assert.equal(V1_ACHIEVEMENT_IDS.length, 11);
  const v = realAchievementViews({ items: [
    { id: "first_blessing", unlockedAt: 1, target: 1 },
    { id: "unfumbled", progress: 200, target: 500 },
    { id: "not_in_v1", unlockedAt: 1 },
  ] });
  assert.deepEqual(v.map((x) => x.id), [...V1_ACHIEVEMENT_IDS]);
  const by = Object.fromEntries(v.map((x) => [x.id, x]));
  assert.equal(by.first_blessing.state, "unlocked"); assert.equal(by.first_blessing.pct, 100);
  assert.equal(by.unfumbled.state, "in_progress"); assert.equal(by.unfumbled.pct, 40);
  assert.equal(by.nuke_ach.state, "locked");
  assert.ok(by.final_boost.name.length > 0, "unknown-to-catalog id still renders");
  assert.equal(realAchievementViews({ items: [] }).filter((x) => x.state !== "locked").length, 0, "fallback = all locked");
});

test("feed: shape-tolerant, filters bad rows", () => {
  const { rows } = parseFeedBody({ items: [{ wallet: W.toUpperCase().replace("0X", "0x"), id: "first_grenade", unlockedAt: 5 }, { id: "x" }] });
  assert.equal(rows.length, 1); assert.equal(rows[0].wallet, W);
  assert.equal(parseFeedBody({ unlocks: [{ wallet: W, id: "a" }] }).rows.length, 1);
  assert.equal(parseFeedBody(null).rows.length, 0);
});

test("watchUnlocks: toasts each id once, only for our wallet, survives a missing feed", async () => {
  const other = "0x" + "cd".repeat(20);
  const bodies = [
    { status: 404, body: {} },
    { status: 200, body: { items: [{ wallet: W, id: "first_grenade", unlockedAt: 10 }, { wallet: other, id: "nuke_ach", unlockedAt: 11 }] } },
    { status: 200, body: { items: [{ wallet: W, id: "first_grenade", unlockedAt: 10 }, { wallet: W, id: "nuke_ach", unlockedAt: 12 }] } },
  ];
  let i = 0; const got: string[] = []; const store = new Map<string, string>();
  const stop = watchUnlocks(W, (r) => got.push(r.id), {
    intervalMs: 1, now: () => 0, storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    fetchImpl: (async () => { const b = bodies[Math.min(i++, bodies.length - 1)]; return { ok: b.status === 200, status: b.status, json: async () => b.body }; }) as never,
  });
  await new Promise((r) => setTimeout(r, 60)); stop();
  assert.deepEqual(got, ["first_grenade", "nuke_ach"]);
  assert.deepEqual(JSON.parse(store.get(`disciple.ach.seen.${W}`)!), ["first_grenade", "nuke_ach"]);
});

test("toast payload: catalog name + rarity", () => {
  const u = unlockFromRow({ wallet: W, id: "first_blessing", unlockedAt: 1 });
  assert.equal(u.name, "First Blessing"); assert.ok(u.rarity);
});

test("parseAchievementsBody keeps wallet lowercase", () => {
  assert.equal(parseAchievementsBody({ items: [] }, W.toUpperCase())?.wallet, W.toUpperCase().toLowerCase());
});

/* ------------------------------------------------- rules ------------------------------------------------- */
const ME = W, OTHER = "0x" + "cd".repeat(20), COIN = "0x" + "11".repeat(20);
let seq = 0;
const F = (side: "buy" | "sell", usd: number, tokens: number, o: Partial<AchFillEvent> = {}): AchFillEvent => {
  const n = ++seq;
  return { kind: "fill", id: `0xt${n}:${n}`, tx: `0xt${n}`, block: n, logIndex: n, ts: n * 1000, coin: COIN, wallet: ME, side, venue: "curve", tokens, usd, impactBps: 0, ...o };
};
const LAUNCH = (creator: string, anon = false): AchEvent => ({ kind: "launch", tx: "0xl", block: 0, logIndex: 0, ts: 0, coin: COIN, creator, anon });
const GRAD = (tx = "0xg", block = 10_000, logIndex = 99): AchEvent => ({ kind: "graduation", tx, block, logIndex, ts: block * 1000, coin: COIN });
const got = (evs: AchEvent[], w = ME) => evaluateWallet(w, evs, V1_RULES).unlocks.map((u) => u.id).sort();
const has = (evs: AchEvent[], id: string, w = ME) => got(evs, w).includes(id);

test("V1_RULES: 10 picks + atom_bomber, every rule has a catalog def / icon / non-fallback display", () => {
  assert.deepEqual(V1_RULES.map((r) => r.id), ["first_blessing", "pad_ignition", "graduated_dev", "through_pearly_gates", "final_boost",
    "first_grenade", "cruise_missile_ach", "nuke_ach", "atom_bomber", "unfumbled", "best_x_10"]);
  for (const r of V1_RULES) {
    assert.ok(ACHIEVEMENTS.some((a) => a.id === r.id), `catalog def ${r.id}`);
    assert.ok(existsSync(new URL(`../public${achievementIconPath(r.id)}`, import.meta.url)), `icon ${r.id}`);
    assert.notEqual(achievementDisplay(r.id).icon, "⭐", `display ${r.id}`);
  }
});

test("first_blessing counts buys ≥ $1 (curve or hook); sells and $0.99 don't", () => {
  assert.ok(has([F("buy", 1, 10)], "first_blessing"));
  assert.ok(has([F("buy", 1, 10, { venue: "hook" })], "first_blessing"));
  assert.ok(!has([F("buy", 0.99, 10)], "first_blessing"));
  assert.ok(!has([F("sell", 50, 10)], "first_blessing"));
  assert.ok(!has([F("buy", 5, 10, { wallet: OTHER })], "first_blessing"), "someone else's buy");
});

test("refund-net $: gross $1.0005 − $0.001 UsdgRefund = $0.9995 → no first_blessing; SGRAD golden $25.000151 net", () => {
  const net = (amountIn: bigint, usdgRefund: bigint) => playerUsd({ side: "buy", usd: 999, ...usdgAmounts({ trader: ME, token: COIN, isBuy: true, amountIn, amountOut: BigInt(1), usdgRefund }, 6) });
  const small = net(BigInt(1_000_500), BigInt(1_000));
  assert.ok(Math.abs(small - 0.9995) < 1e-12);
  assert.ok(!has([F("buy", small, 10)], "first_blessing"));
  assert.ok(has([F("buy", net(BigInt(1_000_500), BigInt(0)), 10)], "first_blessing"), "gross would have counted");
  const sgrad = net(BigInt(25_025_002), BigInt(24_851));
  assert.ok(Math.abs(sgrad - 25.000151) < 1e-9);
  // graduating buy whose refund pulls it under the $1 final_boost floor doesn't count
  const g = net(BigInt(1_200_000), BigInt(300_000));
  assert.ok(!has([F("buy", g, 10, { tx: "0xg", block: 10_000, logIndex: 5 }), GRAD("0xg", 10_000, 6)], "final_boost"));
  assert.ok(has([F("buy", sgrad, 10, { tx: "0xg", block: 10_000, logIndex: 5 }), GRAD("0xg", 10_000, 6)], "final_boost"));
});

const BOMBS = [["first_grenade", 2, 10], ["cruise_missile_ach", 12, 25], ["nuke_ach", 25, 50], ["atom_bomber", 50, 100]] as const;
test("bomb thresholds are the BOMB_PCT tiers (2 / 12 / 25 / 50 %); 'bombs dropped' = BOMB_TIERS[1] (2%)", () => {
  assert.deepEqual([BOMB_PCT.GRENADE, BOMB_PCT.CRUISE, BOMB_PCT.NUKE, BOMB_PCT.ATOM], [2, 12, 25, 50]);
  assert.equal(BOMB_TIERS[1].min, 2);
  for (const [id, pct, minUsd] of BOMBS) {
    const r = V1_RULES.find((x) => x.id === id)!;
    assert.deepEqual(r.criteria, { kind: "sell_impact", minImpactBps: pct * 100, minUsd });
  }
});
for (const [id, pct, minUsd] of BOMBS) {
  test(`${id}: own sell ≥ ${pct}% (${pct * 100} bps, inclusive) and ≥ $${minUsd}`, () => {
    const sell = (bps: number | undefined, usd: number, o: Partial<AchFillEvent> = {}) => [F("buy", 1000, 1000), F("sell", usd, 1, { impactBps: bps, ...o })];
    assert.ok(has(sell(pct * 100, minUsd), id), "exactly at threshold");
    assert.ok(!has(sell(pct * 100 - 1, 1e6), id), "1 bp under");
    assert.ok(!has(sell(pct * 100, minUsd - 0.01), id), "$ floor");
    assert.ok(!has(sell(undefined, 1e6), id), "no impactBps (pre-FILL_V3 fill) never fires");
    assert.ok(!has([F("buy", 1e6, 1, { impactBps: 99_999 })], id), "a buy is not a bomb");
    assert.ok(!has(sell(pct * 100, minUsd, { wallet: OTHER }), id), "someone else's sell (no 'be present' credit)");
  });
}
test("impact is uncapped: one 150% sell ≥ $100 unlocks all four bomb tiers", () => {
  const ids = got([F("sell", 100, 1, { impactBps: 15_000 })]);
  for (const [id] of BOMBS) assert.ok(ids.includes(id), id);
});
test("old buggy rules are gone: 3 grenades ≠ cruise; 2 nukes ≠ atom; nuke needs your own sell", () => {
  const three = [F("buy", 1000, 1000), ...[0, 1, 2].map(() => F("sell", 30, 1, { impactBps: 300 }))];
  assert.ok(has(three, "first_grenade")); assert.ok(!has(three, "cruise_missile_ach"));
  const two = [F("buy", 1000, 1000), F("sell", 200, 1, { impactBps: 2600 }), F("sell", 200, 1, { impactBps: 2600 })];
  assert.ok(has(two, "nuke_ach")); assert.ok(!has(two, "atom_bomber"));
});

test("best_x_10 is realized-only: sold part ≥ 10× its average-cost basis, basis ≥ $10", () => {
  assert.ok(has([F("buy", 10, 100), F("sell", 100, 100)], "best_x_10"));
  assert.ok(!has([F("buy", 10, 100), F("sell", 99.99, 100)], "best_x_10"));
  assert.ok(!has([F("buy", 9.99, 100), F("sell", 10_000, 100)], "best_x_10"), "basis under $10");
  assert.ok(!has([F("buy", 10, 100), F("buy", 10_000, 1)], "best_x_10"), "unrealized (price 100×, never sold)");
  assert.ok(has([F("buy", 20, 200), F("sell", 100, 100)], "best_x_10"), "half sold at 10× avg cost (basis $10)");
  assert.ok(!has([F("buy", 10, 1), F("sell", 1000, 100)], "best_x_10"), "transferred-in tokens carry no basis/credit");
  const r = evaluateWallet(ME, [F("buy", 10, 100), F("sell", 40, 100)], V1_RULES).progress.best_x_10;
  assert.deepEqual(r, { progress: 4, target: 10 });
});
test("unfumbled: realized profit ≥ $500 on one sell (not summed)", () => {
  assert.ok(has([F("buy", 100, 100), F("sell", 600, 100)], "unfumbled"));
  assert.ok(!has([F("buy", 100, 100), F("sell", 599.99, 100)], "unfumbled"));
  assert.ok(!has([F("buy", 100, 100), F("sell", 350, 50), F("sell", 350, 50)], "unfumbled"));
});
test("pad_ignition / graduated_dev: public launches by this wallet; anon never", () => {
  assert.deepEqual(got([LAUNCH(ME)]), ["pad_ignition"]);
  assert.deepEqual(got([LAUNCH(ME), GRAD()]), ["graduated_dev", "pad_ignition"]);
  assert.deepEqual(got([LAUNCH(ME, true), GRAD()]), []);
  assert.deepEqual(got([LAUNCH(OTHER), GRAD()]), []);
});
test("through_pearly_gates: ≥ $10 curve buys and still holding curve tokens at graduation", () => {
  assert.ok(has([F("buy", 10, 10), GRAD()], "through_pearly_gates"));
  assert.ok(!has([F("buy", 9.99, 10), GRAD()], "through_pearly_gates"));
  assert.ok(!has([F("buy", 10, 10), F("sell", 12, 10), GRAD()], "through_pearly_gates"), "sold out before grad");
  assert.ok(!has([GRAD("0xg", 1, 0), F("buy", 50, 10, { venue: "hook" })], "through_pearly_gates"), "post-grad pool buy");
});
test("final_boost: the graduating buy (same tx, before GraduatedToV4), ≥ $1 net", () => {
  const at = (tx: string, usd = 5) => F("buy", usd, 10, { tx, block: 10_000, logIndex: 5 });
  assert.ok(has([at("0xg"), GRAD("0xg", 10_000, 6)], "final_boost"));
  assert.ok(!has([at("0xother"), GRAD("0xg", 10_000, 6)], "final_boost"), "different tx");
  assert.ok(!has([at("0xg", 0.5), GRAD("0xg", 10_000, 6)], "final_boost"), "under $1");
  const r = evaluateWallet(ME, [at("0xg"), GRAD("0xg", 10_000, 6)], V1_RULES).unlocks.find((u) => u.id === "final_boost")!;
  assert.equal(r.logIndex, 5, "proof = the buy log");
});
test("first unlock per rule is the proof; order-independent input", () => {
  const a = F("buy", 1, 1), b = F("buy", 1, 1);
  const r = evaluateWallet(ME, [b, a], V1_RULES);
  assert.equal(r.unlocks.find((u) => u.id === "first_blessing")!.tx, a.tx);
});

/* -------------------------------------- legacy catalog (PlayerStats) fixes -------------------------------------- */
const def = (id: string) => ACHIEVEMENTS.find((a) => a.id === id)!;
const stats = (m: Record<string, number>) => ({ metrics: { buyCount: 0, distinctRockets: 0, bombCount: 0, nukeCount: 0, ...m }, rings: [{ key: "bestx", value: 99 }] }) as never;
test("catalog: first_blessing counts buys; cruise/nuke/atom use their own tier counts; best_x realized-only", () => {
  assert.equal(def("first_blessing").progress(stats({ buyCount: 3, distinctRockets: 0 })), 1);
  assert.equal(def("first_blessing").progress(stats({ buyCount: 0, distinctRockets: 2 })), 0);
  assert.equal(def("cruise_missile_ach").progress(stats({ bombCount: 3 })), 0, "3 small bombs ≠ cruise");
  assert.equal(def("cruise_missile_ach").progress(stats({ cruiseCount: 1 })), 1);
  assert.equal(def("atom_bomber").progress(stats({ nukeCount: 2 })), 0, "2 nukes ≠ atom");
  assert.equal(def("atom_bomber").progress(stats({ atomCount: 1 })), 1);
  assert.equal(def("best_x_10").progress(stats({ bestRealizedX: 3 })), 3, "unrealized 99× ring ignored");
});
test("tramp display entries no longer fall back to ⭐", () => {
  for (const id of ["first_bounce", "trampoline_saint", "holy_safety_net", "wall_of_jericho", "stonemason", "gatekeeper_of_range"]) {
    assert.notEqual(achievementDisplay(id).icon, "⭐", id);
  }
});

test("views take the V1 rule name/rarity; evaluatedAt null → syncing", () => {
  const v = realAchievementViews({ items: [] });
  assert.equal(v.find((x) => x.id === "nuke_ach")!.name, V1_RULES.find((r) => r.id === "nuke_ach")!.name);
  assert.equal(parseAchievementsBody({ evaluatedAt: null, items: [] }, W)?.source, "syncing");
  assert.equal(parseAchievementsBody({ evaluatedAt: 1, items: [] }, W)?.source, "api");
  assert.ok(v.every((x) => !x.reward.points), "no points on real data (V1)");
});
