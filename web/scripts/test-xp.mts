/** XP levels, mission rotation and the mission evaluator (lib/xp.ts, lib/missionsEval.ts, lib/server/xp.ts totals). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayPeriod, levelInfo, missionsFor, weekPeriod, xpForLevel, XP_PER_PRESTIGE, DAILY_POOL, WEEKLY_POOL, milestoneXp } from "../lib/xp";
import { evaluateMissions, type MissionCoin, type MissionFill } from "../lib/missionsEval";
import { totals } from "../lib/server/xp";

const W = "0x00000000000000000000000000000000000000aa";
const OTHER = "0x00000000000000000000000000000000000000bb";
const T0 = Date.UTC(2026, 10, 12, 12); // Thu Nov 12 2026 12:00 UTC
const MIN = 60_000, H = 3600_000;

test("level curve: 200 + 40(n−1), level 50 at 56,840, about 12 weeks at 4,800 a week", () => {
  assert.equal(xpForLevel(2), 200);
  assert.equal(xpForLevel(5), 1040);
  assert.equal(xpForLevel(10), 3240);
  assert.equal(xpForLevel(25), 15840);
  assert.equal(XP_PER_PRESTIGE, 56840);
  assert.ok(Math.abs(XP_PER_PRESTIGE / 4800 - 12) < 0.5);
  assert.equal(levelInfo(0).level, 1);
  assert.equal(levelInfo(199).level, 1);
  assert.equal(levelInfo(200).level, 2);
  assert.equal(levelInfo(56840).level, 50);
  assert.equal(levelInfo(56840).canPrestige, true);
  // prestige banks exactly one run; overflow carries
  const p = levelInfo(56840 + 250, 1);
  assert.equal(p.level, 2); assert.equal(p.into, 50); assert.equal(p.prestigeName, "Acolyte");
});

test("periods: UTC day, Monday week", () => {
  assert.equal(dayPeriod(T0).id, "d:2026-11-12");
  assert.equal(weekPeriod(T0).id, "w:2026-11-09");
  assert.equal(weekPeriod(Date.UTC(2026, 10, 9)).id, "w:2026-11-09");
  assert.equal(weekPeriod(Date.UTC(2026, 10, 8, 23)).id, "w:2026-11-02");
});

test("the same 3 missions for everyone, varying by day", () => {
  const a = missionsFor(dayPeriod(T0)).map((m) => m.id), b = missionsFor(dayPeriod(T0)).map((m) => m.id);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 3);
  assert.ok(a.every((id) => DAILY_POOL.some((m) => m.id === id)));
  const days = new Set<string>();
  for (let i = 0; i < 14; i++) days.add(missionsFor(dayPeriod(T0 + i * 86_400_000)).map((m) => m.id).sort().join());
  assert.ok(days.size > 3, "rotation varies");
  assert.ok(missionsFor(weekPeriod(T0)).every((m) => WEEKLY_POOL.some((x) => x.id === m.id)));
});

test("milestone XP by rarity with first-launch override", () => {
  assert.equal(milestoneXp("first_blessing", "COMMON"), 100);
  assert.equal(milestoneXp("pad_ignition", "COMMON"), 500);
  assert.equal(milestoneXp("nuke_ach", "EPIC"), 600);
});

let n = 0;
const f = (coin: string, ts: number, side: "buy" | "sell", usd: number, extra: Partial<MissionFill> = {}): MissionFill =>
  ({ coin, ts, block: ++n, logIndex: 0, side, tokens: usd, usd, ...extra });
const coin = (creator: string, launchTs: number, mode = 1, grad?: MissionCoin["grad"]): MissionCoin => ({ creator, anon: false, mode, launchTs, grad });
const day = dayPeriod(T0), week = weekPeriod(T0);
const only = (id: string) => [...DAILY_POOL, ...WEEKLY_POOL].filter((m) => m.id === id);

test("boost 3 rockets: $5 minimum, own launches and wash trades don't count", () => {
  const coins = new Map([["c1", coin(OTHER, T0 - 10 * H)], ["c2", coin(OTHER, T0 - 10 * H)], ["c3", coin(W, T0 - 10 * H)], ["c4", coin(OTHER, T0 - 10 * H)], ["c5", coin(OTHER, T0 - 10 * H)]]);
  const fills = [
    f("c1", T0, "buy", 10),
    f("c2", T0 + MIN, "buy", 4),             // dust
    f("c3", T0 + 2 * MIN, "buy", 50),        // own launch
    f("c4", T0 + 3 * MIN, "buy", 20), f("c4", T0 + 4 * MIN, "sell", 20), // round trip
  ];
  let r = evaluateMissions({ wallet: W, fills, coins, now: T0 + H }, day, only("d_boost3"));
  assert.equal(r.results.d_boost3.progress, 1);
  assert.equal(r.results.d_boost3.doneAt, undefined);
  fills.push(f("c2", T0 + 5 * MIN, "buy", 6), f("c5", T0 + 6 * MIN, "buy", 6));
  r = evaluateMissions({ wallet: W, fills, coins, now: T0 + H }, day, only("d_boost3"));
  assert.equal(r.results.d_boost3.progress, 3);
  assert.equal(r.results.d_boost3.doneAt, T0 + 6 * MIN);
});

test("boost $50, fresh launch, all three modes", () => {
  const coins = new Map([["e", coin(OTHER, T0 - 30 * MIN, 1)], ["h", coin(OTHER, T0 - 5 * H, 2)], ["x", coin(OTHER, T0 - 5 * H, 0)]]);
  const fills = [f("e", T0, "buy", 20), f("h", T0 + MIN, "buy", 20), f("x", T0 + 2 * MIN, "buy", 15)];
  const r = evaluateMissions({ wallet: W, fills, coins, now: T0 + H }, day, only("d_boost50").concat(only("d_fresh"), only("d_modes")));
  assert.equal(r.results.d_boost50.doneAt, T0 + 2 * MIN);
  assert.equal(r.results.d_fresh.doneAt, T0);
  assert.equal(r.results.d_modes.doneAt, T0 + 2 * MIN);
});

test("bomb counts only after a 10 minute hold", () => {
  const coins = new Map([["c", coin(OTHER, T0 - H)]]);
  const quick = [f("c", T0, "buy", 50), f("c", T0 + 5 * MIN, "sell", 50, { impactBps: 500 })];
  assert.equal(evaluateMissions({ wallet: W, fills: quick, coins, now: T0 + H }, day, only("d_bomb")).results.d_bomb.progress, 0);
  const held = [f("c", T0, "buy", 50), f("c", T0 + 11 * MIN, "sell", 50, { impactBps: 500 })];
  assert.equal(evaluateMissions({ wallet: W, fills: held, coins, now: T0 + H }, day, only("d_bomb")).results.d_bomb.doneAt, T0 + 11 * MIN);
});

test("ride a tier: the rocket's mcap crosses a tier while you hold", () => {
  const coins = new Map([["c", coin(OTHER, T0 - H)]]);
  const fills = [f("c", T0, "buy", 10, { mcapUsd: 5_000 })];
  const path = new Map([["c", [{ ts: T0, mcapUsd: 5_000 }, { ts: T0 + MIN, mcapUsd: 11_000 }, { ts: T0 + 2 * MIN, mcapUsd: 13_000 }]]]);
  const r = evaluateMissions({ wallet: W, fills, coins, coinFills: path, now: T0 + H }, day, only("d_tier"));
  assert.equal(r.results.d_tier.doneAt, T0 + 2 * MIN);
  // sold before the climb → no ride
  const sold = [...fills, f("c", T0 + 30_000 + 3 * MIN, "sell", 10)];
  const early = new Map([["c", [{ ts: T0, mcapUsd: 5_000 }, { ts: T0 + 10 * MIN, mcapUsd: 13_000 }]]]);
  assert.equal(evaluateMissions({ wallet: W, fills: sold, coins, coinFills: early, now: T0 + H }, day, only("d_tier")).results.d_tier.progress, 0);
});

test("stay aboard 24h: $25 held, a dump resets the clock, a timer is set while pending", () => {
  const coins = new Map([["c", coin(OTHER, T0 - 50 * H)]]);
  const start = week.start + H;
  const fills = [f("c", start, "buy", 30)];
  let r = evaluateMissions({ wallet: W, fills, coins, now: start + 10 * H }, week, only("w_hold"));
  assert.equal(r.results.w_hold.progress, 0);
  assert.equal(r.recheckAt, start + 24 * H);
  r = evaluateMissions({ wallet: W, fills, coins, now: start + 25 * H }, week, only("w_hold"));
  assert.equal(r.results.w_hold.doneAt, start + 24 * H);
  const dumped = [...fills, f("c", start + 20 * H, "sell", 1)];
  r = evaluateMissions({ wallet: W, fills: dumped, coins, now: start + 25 * H }, week, only("w_hold"));
  assert.equal(r.results.w_hold.progress, 0);
  assert.equal(r.recheckAt, start + 44 * H);
});

test("launch and orbit", () => {
  const coins = new Map([["mine", coin(W, T0)], ["g", coin(OTHER, T0 - 2 * H, 1, { ts: T0 + H, block: 1_000_000, logIndex: 5 })]]);
  const fills = [f("g", T0 - H, "buy", 10)];
  const r = evaluateMissions({ wallet: W, fills, coins, now: T0 + 2 * H }, week, only("w_launch").concat(only("w_orbit")));
  assert.equal(r.results.w_launch.doneAt, T0);
  assert.equal(r.results.w_orbit.doneAt, T0 + H);
});

test("ledger totals: spending never lowers total XP", () => {
  const t = totals([
    { src: "a", kind: "mission", xp: 500, label: "", ts: 1 },
    { src: "b", kind: "buy", xp: -300, label: "", ts: 2 },
    { src: "c", kind: "prestige", xp: 0, label: "", ts: 3 },
  ]);
  assert.deepEqual(t, { total: 500, spendable: 200, prestige: 1 });
});

test("a boost counts only after its wash window has passed", () => {
  const coins = new Map([["c", coin(OTHER, T0 - H)]]);
  const fills = [f("c", T0, "buy", 60)];
  let r = evaluateMissions({ wallet: W, fills, coins, now: T0 + MIN, asOf: T0 + MIN }, day, only("d_boost50"));
  assert.equal(r.results.d_boost50.progress, 0, "window still open");
  assert.ok(r.recheckAt !== undefined && r.recheckAt > T0 + 2 * MIN, "re-scored after the window");
  r = evaluateMissions({ wallet: W, fills, coins, now: T0 + 3 * MIN, asOf: T0 + 3 * MIN }, day, only("d_boost50"));
  assert.equal(r.results.d_boost50.doneAt, T0);
  // a transfer away inside the window voids it
  const sent = [...fills, f("c", T0 + MIN, "out", 60)];
  r = evaluateMissions({ wallet: W, fills: sent, coins, now: T0 + 3 * MIN, asOf: T0 + 3 * MIN }, day, only("d_boost50"));
  assert.equal(r.results.d_boost50.progress, 0);
});

test("tokens sent away end a hold, a tier ride and an orbit seat", () => {
  const start = week.start + H;
  const coins = new Map([["c", coin(OTHER, start - H, 1, { ts: start + 30 * H, block: 1_000_000_000, logIndex: 0 })]]);
  const fills = [f("c", start, "buy", 30, { mcapUsd: 5_000 }), f("c", start + H, "out", 30)];
  const path = new Map([["c", [{ ts: start, mcapUsd: 5_000 }, { ts: start + 2 * H, mcapUsd: 13_000 }]]]);
  const r = evaluateMissions({ wallet: W, fills, coins, coinFills: path, now: start + 40 * H }, week, only("w_hold").concat(only("w_orbit")));
  assert.equal(r.results.w_hold.progress, 0);
  assert.equal(r.results.w_orbit.progress, 0);
  const d = dayPeriod(start);
  assert.equal(evaluateMissions({ wallet: W, fills, coins, coinFills: path, now: start + 3 * H }, d, only("d_tier")).results.d_tier.progress, 0);
});

test("a zero-value transfer never resets progress", () => {
  const start = week.start + H;
  const coins = new Map([["c", coin(OTHER, start - H)]]);
  const fills = [f("c", start, "buy", 30), f("c", start + H, "out", 0)];
  assert.equal(evaluateMissions({ wallet: W, fills, coins, now: start + 25 * H }, week, only("w_hold")).results.w_hold.doneAt, start + 24 * H);
});

// ---- the XP transfer scan: only a sell's own token leg is skipped (lib/xpTransfers, Vercel security review, Nov 12)
import { nonTradeOuts } from "../lib/xpTransfers";
test("transfer scan: a transfer batched with a BUY in one tx still counts as sending tokens away", () => {
  const logs = [{ tx: "0xA", logIndex: 5, tokens: 1000 }];
  assert.deepEqual(nonTradeOuts(logs, new Map()), logs);                   // buy-only tx: no sell legs to skip
  assert.deepEqual(nonTradeOuts(logs, new Map([["0xa", []]])), logs);
});
test("transfer scan: a plain sell's token leg is skipped, a transfer batched with it is not", () => {
  const sells = new Map([["0xb", [400]]]);
  assert.deepEqual(nonTradeOuts([{ tx: "0xB", logIndex: 2, tokens: 400 }], sells), []);
  const both = [{ tx: "0xB", logIndex: 1, tokens: 600 }, { tx: "0xB", logIndex: 2, tokens: 400 }];
  assert.deepEqual(nonTradeOuts(both, sells).map((l) => l.tokens), [600]);   // exact match wins whatever the order
  const split = [{ tx: "0xB", logIndex: 1, tokens: 250 }, { tx: "0xB", logIndex: 2, tokens: 150 }, { tx: "0xB", logIndex: 3, tokens: 900 }];
  assert.deepEqual(nonTradeOuts(split, sells).map((l) => l.tokens), [900]);  // a split leg up to the sell's tokens, then a transfer away
});
test("transfer scan: other txs are untouched", () => {
  const logs = [{ tx: "0xC", logIndex: 1, tokens: 10 }, { tx: "0xB", logIndex: 2, tokens: 400 }];
  assert.deepEqual(nonTradeOuts(logs, new Map([["0xb", [400]]])), [logs[0]]);
});
