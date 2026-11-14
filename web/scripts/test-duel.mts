// Trading Duel: rules (fills, flips, H-BOMB, overtime, ratings, codes) and the server (queue pairing, invites,
// ready → live, server-price fills, buzzer settle + ratings once, rematch).
//   pnpm test:duel   (local KV file in /tmp, injected price, no network)
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.KV_REST_API_URL;
process.env.KV_LOCAL_FILE = join(tmpdir(), `duel-test-${process.pid}.json`);
const R = await import("../lib/duel/rules");
const S = await import("../lib/server/duel/store");
const { setDuelPriceSource, setDuelCandleSource } = await import("../lib/server/duel/price");
type Candle = { t: number; T: number; o: number; c: number; h: number; l: number };
let TAPE: Candle[] | null = null;
setDuelCandleSource(async () => TAPE);
const pilot = (ch: string) => ({ pid: "0x" + ch.repeat(40), name: "@" + ch });

let PRICE = 68000;
setDuelPriceSource(async () => PRICE);
const A = { pid: "0x" + "a".repeat(40), name: "@alice" }, B = { pid: "0x" + "b".repeat(40), name: "@bob" };
const near = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≈ ${b}`);

test("rules: boost, add averages the entry, flip keeps the fuel, close books fees", () => {
  let b = R.newBook(20);
  let o = R.applyTrade(b, "boost", 5, 68000, 0)!; b = o.book;
  near(b.fuel, 20 - 5 - 5 * R.LEV * R.FEE); assert.equal(b.pos!.side, 1); assert.equal(b.pos!.coll, 5);
  o = R.applyTrade(b, "boost", 5, 68010, 1)!; b = o.book;
  assert.equal(b.pos!.coll, 10); assert.ok(b.pos!.entry > 68000 && b.pos!.entry < 68010);
  o = R.applyTrade(b, "dump", 2, 68020, 2)!; b = o.book;            // flip: same $10, other side
  assert.deepEqual(o.steps.map((s) => s.kind), ["close", "open"]); assert.equal(b.pos!.side, -1); assert.equal(b.pos!.coll, 10);
  o = R.applyTrade(b, "close", 0, 68020, 3)!; b = o.book;
  assert.equal(b.pos, null); assert.equal(b.trades, 5);
  assert.equal(R.applyTrade(b, "close", 0, 68020, 4), null);         // nothing open
});
test("rules: ALL uses everything, H-BOMB at 80% of the fuel in it", () => {
  let b = R.applyTrade(R.newBook(20), "boost", 0, 68000, 0)!.book;
  assert.ok(b.fuel < 0.01);
  const lp = R.liqPrice(b.pos!); assert.ok(lp < 68000);
  assert.equal(R.bombAt(b, lp + 1), null);
  const bomb = R.bombAt(b, lp - 0.1)!; assert.equal(bomb.book.pos, null); assert.equal(bomb.book.bombs, 1);
  b = R.settleBook(b, 68000); assert.equal(b.pos, null);
});
test("rules: overtime only when close and only once; Elo moves both ways; codes parse", () => {
  assert.equal(R.needsOvertime(0.1, 20, false), true); assert.equal(R.needsOvertime(0.1, 20, true), false); assert.equal(R.needsOvertime(1, 20, false), false);
  assert.equal(R.needsOvertime(0.6, 50, false), true);
  const r = R.rate(R.newRating(), R.newRating(), 1); assert.equal(r.da, 24); assert.equal(r.db, -24); assert.equal(r.a.w, 1); assert.equal(r.b.l, 1);
  assert.equal(R.parseCode("duel-7k2q"), "7K2Q"); assert.equal(R.parseCode("https://disciple.vip/duel/7K2Q"), "7K2Q"); assert.equal(R.parseCode("7K2"), null); assert.equal(R.parseCode("OOOO"), null);
  assert.equal(R.matchWindow(0), 50); assert.equal(R.matchWindow(10_000), 200); assert.equal(R.matchWindow(1e9), 400);
});

test("server: two pilots in the queue get paired, then ready → live", async () => {
  const w = await S.pollQueue(A, "pro", 60_000); assert.ok("waitedMs" in w);
  const m = await S.pollQueue(B, "pro", 60_000); assert.ok("room" in m);
  const again = await S.pollQueue(A, "pro", 60_000); assert.ok("room" in again && again.room.id === (m as { room: { id: string } }).room.id);
  const id = (m as { room: { id: string } }).room.id;
  await S.setReady(id, A.pid);
  const { room, events } = await S.setReady(id, B.pid);
  assert.equal(room.status, "live"); assert.ok(events.some((e) => e.type === "start"));
  await assert.rejects(S.trade(id, A.pid, "boost", 10, PRICE), /Wait for GO/);
});

test("server: fills at the server price, buzzer settles once, ratings move, rematch makes a new room", async () => {
  const A = pilot("e"), B = pilot("f");
  const room = await S.createInvite(A, "rookie", 60_000);
  await assert.rejects(S.joinInvite(B, "ZZZZ"), /isn't open/);
  const joined = await S.joinInvite(B, room.code!); assert.equal(joined.players.length, 2);
  await S.setReady(room.id, A.pid); await S.setReady(room.id, B.pid);
  // jump the clock: trading open
  const raw = JSON.parse(JSON.stringify(await S.getRoom(room.id)));
  raw.startAt = Date.now() - 1000; raw.endAt = Date.now() + 60_000;
  const { kv } = await import("../lib/server/kv"); await kv().set(S._keys.room(room.id), JSON.stringify(raw));
  PRICE = 68000;
  const t1 = await S.trade(room.id, A.pid, "boost", 5, PRICE);
  const ev = t1.events.find((e) => e.type === "trade")!; assert.equal((ev as { price: number }).price, 68000);
  await S.trade(room.id, B.pid, "dump", 5, PRICE);
  await assert.rejects(S.trade(room.id, A.pid, "boost", 3, PRICE), /trade size/);
  PRICE = 68040; // A up, B down
  const ch = await S.chat(room.id, B.pid, "gg"); assert.equal(ch.events[0].type, "chat");
  await S.tick(room.id, PRICE); // the stream's tick marks 68040 just before the buzzer
  const r2 = JSON.parse(JSON.stringify(await S.getRoom(room.id))); r2.endAt = Date.now() - 10; await kv().set(S._keys.room(room.id), JSON.stringify(r2));
  const done = await S.tick(room.id, PRICE); assert.equal(done!.room.status, "done");
  const res = done!.room.result!; assert.equal(res.winner, A.pid); assert.ok(res.profit[A.pid] > 0 && res.profit[B.pid] < 0);
  assert.equal(res.delta[A.pid], 0, "friendly duels don't move rating");
  assert.equal(await S.tick(room.id, PRICE), null, "settles once");
  await S.rematch(room.id, A.pid); const rm = await S.rematch(room.id, B.pid);
  assert.ok(rm.next && rm.next.id !== room.id && rm.next.players.length === 2 && rm.next.status === "lobby");
});

test("server: ranked buzzer within the overtime gap adds 30 s once, then rates", async () => {
  const a = { pid: "0x" + "c".repeat(40), name: "@c" }, b = { pid: "0x" + "d".repeat(40), name: "@d" };
  await S.pollQueue(a, "shark", 180_000); const m = await S.pollQueue(b, "shark", 180_000) as { room: { id: string } };
  await S.setReady(m.room.id, a.pid); await S.setReady(m.room.id, b.pid);
  const { kv } = await import("../lib/server/kv");
  const r = JSON.parse(JSON.stringify(await S.getRoom(m.room.id))); r.startAt = Date.now() - 200_000; r.endAt = Date.now() - 5; await kv().set(S._keys.room(m.room.id), JSON.stringify(r));
  const ot = await S.tick(m.room.id, 68000); assert.equal(ot!.room.ot, true); assert.equal(ot!.room.status, "live");
  const r2 = JSON.parse(JSON.stringify(ot!.room)); r2.endAt = Date.now() - 5; await kv().set(S._keys.room(m.room.id), JSON.stringify(r2));
  const end = await S.tick(m.room.id, 68000); assert.equal(end!.room.status, "done"); assert.equal(end!.room.result!.winner, null);
  assert.equal((await S.ratingOf(a.pid)).games, 1);
});

test("server: one duel at a time (no second ranked room, invite or join while seated)", async () => {
  const a = pilot("1"), b = pilot("2"), c = pilot("3");
  await S.pollQueue(a, "rookie", 60_000); const m = await S.pollQueue(b, "rookie", 60_000) as { room: { id: string } };
  assert.ok(m.room);
  // a is seated: queueing again (any tier) hands back the same room, never a new one
  const again = await S.pollQueue(a, "pro", 180_000) as { room?: { id: string } };
  assert.equal(again.room?.id, m.room.id);
  await assert.rejects(S.createInvite(a, "pro", 60_000), /already in a duel/);
  const inv = await S.createInvite(c, "pro", 60_000);
  await assert.rejects(S.joinInvite(b, inv.code!), /already in a duel/);
  // after leaving the lobby the seat frees up
  await S.leave(m.room.id, a.pid); await S.leave(m.room.id, b.pid);
  const j = await S.joinInvite(a, inv.code!); assert.equal(j.players.length, 2);
});

async function liveRanked(x: string, y: string) {
  const a = pilot(x), b = pilot(y);
  await S.pollQueue(a, "pro", 60_000); const m = await S.pollQueue(b, "pro", 60_000) as { room: { id: string } };
  await S.setReady(m.room.id, a.pid); await S.setReady(m.room.id, b.pid);
  return { a, b, id: m.room.id };
}
async function patch(id: string, f: (r: Record<string, unknown>) => void) {
  const { kv } = await import("../lib/server/kv");
  const r = JSON.parse(JSON.stringify(await S.getRoom(id))); f(r); await kv().set(S._keys.room(id), JSON.stringify(r));
}

test("server: a late settle uses the price at the buzzer, never the price when someone comes back", async () => {
  const { a, b, id } = await liveRanked("4", "5");
  const now = Date.now(), T0 = Math.floor((now - 6 * 60_000) / 60_000) * 60_000;
  await patch(id, (r) => { r.startAt = T0 - 60_000; r.endAt = T0 + 30_000; r.mark = { p: 68000, at: T0 - 59_000 }; });
  PRICE = 68000;
  await patch(id, (r) => {
    const books = r.books as Record<string, unknown>;
    books[a.pid] = R.applyTrade(R.newBook(50), "boost", 10, 68000, 0)!.book;
    books[b.pid] = R.applyTrade(R.newBook(50), "dump", 10, 68000, 0)!.book;
  });
  // nobody watched; BTC drifts to 68100 by the buzzer, then rips to 70000 later
  TAPE = null;
  const wait = await S.tick(id, 70_000); assert.equal(wait!.room.status, "live", "no tape yet: wait, don't guess");
  TAPE = [
    { t: T0 - 60_000, T: T0 - 1, o: 68000, c: 68000, h: 68010, l: 67990 },
    { t: T0, T: T0 + 59_999, o: 68000, c: 68200, h: 68210, l: 67995 },
  ];
  const done = await S.tick(id, 70_000);
  assert.equal(done!.room.status, "done");
  near(done!.room.result!.price, 68100, 1e-6);
  assert.equal(done!.room.result!.winner, a.pid);
  TAPE = null;
});

test("server: an H-BOMB inside a gap nobody watched still lands", async () => {
  const { a, id } = await liveRanked("6", "7");
  const now = Date.now(), T0 = Math.floor((now - 2 * 60_000) / 60_000) * 60_000;
  const book = R.applyTrade(R.newBook(50), "boost", 0, 68000, 0)!.book;
  const lp = R.liqPrice(book.pos!);
  await patch(id, (r) => { r.startAt = T0 - 60_000; r.endAt = now + 60_000; r.mark = { p: 68000, at: T0 - 1000 }; (r.books as Record<string, unknown>)[a.pid] = book; });
  TAPE = [{ t: T0, T: T0 + 59_999, o: 68000, c: 68000, h: 68005, l: lp - 5 }];
  const t = await S.tick(id, 68000); // price is back where it was
  assert.ok(t!.events.some((e) => e.type === "bomb" && e.pid === a.pid), "the dip below the H-BOMB line counts");
  assert.equal(t!.room.books[a.pid].pos, null);
  TAPE = null;
});

test("server: the tape never invents a bomb from before the entry, and never prices the buzzer from an open minute", async () => {
  const { a, b, id } = await liveRanked("8", "9");
  const now = Date.now(), M = Math.floor(now / 60_000) * 60_000;
  const book = R.applyTrade(R.newBook(50), "boost", 0, 68000, 0)!.book;
  const lp = R.liqPrice(book.pos!);
  // entered 20 s into the previous minute; that minute's low (before the entry) is below the H-BOMB line
  const entry = M - 40_000;
  await patch(id, (r) => { r.startAt = M - 120_000; r.endAt = now + 60_000; r.mark = { p: 68000, at: entry }; (r.books as Record<string, unknown>)[a.pid] = book; });
  TAPE = [{ t: M - 60_000, T: M - 1, o: 68000, c: 68000, h: 68005, l: lp - 50 }];
  const t = await S.tick(id, 68000);
  assert.ok(!t!.events.some((e) => e.type === "bomb"), "a low from before the entry can't liquidate");
  assert.ok(t!.room.books[a.pid].pos, "still flying");
  // buzzer landed in the current (still open) minute and nobody ticked near it: wait, don't read the open candle
  await patch(id, (r) => { r.endAt = Date.now() - 1500; r.mark = { p: 68000, at: Date.now() - 20_000 }; });
  TAPE = [{ t: M, T: M + 59_999, o: 68000, c: 69000, h: 69000, l: 68000 }];
  const w = await S.tick(id, 69000);
  if (Date.now() - M < 60_000 + 2000) assert.equal(w!.room.status, "live", "open minute: wait");
  void b; TAPE = null;
});
