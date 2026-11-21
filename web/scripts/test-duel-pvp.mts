// PvP groundwork: hidden matchmaking rating, repeat-opponent cap, ranked rematch cap, friends and rivals.
//   pnpm test:duel-pvp   (local KV file in /tmp, injected price, no network)
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.KV_REST_API_URL;
process.env.KV_LOCAL_FILE = join(tmpdir(), `duel-pvp-test-${process.pid}.json`);
const R = await import("../lib/duel/rules");
const SOC = await import("../lib/duel/social");
const S = await import("../lib/server/duel/store");
const SS = await import("../lib/server/duel/social");
const { kv } = await import("../lib/server/kv");
const { setDuelPriceSource, setDuelCandleSource } = await import("../lib/server/duel/price");
setDuelPriceSource(async () => 68000);
setDuelCandleSource(async () => null);

const P = (hex: string, name: string) => ({ pid: "0x" + hex.repeat(40 / hex.length), name: "@" + name });

/** Ready both, push the clock past the buzzer, give `winner` $5 more, settle. */
async function finish(id: string, winner: string | null) {
  const r0 = (await S.getRoom(id))!;
  for (const p of r0.players) await S.setReady(id, p.pid);
  const r = JSON.parse(JSON.stringify(await S.getRoom(id)));
  r.startAt = Date.now() - 200_000; r.endAt = Date.now() - 5; r.ot = true; r.mark = { p: 68000, at: Date.now() - 50 };
  if (winner) r.books[winner].fuel += 5;
  await kv().set(S._keys.room(id), JSON.stringify(r));
  const end = await S.tick(id, 68000);
  assert.equal(end!.room.status, "done");
  return end!.room;
}
const backdate = async (pid: string, ms: number) => kv().set(S._keys.qsince(pid), String(Date.now() - ms));

test("rules: pairOk lets repeat opponents through only after both waited", () => {
  assert.ok(R.pairOk(0, 0, 0)); assert.ok(R.pairOk(R.PAIR_CAP - 1, 0, 0));
  assert.ok(!R.pairOk(R.PAIR_CAP, 0, 0)); assert.ok(!R.pairOk(R.PAIR_CAP, R.REPEAT_OK_MS, 0));
  assert.ok(R.pairOk(R.PAIR_CAP, R.REPEAT_OK_MS, R.REPEAT_OK_MS));
  const seed = R.mmrSeed({ ...R.newRating(), r: 1400, games: 12, w: 9, l: 3 });
  assert.equal(seed.r, 1400); assert.equal(seed.games, 12); assert.equal(seed.w, 0);
});

test("unranked queue duels move the hidden matchmaking rating, never the shown rating", async () => {
  const a = P("1", "one"), b = P("2", "two");
  await S.pollQueue(a, "pro", 60_000, undefined, true);
  const m = (await S.pollQueue(b, "pro", 60_000, undefined, true)) as { room: { id: string } };
  assert.ok(m.room);
  await finish(m.room.id, a.pid);
  const [ma, mb, ra] = [await S.mmrOf(a.pid), await S.mmrOf(b.pid), await S.ratingOf(a.pid)];
  assert.ok(ma.r > 1200 && mb.r < 1200, `mmr ${ma.r} / ${mb.r}`);
  assert.equal(ra.r, 1200); assert.equal(ra.w, 1);
  assert.equal(await S.pairGames(a.pid, b.pid), 1);
});

test("the queue pairs on matchmaking rating: a far-apart pair waits, a close pair matches", async () => {
  const hi = P("3", "three"), lo = P("4", "four"), mid = P("5", "five");
  await kv().set(S._keys.mmr(hi.pid), JSON.stringify({ ...R.newRating(), r: 1700, s: 1 }));
  await kv().set(S._keys.mmr(mid.pid), JSON.stringify({ ...R.newRating(), r: 1680, s: 1 }));
  assert.ok("waitedMs" in (await S.pollQueue(hi, "shark", 60_000, undefined, true)));
  assert.ok("waitedMs" in (await S.pollQueue(lo, "shark", 60_000, undefined, true)), "1,200 vs 1,700 at once: no pair");
  const m = (await S.pollQueue(mid, "shark", 60_000, undefined, true)) as { room: { players: { pid: string }[] } };
  assert.ok(m.room, "1,680 finds 1,700");
  assert.deepEqual(m.room.players.map((p) => p.pid).sort(), [hi.pid, mid.pid].sort());
  await S.leaveQueue(lo.pid, "shark", 60_000, undefined, true);
  for (const p of m.room.players) await kv().del(S._keys.active(p.pid));
});

test("repeat opponents: past the cap they only pair after both waited", async () => {
  const a = P("6", "six"), b = P("7", "seven");
  await kv().set(S._keys.pair(a.pid, b.pid), String(R.PAIR_CAP));
  await S.pollQueue(a, "rookie", 60_000, undefined, true);
  assert.ok("waitedMs" in (await S.pollQueue(b, "rookie", 60_000, undefined, true)), "capped pair, fresh queue: no pair");
  await backdate(a.pid, R.REPEAT_OK_MS + 1000); await backdate(b.pid, R.REPEAT_OK_MS + 1000);
  const m = (await S.pollQueue(b, "rookie", 60_000, undefined, true)) as { room?: { id: string } };
  assert.ok(m.room, "after both waited, they pair");
  await S.setReady(m.room!.id, a.pid); // tidy: cancel
  await S.leave(m.room!.id, a.pid);
});

test("a ranked rematch past the pair cap is unranked", async () => {
  const a = P("8", "eight"), b = P("9", "nine");
  await S.pollQueue(a, "pro", 60_000);
  const m = (await S.pollQueue(b, "pro", 60_000)) as { room: { id: string; mode: string } };
  assert.equal(m.room.mode, "ranked");
  await finish(m.room.id, b.pid);
  await S.rematch(m.room.id, a.pid);
  const first = await S.rematch(m.room.id, b.pid);
  assert.equal(first.next!.mode, "ranked", "under the cap: still ranked");
  await finish(first.next!.id, a.pid);
  await kv().set(S._keys.pair(a.pid, b.pid), String(R.PAIR_CAP));
  await S.rematch(first.next!.id, a.pid);
  const capped = await S.rematch(first.next!.id, b.pid);
  assert.equal(capped.next!.mode, "casual");
  await S.leave(capped.next!.id, a.pid);
});

test("rivals: grouped by opponent, most games first, guests left out, one nemesis", () => {
  const me = "0x" + "a".repeat(40), x = "0x" + "b".repeat(40), y = "0x" + "c".repeat(40);
  const h = (at: number, result: "win" | "loss" | "draw", pid: string, name: string) => ({ at, result, opp: { pid, name } });
  const rows = SOC.rivalsFrom([
    h(5, "loss", x, "@bee"), h(4, "loss", x, "@bee_old"), h(3, "win", x, "@bee_old"),
    h(6, "win", y, "@cee"), h(7, "draw", "guest-123", "guest"), h(8, "win", me, "@me"),
  ], me);
  assert.deepEqual(rows.map((r) => r.pid), [x, y]);
  assert.deepEqual(rows[0].h2h, { w: 1, l: 2, d: 0 }); assert.equal(rows[0].name, "@bee"); assert.equal(rows[0].last, 5);
  assert.ok(rows[0].nemesis); assert.ok(!rows[1].nemesis);
  assert.equal(SOC.slugOf(x, "@Bee"), "bee"); assert.equal(SOC.slugOf(x, "@pilot-bbbb"), x); assert.equal(SOC.slugOf(x, null), x);
});

test("friends: add, list with live status (JOIN when they're in an open room), remove", async () => {
  const me = P("d", "dee"), f = P("e", "eee");
  assert.deepEqual(await SS.addFriend(me.pid, f.pid), { added: true });
  assert.deepEqual(await SS.addFriend(me.pid, f.pid), { added: false });
  await assert.rejects(SS.addFriend(me.pid, me.pid));
  let soc = await SS.socialOf(me.pid);
  assert.equal(soc.friends.length, 1); assert.equal(soc.friends[0].status, null); assert.equal(soc.friends[0].slug, f.pid);
  const room = await S.createInvite(f, "pro", 60_000);
  soc = await SS.socialOf(me.pid);
  assert.equal(soc.friends[0].status, "open"); assert.equal(soc.friends[0].code, room.code);
  await S.leave(room.id, f.pid);
  await SS.removeFriend(me.pid, f.pid);
  assert.equal((await SS.socialOf(me.pid)).friends.length, 0);
});

test("rivals list comes from finished online duels, with head to head and the friend flag", async () => {
  const me = P("f", "eff"), o = P("0a", "ohh");
  await S.pollQueue(me, "pro", 60_000, undefined, true);
  const m = (await S.pollQueue(o, "pro", 60_000, undefined, true)) as { room: { id: string } };
  await finish(m.room.id, o.pid);
  await SS.addFriend(me.pid, o.pid);
  const soc = await SS.socialOf(me.pid);
  assert.equal(soc.rivals.length, 1);
  assert.deepEqual(soc.rivals[0].h2h, { w: 0, l: 1, d: 0 }); assert.equal(soc.rivals[0].friend, true);
  assert.deepEqual(soc.friends[0].h2h, { w: 0, l: 1, d: 0 });
});
