// V1 achievements engine (SITE): pure evaluator + KV engine idempotency (local in-memory KV, no network).
//   pnpm test:achievements-server
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KV_LOCAL_FILE = join(mkdtempSync(join(tmpdir(), "ach-")), "kv.json");
delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.KV_REST_API_URL;

const { V1_RULES } = await import("../lib/achievements");
type AchEvent = import("../lib/achievements").AchEvent;
type AchievementRule = import("../lib/achievements").AchievementRule;
const { evaluateWallet } = await import("../lib/achievementsEval");
const { toFill, storeFills } = await import("../lib/server/trades");
const { processDirty, achievementsOf, feedSince, fillEvent } = await import("../lib/server/achievements");
const { ACH } = await import("../lib/server/achKeys");
const { kv } = await import("../lib/server/kv");

const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40), C1 = "0x" + "c".repeat(40), ANON = "0x73a2a6e049aa21a5c440f3bc358de37fe3f7c509";
let li = 0;
const ref = (block: number, logIndex = li++, tx = `0xt${block}`) => ({ tx, block, logIndex, ts: block * 1000 });
const fill = (wallet: string, side: "buy" | "sell", tokens: number, usd: number, o: Partial<{ block: number; logIndex: number; tx: string; venue: "curve" | "hook"; impactBps: number; coin: string }> = {}): AchEvent => {
  const r = ref(o.block ?? 100, o.logIndex, o.tx);
  return { kind: "fill", id: `${r.tx}:${r.logIndex}`, ...r, coin: o.coin ?? C1, wallet, side, venue: o.venue ?? "curve", tokens, usd, impactBps: o.impactBps };
};
const ids = (r: { unlocks: { id: string }[] }) => r.unlocks.map((u) => u.id).sort();
const ATOM: AchievementRule = { id: "atom_bomber", name: "Atom Bomber", rarity: "LEGENDARY", criteria: { kind: "sell_impact", minImpactBps: 5000, minUsd: 50 } };

test("V1_RULES: GAME's 10 picks + atom_bomber, unique ids", () => {
  assert.equal(V1_RULES.length, 11);   // GAME added atom_bomber (game/achievements)
  assert.equal(new Set(V1_RULES.map((r) => r.id)).size, 11);
});

test("first_blessing: first buy ≥ $1 is the proof", () => {
  const r = evaluateWallet(A, [fill(A, "buy", 1, 0.5, { block: 1 }), fill(A, "buy", 1, 1, { block: 2 })], V1_RULES);
  assert.deepEqual(ids(r), ["first_blessing"]);
  assert.equal(r.unlocks[0].block, 2);
});

test("bombs: impact ladder ≥ (inclusive), $ floors, uncapped impact, missing impactBps never fires", () => {
  const rules = [...V1_RULES, ATOM];
  const base = [fill(A, "buy", 100, 5, { block: 1 })];
  assert.deepEqual(ids(evaluateWallet(A, [...base, fill(A, "sell", 10, 9.99, { block: 2, impactBps: 9000 })], rules)), ["first_blessing"]);
  assert.deepEqual(ids(evaluateWallet(A, [...base, fill(A, "sell", 10, 10, { block: 2, impactBps: 200 })], rules)), ["first_blessing", "first_grenade"]);
  assert.deepEqual(ids(evaluateWallet(A, [...base, fill(A, "sell", 10, 60, { block: 2, impactBps: 2500 })], rules)),
    ["cruise_missile_ach", "first_blessing", "first_grenade", "nuke_ach"]);
  assert.ok(ids(evaluateWallet(A, [...base, fill(A, "sell", 10, 60, { block: 2, impactBps: 120_000 })], rules)).includes("atom_bomber"));
  assert.deepEqual(ids(evaluateWallet(A, [...base, fill(A, "sell", 10, 60, { block: 2 })], rules)), ["first_blessing"]);
  // buys never count as bombs
  assert.deepEqual(ids(evaluateWallet(A, [fill(A, "buy", 10, 60, { block: 2, impactBps: 9000 })], rules)), ["first_blessing"]);
});

test("unfumbled / best_x_10: average-cost basis, realized only, basis floor, transfer-in ignored", () => {
  // buy 100 @ $20, sell 100 for $250 ⇒ profit 230 (progress), 12.5× on $20 basis ⇒ Tenfold
  const r = evaluateWallet(A, [fill(A, "buy", 100, 20, { block: 1 }), fill(A, "sell", 100, 250, { block: 2 })], V1_RULES);
  assert.deepEqual(ids(r), ["best_x_10", "first_blessing"]);
  assert.equal(Math.round(r.progress.unfumbled.progress), 230);
  // 120× but basis $5 < $10 floor ⇒ no Tenfold; profit 595 ⇒ Unfumbled
  const r2 = evaluateWallet(A, [fill(A, "buy", 100, 10, { block: 1 }), fill(A, "sell", 50, 600, { block: 2 })], V1_RULES);
  assert.deepEqual(ids(r2), ["first_blessing", "unfumbled"]);
  // average cost over two buys: 100 @ $10 + 100 @ $90 ⇒ $0.50/token; sell 100 for $520 ⇒ profit 470 < 500
  const r3 = evaluateWallet(A, [fill(A, "buy", 100, 10, { block: 1 }), fill(A, "buy", 100, 90, { block: 2 }), fill(A, "sell", 100, 520, { block: 3 })], V1_RULES);
  assert.ok(!ids(r3).includes("unfumbled"));
  // tokens that arrived by transfer (no buys) ⇒ no basis ⇒ nothing realized
  const r4 = evaluateWallet(A, [fill(A, "sell", 100, 5000, { block: 3 })], V1_RULES);
  assert.deepEqual(ids(r4), []);
  // selling more than bought: only the bought part counts (proceeds pro-rata)
  const r5 = evaluateWallet(A, [fill(A, "buy", 10, 20, { block: 1 }), fill(A, "sell", 20, 1040, { block: 2 })], V1_RULES);
  assert.ok(ids(r5).includes("unfumbled"));     // 520 − 20 = 500 ≥ 500
});

test("launch / graduation picks: creator, holder through grad, graduating buyer (same tx); anon never credited", () => {
  const launch: AchEvent = { kind: "launch", coin: C1, creator: A, anon: false, ...ref(1, 0) };
  const gradTx = "0xgrad";
  const evs: AchEvent[] = [
    launch,
    fill(A, "buy", 1000, 15, { block: 2, logIndex: 0 }),                          // creator holds ≥ $10 curve buys
    fill(B, "buy", 10, 4, { block: 9, logIndex: 14, tx: gradTx }),               // B's graduating buy
    { kind: "graduation", coin: C1, ...ref(9, 15, gradTx) },
  ];
  const ra = evaluateWallet(A, evs, V1_RULES);
  assert.deepEqual(ids(ra), ["first_blessing", "graduated_dev", "pad_ignition", "through_pearly_gates"]);
  const rb = evaluateWallet(B, evs, V1_RULES);
  assert.deepEqual(ids(rb), ["final_boost", "first_blessing"]);            // $4 curve buys < $10 ⇒ no Outer Space
  assert.equal(rb.unlocks.find((u) => u.id === "final_boost")!.logIndex, 14);  // proof = the buy, not GraduatedToV4
  // sold the whole curve bag before graduation ⇒ no Outer Space
  const sold = evaluateWallet(A, [...evs, fill(A, "sell", 1000, 14, { block: 3 })], V1_RULES);
  assert.ok(!ids(sold).includes("through_pearly_gates"));
  // anon launch (creator = AnonLauncher) credits nobody
  const anonEvs: AchEvent[] = [{ kind: "launch", coin: C1, creator: ANON, anon: true, ...ref(1, 0) }, { kind: "graduation", coin: C1, ...ref(9, 15) }];
  assert.deepEqual(ids(evaluateWallet(ANON, anonEvs, V1_RULES)), []);
  // order-independent: shuffled input ⇒ same unlocks
  assert.deepEqual(evaluateWallet(A, [...evs].reverse(), V1_RULES), ra);
});

test("toFill stores impactBps (uncapped), priceBeforeX18, snipeFee; fillEvent uses net player $", () => {
  const f = toFill({ transactionHash: "0xabc", logIndex: 3, blockNumber: BigInt(5) }, "curve", {
    token: C1, trader: A, isBuy: false, tokenAmt: BigInt(10) ** BigInt(18), quoteAmt: BigInt(10) ** BigInt(18), quotePriceUsd: BigInt(10) ** BigInt(18),
    priceBeforeX18: BigInt(123456789), priceAfterX18: BigInt(1), mcapAfterUsd: BigInt(10) ** BigInt(18), impactBps: BigInt(73_000), snipeFee: BigInt(0),
  }, 5000);
  assert.equal(f.impactBps, 73_000); assert.equal(f.priceBeforeX18, "123456789"); assert.equal(f.snipeFee, "0"); assert.equal(f.v, 3);
  const e = fillEvent({ ...f, side: "buy", usd: 9, usdIn: 7.5, usdInGross: 7.6 });
  assert.equal(e.kind === "fill" && e.usd, 7.5);
});

test("KV engine: dirty → scored once; re-runs / re-dirtying never double-count; feed only for fresh unlocks", async () => {
  const s = kv();
  const now = Date.now();
  const mk = (li: number, side: boolean, usd: number, impact: number, ts: number) => toFill({ transactionHash: `0xe${li}`, logIndex: li, blockNumber: BigInt(10 + li) }, "curve", {
    token: C1, trader: A, isBuy: side, tokenAmt: BigInt(100) * BigInt(10) ** BigInt(18), quoteAmt: BigInt(Math.round(usd * 1e6)) * BigInt(10) ** BigInt(12),
    quotePriceUsd: BigInt(10) ** BigInt(18), priceBeforeX18: BigInt(1), priceAfterX18: BigInt(1), mcapAfterUsd: BigInt(10) ** BigInt(18), impactBps: BigInt(impact), snipeFee: BigInt(0),
  }, ts);
  await storeFills([mk(1, true, 5, 10, now - 3_600_000)]);                 // old buy (backfill-like)
  let r = await processDirty(10_000);
  assert.equal(r.wallets, 1); assert.deepEqual(r.unlocked.map((x) => x.id), ["first_blessing"]);
  await storeFills([mk(2, false, 30, 1500, now - 1000)]);                  // live sell ≥ 12% and ≥ $25
  r = await processDirty(10_000);
  assert.deepEqual(r.unlocked.map((x) => x.id).sort(), ["cruise_missile_ach", "first_grenade"]);
  // re-dirty + re-run: nothing new, nothing doubled
  await s.zadd(ACH.dirty(), [{ score: Date.now(), member: `${A}|manual` }]);
  r = await processDirty(10_000);
  assert.equal(r.fresh, 0);
  assert.equal((await s.zrange(ACH.unlocks(A), 100)).length, 3);
  assert.equal(await s.incrEx(ACH.count("first_grenade"), 60), 2);         // was 1 (incr probe ⇒ 2)
  assert.equal((await s.zrange(ACH.dirty(), 100)).length, 0);
  const body = await achievementsOf(A);
  assert.equal(body.items.length, V1_RULES.length);
  const g = body.items.find((i) => i.id === "first_grenade")!;
  assert.equal(g.tx, "0xe2"); assert.equal(g.progress, 1); assert.equal(g.unlockedAt, now - 1000);
  assert.equal(body.items.find((i) => i.id === "nuke_ach")!.unlockedAt, undefined);
  // feed: the two live unlocks, not the backfilled first_blessing
  const feed = await feedSince(0, A);
  assert.deepEqual(feed.map((x) => x.id).sort(), ["cruise_missile_ach", "first_grenade"]);
});
