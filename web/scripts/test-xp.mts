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

// ---- the transfer scan covers dormant coins still held by fills (Vercel security review, Nov 13: an old position sent
// away and left untouched for 8+ days must not count as aboard when the rocket later reaches orbit)
import { coinsToScan } from "../lib/xpTransfers";
test("transfer scan: dormant coins still held by fills are scanned, sold-out dormant coins are not", () => {
  const now = 100 * 86_400_000, D = 86_400_000;
  const fills = [
    { coin: "0xOLD", ts: now - 20 * D, side: "buy", tokens: 50 },                                   // held by fills, dormant
    { coin: "0xGONE", ts: now - 20 * D, side: "buy", tokens: 50 }, { coin: "0xGONE", ts: now - 19 * D, side: "sell", tokens: 50 },
    { coin: "0xNEW", ts: now - D, side: "buy", tokens: 5 }, { coin: "0xNEW", ts: now - D, side: "sell", tokens: 5 },  // recent
  ];
  assert.deepEqual(coinsToScan(fills, now).sort(), ["0xnew", "0xold"]);
  // a coin sold out 10 days ago is still scanned: last week's period (up to 14 days back) is still being settled
  const sold = [{ coin: "0xB", ts: now - 13 * D, side: "buy", tokens: 50 }, { coin: "0xB", ts: now - 10 * D, side: "sell", tokens: 50 }];
  assert.deepEqual(coinsToScan(sold, now), ["0xb"]);
});
import { capOuts } from "../lib/xpTransfers";
test("transfer scan: dust transfers can't push a sent-away bag out of the kept outs", () => {
  const bag = { block: 10, logIndex: 0, ts: 10, tokens: 49.99, checked: true };
  const dust = Array.from({ length: 600 }, (_, i) => ({ block: 20 + i, logIndex: 0, ts: 20 + i, tokens: 1e-18, checked: true }));
  const kept = capOuts([bag, ...dust], 500);
  assert.ok(kept.length <= 500);
  const total = kept.reduce((t, o) => t + o.tokens, 0);
  assert.ok(total >= 49.99);                             // the bag still counts as gone
  assert.equal(kept[0].block, 10);                       // at its earliest position, never later
  assert.deepEqual(capOuts([bag], 500), [bag]);
});
import { evaluateDrafts } from "../lib/missionsEval";
import { DRAFT } from "../lib/xp";
test("drafting XP: pays only aboard with $5+, only behind a pilot who boosted that coin in the last minute, 5 a day", () => {
  const C = "0x00000000000000000000000000000000000000c1", P = dayPeriod(T0);
  const buy = (ts: number, usd: number): MissionFill => ({ coin: C, ts, block: ts, logIndex: 0, side: "buy", tokens: usd, usd });
  const fills = [buy(T0 - H, 20)];
  const coinFills = new Map([[C, [{ ts: T0 - 30_000, trader: OTHER, side: "buy" }, { ts: T0 + 10 * MIN - 30_000, trader: OTHER, side: "buy" }]]]);
  const claim = (at: number, wingmen = [OTHER]) => ({ coin: C, wingmen, at });
  const run = (claims: ReturnType<typeof claim>[], f = fills) => evaluateDrafts({ wallet: W, fills: f, coinFills, claims, asOf: T0 + H }, P);
  assert.equal(run([claim(T0)]).length, 1);                                   // aboard, pilot boosted 30 s before
  assert.equal(run([claim(T0 + 2 * MIN)]).length, 0);                         // pilot's boost is older than a minute
  assert.equal(run([claim(T0, [W])]).length, 0);                              // drafting yourself never counts
  assert.equal(run([claim(T0)], [buy(T0 - H, 3)]).length, 0);                 // under $5 aboard
  assert.equal(run([claim(T0)], [buy(T0 + MIN, 20)]).length, 0);              // boarded after the slingshot
  assert.equal(run([claim(T0), claim(T0 + 1000)]).length, 1);                 // a second claim inside the gap is dropped
  const many = Array.from({ length: 9 }, (_, i) => claim(T0 + i * 5_000)).filter((c) => c.at <= T0);
  const lots = Array.from({ length: 9 }, (_, i) => ({ ts: T0 + i * 5_000 - 1000, trader: OTHER, side: "buy" }));
  const cf2 = new Map([[C, lots]]);
  const paid = evaluateDrafts({ wallet: W, fills, coinFills: cf2, claims: Array.from({ length: 9 }, (_, i) => claim(T0 + i * 5_000)), asOf: T0 + H }, P);
  assert.equal(paid.length, DRAFT.perDay);                                    // capped at 5 a day
  assert.ok(many.length >= 1);
});

/* ------------------------------------------------ in-flight missions (Nov 13) ------------------------------------------------ */
test("in-flight missions join the pools only from Monday Nov 16: running periods keep their draw", () => {
  const before = Date.UTC(2026, 10, 15, 12), after = Date.UTC(2026, 10, 18, 12);
  const NEW = new Set(["d_run", "d_crew", "w_holdbomb", "w_cashout"]);
  for (let i = 0; i < 6; i++) assert.ok(missionsFor(dayPeriod(before - i * 86_400_000)).every((m) => !NEW.has(m.id)));
  assert.ok(missionsFor(weekPeriod(before)).every((m) => !NEW.has(m.id)));
  const seen = new Set<string>();
  for (let i = 0; i < 30; i++) missionsFor(dayPeriod(after + i * 86_400_000)).forEach((m) => seen.add(m.id));
  assert.ok(seen.has("d_run") && seen.has("d_crew"));
});

{
  const C = "0x00000000000000000000000000000000000000c2", LAUNCHER = "0x00000000000000000000000000000000000000ee";
  const P2 = "0x00000000000000000000000000000000000000b2", P3 = "0x00000000000000000000000000000000000000b3", P4 = "0x00000000000000000000000000000000000000b4";
  const coins = new Map([[C, coin(LAUNCHER, T0 - 2 * H)]]);
  const cf = (ts: number, trader: string, side: "buy" | "sell", usd: number, extra: Record<string, unknown> = {}) => ({ ts, trader, side, usd, block: ts, logIndex: 0, ...extra });
  const mine = (ts: number, side: "buy" | "sell" | "out", usd: number, tokens = usd, extra: Partial<MissionFill> = {}): MissionFill => ({ coin: C, ts, block: ts, logIndex: 0, side, tokens, usd, ...extra });
  const ev = (id: string, fills: MissionFill[], coinFills: ReturnType<typeof cf>[], o: { complete?: boolean; asOf?: number; p?: typeof day } = {}) =>
    evaluateMissions({ wallet: W, fills, coins, coinFills: new Map([[C, [...coinFills, ...fills.map((x) => ({ ...x, trader: W }))]]]), coinFillsComplete: o.complete === false ? new Set() : new Set([C]), now: o.asOf ?? T0 + 6 * H, asOf: o.asOf ?? T0 + 6 * H }, o.p ?? day, only(id)).results[id];

  test("start a run: 3 other pilots boost $5+ within 60 s of your boost", () => {
    const b = mine(T0, "buy", 10);
    assert.ok(ev("d_run", [b], [cf(T0 + 5_000, P2, "buy", 6), cf(T0 + 20_000, P3, "buy", 9), cf(T0 + 50_000, P4, "buy", 5)]).doneAt === T0 + 50_000);
    assert.equal(ev("d_run", [b], [cf(T0 + 5_000, P2, "buy", 6), cf(T0 + 20_000, P3, "buy", 9), cf(T0 + 70_000, P4, "buy", 5)]).progress, 0);   // third one too late
    assert.equal(ev("d_run", [b], [cf(T0 + 5_000, P2, "buy", 6), cf(T0 + 6_000, P2, "buy", 6), cf(T0 + 20_000, P3, "buy", 9)]).progress, 0);    // same pilot twice
    assert.equal(ev("d_run", [b], [cf(T0 + 5_000, P2, "buy", 6), cf(T0 + 20_000, P3, "buy", 2), cf(T0 + 30_000, P4, "buy", 5)]).progress, 0);   // under $5
    assert.equal(ev("d_run", [b], [cf(T0 - 5_000, P2, "buy", 6), cf(T0 + 20_000, P3, "buy", 9), cf(T0 + 30_000, P4, "buy", 5)]).progress, 0);   // before you
    assert.equal(ev("d_run", [mine(T0, "buy", 4)], [cf(T0 + 5_000, P2, "buy", 6), cf(T0 + 20_000, P3, "buy", 9), cf(T0 + 30_000, P4, "buy", 5)]).progress, 0);   // your boost under $5
  });

  test("first crew: fewer than 10 other pilots boosted before you (launcher not counted, full history only)", () => {
    const early = Array.from({ length: 9 }, (_, i) => cf(T0 - 60_000 + i, "0x00000000000000000000000000000000000001" + String(i).padStart(2, "0"), "buy", 5));
    const b = mine(T0, "buy", 10);
    assert.equal(ev("d_crew", [b], [cf(T0 - 90_000, LAUNCHER, "buy", 50), ...early]).doneAt, T0);
    assert.equal(ev("d_crew", [b], [...early, cf(T0 - 1, P2, "buy", 5)]).progress, 0);            // tenth ahead of you
    assert.equal(ev("d_crew", [b], [...early, cf(T0 - 1, P2, "buy", 1)]).doneAt, T0);           // a dust buy is not crew
    assert.equal(ev("d_crew", [b], early, { complete: false }).progress, 0);                      // can't see back to launch
  });

  test("hold through a bomb: aboard $5+ when another pilot's 5%+ dump lands, no sell for 10 minutes", () => {
    const bomb = cf(T0 + H, P2, "sell", 40, { impactBps: 600 });
    const held = [mine(T0, "buy", 10)];
    assert.equal(ev("w_holdbomb", held, [bomb], { p: week }).doneAt, T0 + H + 10 * MIN);
    assert.equal(ev("w_holdbomb", held, [{ ...bomb, impactBps: 400 }], { p: week }).progress, 0);              // under 5%
    assert.equal(ev("w_holdbomb", [...held, mine(T0 + H + 5 * MIN, "sell", 2)], [bomb], { p: week }).progress, 0);   // sold some inside the 10 min
    assert.equal(ev("w_holdbomb", [...held, mine(T0 + H + 5 * MIN, "out", 0, 2)], [bomb], { p: week }).progress, 0); // sent some away
    assert.equal(ev("w_holdbomb", [mine(T0 + H + 1, "buy", 10)], [bomb], { p: week }).progress, 0);            // boarded after it
    const r = evaluateMissions({ wallet: W, fills: held, coins, coinFills: new Map([[C, [bomb]]]), now: T0 + H + 5 * MIN, asOf: T0 + H + 5 * MIN }, week, only("w_holdbomb"));
    assert.equal(r.results.w_holdbomb.progress, 0); assert.equal(r.recheckAt, T0 + H + 10 * MIN + 1);          // pays once the 10 min are up
    // your own big dump is not a bomb you held through
    assert.equal(evaluateMissions({ wallet: W, fills: held, coins, coinFills: new Map([[C, [{ ...bomb, trader: W }]]]), now: T0 + 6 * H, asOf: T0 + 6 * H }, week, only("w_holdbomb")).results.w_holdbomb.progress, 0);
  });

  test("cash out higher: sell half the bag or more above your entry, on a ride that climbed a tier", () => {
    const buy = mine(T0, "buy", 20, 100, { mcapUsd: 5_000 });
    const climb = cf(T0 + 30 * MIN, P2, "buy", 500, { mcapUsd: 40_000 });
    assert.equal(ev("w_cashout", [buy, mine(T0 + H, "sell", 30, 60, { mcapUsd: 30_000 })], [climb], { p: week }).doneAt, T0 + H);
    assert.equal(ev("w_cashout", [buy, mine(T0 + H, "sell", 30, 40, { mcapUsd: 30_000 })], [climb], { p: week }).progress, 0);   // under half the bag
    assert.equal(ev("w_cashout", [buy, mine(T0 + H, "sell", 9, 60, { mcapUsd: 30_000 })], [climb], { p: week }).progress, 0);    // below entry
    assert.equal(ev("w_cashout", [buy, mine(T0 + H, "sell", 30, 60, { mcapUsd: 5_500 })], [cf(T0 + 30 * MIN, P2, "buy", 5, { mcapUsd: 5_400 })], { p: week }).progress, 0);   // no tier climbed
  });
}

import { computeFlightLog, type FlightLogFill } from "../lib/flightLog";
test("flight log: peak aboard, bombs survived, wingmen, boosts, all from the fills", () => {
  const P2 = "0x00000000000000000000000000000000000000b2", P3 = "0x00000000000000000000000000000000000000b3";
  let b = 0;
  const x = (ts: number, trader: string, side: "buy" | "sell", usd: number, mcapUsd: number, impactBps = 0): FlightLogFill => ({ ts, block: ++b, logIndex: 0, trader, side, tokens: usd, usd, mcapUsd, impactBps });
  const fills = [
    x(T0 - H, P2, "buy", 50, 4_000),                 // before the flight
    x(T0 + 1_000, W, "buy", 10, 5_000),              // you board
    x(T0 + 2_000, P2, "buy", 40, 9_000),
    x(T0 + 3_000, P3, "buy", 30, 14_000),            // peak, OZONE
    x(T0 + 4_000, P3, "buy", 3, 14_100),             // dust: not a wingman boost (P3 already counted anyway)
    x(T0 + 5_000, P2, "sell", 60, 8_000, 900),       // a bomb you sit through
    x(T0 + 20 * MIN, W, "sell", 10, 7_000),          // you cash out long after
    x(T0 + 21 * MIN, P3, "buy", 400, 30_000),        // higher, but you're gone
  ];
  const log = computeFlightLog({ wallet: W, since: T0, now: T0 + H, fills, slingshots: 2, xp: 120 });
  assert.equal(log.peakMcap, 14_100); assert.equal(log.peakTier, "OZONE");
  assert.equal(log.bombsSurvived, 1); assert.equal(log.wingmen, 2); assert.equal(log.boosts, 1);
  assert.equal(log.slingshots, 2); assert.equal(log.xp, 120);
  // sold inside the 10 minutes: not survived
  const bailed = [...fills.slice(0, 6), x(T0 + 6_000, W, "sell", 5, 7_900)];
  assert.equal(computeFlightLog({ wallet: W, since: T0, now: T0 + H, fills: bailed }).bombsSurvived, 0);
});

test("Free play XP: daily up to 150, practice up to 20, 150 a day across Free play, paid once per run", async () => {
  const { freePlayXp, FREE_PLAY_XP } = await import("../lib/xp");
  const { awardFreePlay } = await import("../lib/server/xp");
  const { nextLevelUnlock } = await import("../lib/unlocks");
  const { kv } = await import("../lib/server/kv");
  const g = (green: boolean, cash2x: boolean, orbit: boolean) => ({ invested: 50, goals: { green, cash2x, orbit } });
  assert.equal(freePlayXp("daily", g(true, true, true)), 150);
  assert.equal(freePlayXp("daily", g(true, true, false)), 120);   // the board's "+120 XP waiting"
  assert.equal(freePlayXp("daily", { invested: 0, goals: { green: false, cash2x: false, orbit: false } }), 0);
  assert.equal(freePlayXp("practice", g(true, true, true)), 20);
  assert.equal(FREE_PLAY_XP.perDay, 150);
  const w = "0x" + Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join(""), s = kv(), now = Date.UTC(2026, 10, 13, 15);   // fresh wallet: the local store persists
  const a = await awardFreePlay(w, "fp:d:1", 120, "Daily flight #1", now, s); assert.ok(a.ok && a.xp === 120 && !a.capped);
  const again = await awardFreePlay(w, "fp:d:1", 120, "Daily flight #1", now, s); assert.ok(again.ok && again.already && again.xp === 0);
  const p1 = await awardFreePlay(w, "fp:p:x:pvp:1", 20, "p", now + 1, s); assert.ok(p1.ok && p1.xp === 20);
  const p2 = await awardFreePlay(w, "fp:p:x:pvp:2", 20, "p", now + 2, s); assert.ok(p2.ok && p2.xp === 10 && p2.capped);   // 150 − 140
  const { ledgerOf } = await import("../lib/server/xp");
  const rowsBefore = (await ledgerOf(w, s)).length;
  for (let i = 0; i < 50; i++) { const z = await awardFreePlay(w, `fp:p:x:pvp:z${i}`, 20, "p", now + 3, s); assert.ok(z.ok && z.xp === 0 && z.capped && z.totalXp === 150); }
  const none = await awardFreePlay(w, "fp:p:x:pvp:never", 0, "p", now + 4, s); assert.ok(none.ok && none.xp === 0);
  assert.equal((await ledgerOf(w, s)).length, rowsBefore, "a run paying 0 XP must not write a ledger row");
  const tomorrow = await awardFreePlay(w, "fp:p:x:pvp:4", 20, "p", now + 86_400_000, s); assert.ok(tomorrow.ok && tomorrow.xp === 20);
  // "80 more unlocks the Plasma flare": Plasma is level 5 = 1,040 XP
  assert.deepEqual(nextLevelUnlock(0, 0, 120), { name: "Plasma", part: "flare", level: 5, more: 920 });
  assert.equal(nextLevelUnlock(960)?.more, 80);
  assert.equal(nextLevelUnlock(1040)?.name, "Matte");
});
