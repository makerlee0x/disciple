// Trading Duel: rules (fills, flips, NUKE, overtime, ratings, codes) and the server (queue pairing, invites,
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
const SEASON = await import("../lib/duel/season");
const { setDuelPriceSource, setDuelCandleSource } = await import("../lib/server/duel/price");
type Candle = { t: number; T: number; o: number; c: number; h: number; l: number };
let TAPE: Candle[] | null = null;
setDuelCandleSource(async () => TAPE);
const pilot = (ch: string) => ({ pid: "0x" + ch.repeat(40), name: "@" + ch });

let PRICE = 68000;
setDuelPriceSource(async () => PRICE);
const A = { pid: "0x" + "a".repeat(40), name: "@alice" }, B = { pid: "0x" + "b".repeat(40), name: "@bob" };
const near = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≈ ${b}`);

test("rules: boost, add averages the entry, no flips (cash out first), close books fees", () => {
  let b = R.newBook(20);
  let o = R.applyTrade(b, "boost", 5, 68000, 0)!; b = o.book;
  near(b.fuel, 20 - 5 - 5 * R.LEV * R.FEE); assert.equal(b.pos!.side, 1); assert.equal(b.pos!.coll, 5);
  o = R.applyTrade(b, "boost", 5, 68010, 1)!; b = o.book;
  assert.equal(b.pos!.coll, 10); assert.ok(b.pos!.entry > 68000 && b.pos!.entry < 68010);
  assert.equal(R.applyTrade(b, "dump", 2, 68020, 2), null);          // no flips: the other side waits for a cash out
  o = R.applyTrade(b, "close", 0, 68020, 3)!; b = o.book;
  assert.equal(b.pos, null); assert.equal(b.trades, 3);
  o = R.applyTrade(b, "dump", 2.5, 68020, 4)!; b = o.book;          // then the other side, any whole-cent size
  assert.equal(b.pos!.side, -1); assert.equal(b.pos!.coll, 2.5);
  o = R.applyTrade(b, "close", 0, 68020, 5)!; b = o.book;
  assert.equal(R.applyTrade(b, "close", 0, 68020, 4), null);         // nothing open
});
test("rules: % trade sizes and the stakes the server takes", () => {
  assert.deepEqual([...R.PCTS], [10, 25, 50, 0]);
  assert.equal(R.pctUsd(25, 50), 12.5); assert.equal(R.pctUsd(10, 18.17), 1.81); assert.equal(R.pctUsd(0, 7.3), 7.3);
  for (const ok of [0, 1, 2.5, 12.34, 500, 20000, 250000]) assert.ok(R.okStake(ok), `${ok}`);
  for (const bad of [0.5, -1, 1.234, NaN, Infinity]) assert.ok(!R.okStake(bad), `${bad}`);
});
test("rules: ALL uses everything, NUKE at 80% of the fuel in it", () => {
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
  await assert.rejects(S.trade(room.id, A.pid, "boost", 0.5, PRICE), /trade size/);
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
  await S.pollQueue(a, "shark", 60_000); const m = await S.pollQueue(b, "shark", 60_000) as { room: { id: string } };
  await S.setReady(m.room.id, a.pid); await S.setReady(m.room.id, b.pid);
  const { kv } = await import("../lib/server/kv");
  const r = JSON.parse(JSON.stringify(await S.getRoom(m.room.id))); r.startAt = Date.now() - 200_000; r.endAt = Date.now() - 5; r.mark = { p: 68000, at: Date.now() - 50 }; await kv().set(S._keys.room(m.room.id), JSON.stringify(r));
  const ot = await S.tick(m.room.id, 68000); assert.equal(ot!.room.ot, true); assert.equal(ot!.room.status, "live");
  const r2 = JSON.parse(JSON.stringify(ot!.room)); r2.endAt = Date.now() - 5; r2.mark = { p: 68000, at: Date.now() - 50 }; await kv().set(S._keys.room(m.room.id), JSON.stringify(r2));
  const end = await S.tick(m.room.id, 68000); assert.equal(end!.room.status, "done"); assert.equal(end!.room.result!.winner, null);
  assert.equal((await S.ratingOf(a.pid)).games, 1);
});

test("server: ranked results land on the duel board (rating order, names, my row)", async () => {
  const c = "0x" + "c".repeat(40), d = "0x" + "d".repeat(40);
  if (!SEASON.DUEL_RANKED_LIVE) {
    // ranked = real money only (maker 2026-11-17): a play-money queue duel keeps the record + streak but no rating or board row
    const rc = await S.ratingOf(c), rd = await S.ratingOf(d);
    assert.equal(rc.games, 1); assert.equal(rd.games, 1);
    assert.equal(rc.r, 1200); assert.equal(rd.r, 1200);
    assert.equal(rc.w + rc.l + rd.w + rd.l <= 2, true);
    assert.equal((await S.duelBoard(50, c)).total, 0);
    return;
  }
  const b = await S.duelBoard(50, c);
  assert.ok(b.rows.some((r) => r.wallet === c && r.name === "@c" && r.games === 1));
  assert.ok(b.rows.some((r) => r.wallet === d));
  assert.equal(b.me?.wallet, c); assert.equal(b.total, b.rows.length);
  for (let i = 1; i < b.rows.length; i++) assert.ok(b.rows[i - 1].rating >= b.rows[i].rating);
  assert.equal((await S.duelBoard(50, "0x" + "9".repeat(40))).me, null, "no row for someone who never played ranked");
});

test("server: report saves once per duel with the chat, only from a seated pilot", async () => {
  const a = pilot("7"), b = pilot("8");
  const room = await S.createInvite(a, "rookie", 60_000); await S.joinInvite(b, room.code!);
  await S.chat(room.id, b.pid, "you suck");
  const r1 = await S.reportDuel(room.id, a.pid); assert.equal(r1.already, false);
  const r2 = await S.reportDuel(room.id, a.pid); assert.equal(r2.already, true);
  await assert.rejects(S.reportDuel(room.id, pilot("6").pid), /not in this duel/);
  const { kv } = await import("../lib/server/kv");
  const saved = (await kv().zrange(S._keys.reports(), 10, true)).map((m) => JSON.parse(m));
  const mine = saved.find((x) => x.room === room.id)!;
  assert.equal(mine.who, b.pid); assert.equal(mine.chat[0].text, "you suck");
  await S.leave(room.id, a.pid).catch(() => {});
});

test("server: one duel at a time (no second ranked room, invite or join while seated)", async () => {
  const a = pilot("1"), b = pilot("2"), c = pilot("3");
  await S.pollQueue(a, "rookie", 60_000); const m = await S.pollQueue(b, "rookie", 60_000) as { room: { id: string } };
  assert.ok(m.room);
  // a is seated: queueing again (any tier) hands back the same room, never a new one
  const again = await S.pollQueue(a, "pro", 60_000) as { room?: { id: string } };
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

test("server: an NUKE inside a gap nobody watched still lands", async () => {
  const { a, id } = await liveRanked("6", "7");
  const now = Date.now(), T0 = Math.floor((now - 3 * 60_000) / 60_000) * 60_000;
  const book = R.applyTrade(R.newBook(50), "boost", 0, 68000, 0)!.book;
  const lp = R.liqPrice(book.pos!);
  await patch(id, (r) => {
    r.startAt = T0 - 120_000; r.endAt = now + 60_000; r.mark = { p: 68000, at: now - 500 };
    r.gap = { from: T0 - 1000, to: T0 + 60_500 }; r.lastTradeAt = { [a.pid]: T0 - 90_000 }; (r.books as Record<string, unknown>)[a.pid] = book;
  });
  TAPE = [
    { t: T0 - 60_000, T: T0 - 1, o: 68000, c: 68000, h: 68005, l: 67995 },
    { t: T0, T: T0 + 59_999, o: 68000, c: 68000, h: 68005, l: lp - 5 },
    { t: T0 + 60_000, T: T0 + 119_999, o: 68000, c: 68000, h: 68005, l: 67995 },
  ];
  const t = await S.tick(id, 68000); // price is back where it was
  assert.ok(t!.events.some((e) => e.type === "bomb" && e.pid === a.pid), "the dip below the NUKE line counts");
  assert.equal(t!.room.books[a.pid].pos, null);
  TAPE = null;
});

test("server: the tape never invents a bomb from before the entry, and never prices the buzzer from an open minute", async () => {
  const { a, id } = await liveRanked("8", "9");
  const now = Date.now(), T0 = Math.floor((now - 3 * 60_000) / 60_000) * 60_000;
  const book = R.applyTrade(R.newBook(50), "boost", 0, 68000, 0)!.book;
  const lp = R.liqPrice(book.pos!);
  // entered 30 s into minute T0-60s; that minute's low (maybe before the entry) is under the line
  await patch(id, (r) => {
    r.startAt = T0 - 120_000; r.endAt = now + 60_000; r.mark = { p: 68000, at: now - 500 };
    r.gap = { from: T0 - 20_000, to: T0 + 60_500 }; r.lastTradeAt = { [a.pid]: T0 - 30_000 }; (r.books as Record<string, unknown>)[a.pid] = book;
  });
  TAPE = [
    { t: T0 - 60_000, T: T0 - 1, o: 68000, c: 68000, h: 68005, l: lp - 50 },
    { t: T0, T: T0 + 59_999, o: 68000, c: 68000, h: 68005, l: 67995 },
    { t: T0 + 60_000, T: T0 + 119_999, o: 68000, c: 68000, h: 68005, l: 67995 },
  ];
  const t = await S.tick(id, 68000);
  assert.ok(!t!.events.some((e) => e.type === "bomb"), "a low from before the entry can't liquidate");
  assert.ok(t!.room.books[a.pid].pos, "still flying"); assert.equal(t!.room.gap, undefined);
  // buzzer passed with nobody ticking near it: hold, don't read the still-open minute
  await patch(id, (r) => { r.endAt = Date.now() - 1500; r.mark = { p: 68000, at: Date.now() - 20_000 }; });
  const M = Math.floor(Date.now() / 60_000) * 60_000;
  TAPE = [{ t: M, T: M + 59_999, o: 68000, c: 69000, h: 69000, l: 68000 }];
  const w = await S.tick(id, 69000);
  assert.equal(w!.room.status, "live", "wait for the tape");
  TAPE = null;
});

test("server: a live tick after a gap can't skip its replay (trading pauses, the dip still lands once the minute closes)", async () => {
  const { a, b, id } = await liveRanked("a", "b");
  const now = Date.now(), M = Math.floor(now / 60_000) * 60_000;
  const book = R.applyTrade(R.newBook(50), "boost", 0, 68000, 0)!.book;
  const lp = R.liqPrice(book.pos!);
  // a traded well before; ticks stopped 10 s ago inside the current minute, BTC dipped through the line and came back
  await patch(id, (r) => { r.startAt = M - 120_000; r.endAt = now + 120_000; r.mark = { p: 68000, at: now - 10_000 }; r.lastTradeAt = { [a.pid]: M - 90_000 }; (r.books as Record<string, unknown>)[a.pid] = book; });
  TAPE = null;
  const t1 = await S.tick(id, 68000); // recovery tick: minute still open
  assert.ok(t1!.room.gap, "the gap is pending");
  assert.ok(t1!.room.books[a.pid].pos, "not judged yet");
  const t2 = await S.tick(id, 68000); // another live tick right after: the gap must survive it
  assert.ok(t2!.room.gap, "a later live tick doesn't cancel the replay");
  await assert.rejects(S.trade(id, a.pid, "close", 0, 68000), /Catching up/);
  // the minute closes: its low was under the line
  await patch(id, (r) => { (r.gap as { from: number; to: number }).from = M - 60_000 + 30_000; (r.gap as { from: number; to: number }).to = M - 60_000 + 50_000; r.mark = { p: 68000, at: Date.now() }; });
  TAPE = [{ t: M - 60_000, T: M - 1, o: 68000, c: 68000, h: 68005, l: lp - 5 }];
  const t3 = await S.tick(id, 68000);
  assert.ok(t3!.events.some((e) => e.type === "bomb" && e.pid === a.pid), "the dip lands");
  assert.equal(t3!.room.gap, undefined);
  void b; TAPE = null;
});

test("server: the referee settles a duel nobody is watching", async () => {
  const { id } = await liveRanked("c", "d");
  await patch(id, (r) => { r.startAt = Date.now() - 61_000; r.endAt = Date.now() + 1200; r.ot = true; r.mark = { p: 68000, at: Date.now() - 500 }; });
  await S.referee(id, async () => 68000, undefined, 6000);
  const r = await S.getRoom(id); assert.equal(r!.status, "done");
});

test("custom budgets: sizes scale on 1-2-5 steps; friend room books start at the budget; trade sizes follow it", async () => {
  assert.deepEqual(R.sizesFor(5), [1, 2, 3, 4, 0]);
  assert.deepEqual(R.sizesFor(12), [1, 2, 3, 6, 0]);
  assert.deepEqual(R.sizesFor(20), [1, 2, 5, 10, 0]);
  assert.deepEqual(R.sizesFor(100), [5, 10, 20, 50, 0]);
  assert.deepEqual(R.sizesFor(1000), [50, 100, 200, 500, 0]);
  assert.deepEqual(R.sizesFor(10_000), [500, 1000, 2000, 5000, 0]);
  assert.ok(!R.isCustomFuel(4) && R.isCustomFuel(5) && R.isCustomFuel(10_001) && R.isCustomFuel(250_000) && !R.isCustomFuel(99.5) && R.isCustomFuel(250));
  const a = pilot("c"), b = pilot("d");
  const room = await S.createInvite(a, "pro", 60_000, undefined, 1000);
  assert.equal(room.fuel, 1000); assert.equal(room.books[a.pid].fuel, 1000);
  const j = await S.joinInvite(b, room.code!); assert.equal(j.books[b.pid].fuel, 1000);
  await S.setReady(room.id, a.pid); await S.setReady(room.id, b.pid);
  await patch(room.id, (r) => { r.startAt = Date.now() - 1000; r.endAt = Date.now() + 60_000; });
  PRICE = 68000;
  await S.trade(room.id, a.pid, "boost", 200, PRICE);
  await assert.rejects(S.trade(room.id, b.pid, "boost", 1.234, PRICE), /trade size/);   // whole cents only
  // a bad budget never sticks: the room falls back to the tier
  await S.leave(room.id, a.pid); await S.leave(room.id, b.pid);
  const c = pilot("5"); const odd = await S.createInvite(c, "rookie", 60_000, undefined, 4);
  assert.equal(odd.fuel, undefined); assert.equal(odd.books[c.pid].fuel, 20);
});

test("custom budgets: a $5 duel trades in whole dollars ($1 / $2 / $3 / $4)", async () => {
  const a = pilot("0"), b = { pid: "0x" + "01".repeat(20), name: "@zero1" };
  const room = await S.createInvite(a, "rookie", 60_000, undefined, 5);
  assert.equal(room.books[a.pid].fuel, 5);
  await S.joinInvite(b, room.code!); await S.setReady(room.id, a.pid); await S.setReady(room.id, b.pid);
  await patch(room.id, (r) => { r.startAt = Date.now() - 1000; r.endAt = Date.now() + 60_000; });
  PRICE = 68000;
  await S.trade(room.id, a.pid, "boost", 4, PRICE);
  await S.trade(room.id, b.pid, "dump", 1, PRICE);
  await assert.rejects(S.trade(room.id, b.pid, "dump", 0.5, PRICE), /trade size/);
  await assert.rejects(S.trade(room.id, b.pid, "boost", 1, PRICE), /Cash out first/);   // no flips
});

test("guest pilots (/duel demo page): signed cookie, forged or wrong ids refused", async () => {
  const G = await import("../lib/server/duelGuest");
  const id = G.newGuestId(); assert.ok(G.isGuestPid(id)); assert.ok(!G.isGuestPid("0x" + "a".repeat(40)));
  const tok = await G.guestToken(id);
  assert.equal(await G.guestOf(tok), id);
  assert.equal(await G.guestOf(tok.slice(0, -1) + (tok.endsWith("0") ? "1" : "0")), null);   // forged signature
  assert.equal(await G.guestOf(`${G.newGuestId()}.${tok.split(".")[1]}`), null);           // someone else's signature
  assert.equal(await G.guestOf(undefined), null);
  const req = new Request("http://x/", { headers: { cookie: `a=1; ${G.DUEL_GUEST_COOKIE}=${encodeURIComponent(tok)}` } });
  assert.equal(await G.guestFromReq(req), id); assert.ok(G.guestName(id).startsWith("@guest-"));
  // a guest can sit in a friend duel against a signed-in pilot
  const room = await S.createInvite({ pid: id, name: G.guestName(id) }, "rookie", 60_000);
  const j = await S.joinInvite({ pid: G.newGuestId(), name: "@friend" }, room.code!); assert.equal(j.players.length, 2);
});

test("server: unranked (casual) queue pairs separately and never moves rating or season points", async () => {
  const a = { pid: "0x" + "4".repeat(40), name: "@four" }, b = { pid: "0x" + "4b".repeat(20), name: "@fourb" };
  const before = await S.ratingOf(a.pid);
  // a ranked searcher and a casual searcher never pair
  await S.pollQueue(a, "pro", 60_000);
  const x = await S.pollQueue(b, "pro", 60_000, undefined, true); assert.ok("waitedMs" in x);
  await S.leaveQueue(a.pid, "pro", 60_000);
  const m = await S.pollQueue(a, "pro", 60_000, undefined, true) as { room: { id: string; mode: string } };
  assert.equal(m.room.mode, "casual");
  await S.setReady(m.room.id, a.pid); await S.setReady(m.room.id, b.pid);
  const { kv } = await import("../lib/server/kv");
  const r = JSON.parse(JSON.stringify(await S.getRoom(m.room.id))); r.startAt = Date.now() - 200_000; r.endAt = Date.now() - 5; r.ot = true; r.mark = { p: 68000, at: Date.now() - 50 }; await kv().set(S._keys.room(m.room.id), JSON.stringify(r));
  const end = await S.tick(m.room.id, 68000); assert.equal(end!.room.status, "done");
  const ra = await S.ratingOf(a.pid);
  assert.equal(ra.games, before.games + 1); assert.equal(ra.r, before.r);
  assert.equal(end!.room.result!.season, undefined);
  assert.equal(end!.room.result!.delta[a.pid], 0);
});
