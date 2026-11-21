// Retention loop (maker 2026-11-21 "do all 10", item 4): flight streak, daily drop, season track, rival passes. Local KV.
import { beforeAll, test } from "vitest";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAY, STREAKS_FROM, dayIndex, dropReward, dropCycle, streakOf, streakPays } from "@/lib/streaks";
import { TRACK, seasonXp, trackOf } from "@/lib/season/track";
import { passedBy, PUSH_KINDS, readPrefs } from "@/lib/push";
import { rankSeasonAt } from "@/lib/duel/season";
import { ACTIVE_CHAIN } from "@/lib/chains";

let S: typeof import("@/lib/server/streaks");
let kv: typeof import("@/lib/server/kv")["kv"];
let X: typeof import("@/lib/server/xp");
beforeAll(async () => {
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.KV_REST_API_URL;
  process.env.KV_LOCAL_FILE = join(tmpdir(), `retention-test-${Date.now()}.json`);
  S = await import("@/lib/server/streaks");
  kv = (await import("@/lib/server/kv")).kv;
  X = await import("@/lib/server/xp");
});
const ledgerOf = (w: string, s: ReturnType<typeof kv>) => X.ledgerOf(w, s);
const crateKey = (w: string) => `col:${ACTIVE_CHAIN.id}:crates:${w}`;

const a = "0x" + "a".repeat(40), b = "0x" + "b".repeat(40);
const D0 = STREAKS_FROM + 10 * DAY + 3_600_000; // a day well after the origin, 01:00 UTC

test("daily drop climbs days 1-6 in XP, day 7 is a crate, then the cycle starts again", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => dropReward(n).xp), [10, 15, 20, 25, 30, 40]);
  assert.deepEqual(dropReward(7), { day: 7, xp: 0, crate: true });
  assert.deepEqual(dropReward(8), { day: 1, xp: 10, crate: false });
  assert.deepEqual(dropReward(14).crate, true);
  assert.equal(dropReward(0).day, 1);
  assert.equal(dropCycle().length, 7);
});

test("flight streak pays like the others, with its own names and sources", () => {
  const t = dayIndex(D0), done = new Set([t - 6, t - 5, t - 4, t - 3, t - 2, t - 1, t]);
  const st = streakOf(done, D0, { todayCounts: true, todayOk: true });
  assert.equal(st.current, 7);
  const pays = streakPays("flight", st);
  assert.equal(pays.filter((p) => p.src.startsWith("streak:flight:mark:")).length, 1);
  assert.match(pays[pays.length - 1].label, /^Flight streak: 7 days$/);
});

test("season track: 700 XP a tier, crate XP and spends don't count, crates every 5 tiers", () => {
  const rows = [{ kind: "mission", xp: 3000, ts: 10 }, { kind: "crate", xp: 5000, ts: 10 }, { kind: "buy", xp: -400, ts: 10 }, { kind: "streak", xp: 600, ts: 99 }];
  assert.equal(seasonXp(rows, 0, 50), 3000);
  const t = trackOf(3600);
  assert.equal(t.tier, 5); assert.equal(t.into, 100); assert.equal(t.need, TRACK.xpPerTier);
  assert.deepEqual(t.earned, [{ tier: 5, crate: "uncommon" }]);
  assert.deepEqual(t.next, { tier: 10, crate: "rare" });
  const top = trackOf(10 ** 7);
  assert.equal(top.tier, 30); assert.equal(top.need, 0); assert.equal(top.next, null); assert.equal(top.earned.length, 6);
});

test("passedBy: who passed whom between two board snapshots", () => {
  assert.equal(passedBy([], ["x", "y"]).size, 0, "first snapshot passes nobody");
  // c climbs from 3rd to 1st: a and b were both passed by c
  const m = passedBy(["a", "b", "c"], ["c", "a", "b"]);
  assert.deepEqual(m.get("a"), { by: "c", rank: 2 });
  assert.deepEqual(m.get("b"), { by: "c", rank: 3 });
  assert.equal(m.has("c"), false);
  // a newcomer lands at #1
  assert.deepEqual(passedBy(["a", "b"], ["n", "a", "b"]).get("a"), { by: "n", rank: 2 });
  // b drops off the board after a slide: not on the next snapshot, no push
  assert.equal(passedBy(["a", "b"], ["c", "a"]).has("b"), false);
  // nothing moved
  assert.equal(passedBy(["a", "b"], ["a", "b"]).size, 0);
});

test("new push switches: rivals and daily flight are on by default", () => {
  const p = readPrefs({});
  assert.equal(p.rival, true); assert.equal(p.daily, true);
  assert.ok(PUSH_KINDS.some((k) => k.k === "rival") && PUSH_KINDS.some((k) => k.k === "daily"));
});

test("claimDrop: pays day 1 once, checks in, and climbs the next day", async () => {
  const s = kv();
  const r1 = await S.claimDrop(a, D0, s);
  assert.deepEqual({ day: r1.day, xp: r1.xp, paid: r1.paid }, { day: 1, xp: 10, paid: true });
  const again = await S.claimDrop(a, D0 + 60_000, s);
  assert.equal(again.paid, false, "once a day");
  const r2 = await S.claimDrop(a, D0 + DAY, s);
  assert.deepEqual({ day: r2.day, xp: r2.xp, paid: r2.paid }, { day: 2, xp: 15, paid: true });
  const drops = (await ledgerOf(a, s)).filter((x) => x.src.startsWith("drop:"));
  assert.equal(drops.reduce((t, x) => t + x.xp, 0), 25);
});

test("claimDrop: day 7 grants one bound crate, once", async () => {
  const s = kv();
  for (let i = 0; i < 6; i++) await S.claimDrop(b, D0 + i * DAY, s);
  const r7 = await S.claimDrop(b, D0 + 6 * DAY, s);
  assert.deepEqual({ day: r7.day, crate: r7.crate, paid: r7.paid }, { day: 7, crate: true, paid: true });
  assert.equal((await S.claimDrop(b, D0 + 6 * DAY + 1000, s)).paid, false);
  const crates = (await s.zrange(crateKey(b), 50)).map((m) => JSON.parse(m));
  assert.equal(crates.filter((c) => c.src === `drop:${dayIndex(D0 + 6 * DAY)}`).length, 1);
});

test("recordPlay: only known modes and wallets", async () => {
  const s = kv();
  assert.equal(await S.recordPlay(a, "duel", D0, s), true);
  assert.equal(await S.recordPlay(a, "hack", D0, s), false);
  assert.equal(await S.recordPlay("g_guest", "duel", D0, s), false);
});

test("seasonTrackFor: season XP fills tiers and drops each tier crate once", async () => {
  const s = kv(), now = rankSeasonAt(Date.now()).startsAt + DAY;
  const w = "0x" + "c".repeat(40);
  await X.award(w, { src: "test:big", kind: "mission", xp: 7_100, label: "test", ts: now }, s);
  const t = await S.seasonTrackFor(w, now, s);
  assert.equal(t.tier, 10);
  const key = crateKey(w);
  const n1 = (await s.zrange(key, 50)).length;
  assert.equal(n1, 2, "tier 5 and tier 10 crates");
  await S.seasonTrackFor(w, now + 1000, s);
  assert.equal((await s.zrange(key, 50)).length, 2, "not granted twice");
});
