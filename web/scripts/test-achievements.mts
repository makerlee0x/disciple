// Real-data achievements (GAME): client + view merge + toast feed.   pnpm test:achievements
import test from "node:test";
import assert from "node:assert/strict";
import {
  V1_ACHIEVEMENT_IDS, fetchAchievements, parseAchievementsBody, parseFeedBody, realAchievementViews, unlockFromRow, watchUnlocks,
} from "../lib/game/achievementsClient.ts";

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
