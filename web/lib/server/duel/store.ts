import "server-only";
/**
 * Trading Duel server: matchmaking queue, invite codes, rooms, the event log both screens follow, ratings.
 * Everything lives in the shared KV (lib/server/kv). A room is one JSON value changed only under its lock; every
 * change appends an event (zset scored by seq) that GET /api/duel/room/[id] and the SSE stream hand out.
 *
 * Trust: fills use the server's price (./price), never the client's. H-BOMBs and the buzzer are checked on every
 * request and on the stream's 1 s tick, so a pilot who closes their tab still gets settled.
 * Not yet: Nova orders. Until Nova's SDK lands, duel fuel is a duel-only book (lib/duel/rules) at live prices.
 */
import { kv, type Kv } from "@/lib/server/kv";
import { ulid } from "@/lib/chat/ulid";
import {
  COUNTDOWN_MS, OT_MS, TIERS, applyTrade, bombAt, makeCode, matchWindow, needsOvertime, newBook, newRating, profitOf, rate, settleBook,
  type LengthMs, type Rating, type TierId, type TradeAction,
} from "@/lib/duel/rules";
import { duelCandles, priceAt, type Candle } from "./price";
import type { DuelEvent, DuelMode, DuelPlayer, DuelResult, DuelRoom, NewDuelEvent } from "@/lib/duel/types";

const K = {
  room: (id: string) => `duel:room:${id}`,
  ev: (id: string) => `duel:ev:${id}`,
  lock: (id: string) => `duel:lock:${id}`,
  rooms: () => `duel:rooms`,
  queue: (tier: TierId, len: number) => `duel:q:${tier}:${len}`,
  qlock: (tier: TierId, len: number) => `duel:qlock:${tier}:${len}`,
  qsince: (pid: string) => `duel:qsince:${pid}`,
  qseen: (pid: string) => `duel:qseen:${pid}:${Math.floor(Date.now() / 10_000)}`,
  qseenPrev: (pid: string) => `duel:qseen:${pid}:${Math.floor(Date.now() / 10_000) - 1}`,
  matched: (pid: string) => `duel:matched:${pid}`,
  code: (c: string) => `duel:code:${c}`,
  rating: (pid: string) => `duel:rating:${pid}`,
  rated: (id: string) => `duel:rated:${id}`,
  active: (pid: string) => `duel:active:${pid}`,
  rlock: (pid: string) => `duel:rlock:${pid}`,
};
/** a live duel nobody ticked for longer than this is judged from the candle tape, not today's price */
const GAP_MS = 3000;
/** past the buzzer by this much with no tape: settle at the last price seen rather than hold the room forever */
const LATE_GIVEUP_MS = 10 * 60_000;
/** a live tick this close after the buzzer counts as the buzzer (the stream ticks every second) */
const ONTIME_MS = 1000;
/** a candle counts as closed this long after its minute ends */
const TAPE_LAG_MS = 2000;
const ACTIVE_TTL = 15 * 60;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const parse = <T,>(s: string | null): T | null => { if (!s) return null; try { return JSON.parse(s) as T; } catch { return null; } };

export class DuelError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/* ---------- locks ---------- */
async function withLockKey<T>(s: Kv, key: string, fn: () => Promise<T>): Promise<T> {
  const tok = ulid();
  for (let i = 0; i < 40; i++) {
    if (await s.setNX(key, tok, 5)) { try { return await fn(); } finally { await s.delIfEq(key, tok).catch(() => {}); } }
    await sleep(40 + Math.random() * 40);
  }
  throw new DuelError(503, "Busy, try again.");
}

/* ---------- rooms + events ---------- */
export async function getRoom(id: string, s: Kv = kv()): Promise<DuelRoom | null> {
  if (!/^[0-9A-Z]{26}$/.test(id)) return null;
  return parse<DuelRoom>(await s.get(K.room(id)));
}
export async function eventsAfter(id: string, after: number, s: Kv = kv()): Promise<DuelEvent[]> {
  const all = (await s.zrange(K.ev(id), 2000)).map((m) => parse<DuelEvent>(m)).filter((e): e is DuelEvent => !!e);
  return all.filter((e) => e.seq > after).sort((a, b) => a.seq - b.seq);
}
/** Change a room under its lock. `fn` mutates the room and returns events to append (seq + ts filled here). */
async function mutate(id: string, fn: (r: DuelRoom, now: number) => Promise<NewDuelEvent[]> | NewDuelEvent[], s: Kv = kv()): Promise<{ room: DuelRoom; events: DuelEvent[] }> {
  return withLockKey(s, K.lock(id), async () => {
    const room = await getRoom(id, s); if (!room) throw new DuelError(404, "That duel is gone.");
    const now = Date.now();
    const evs = await fn(room, now);
    const out: DuelEvent[] = evs.map((e) => ({ ...e, seq: ++room.seq, ts: now }) as DuelEvent);
    if (out.length) await s.zadd(K.ev(id), out.map((e) => ({ score: e.seq, member: JSON.stringify(e) })));
    await s.set(K.room(id), JSON.stringify(room));
    return { room, events: out };
  });
}

export interface Pilot { pid: string; name: string }
async function playerOf(p: Pilot, s: Kv): Promise<DuelPlayer> {
  const r = await ratingOf(p.pid, s);
  return { pid: p.pid, name: p.name, rating: r.r, record: { w: r.w, l: r.l }, ready: false };
}
/** One duel at a time: claim the pilot's seat for room `id`, or false if they're already in another live/lobby duel. */
async function claimSeat(pid: string, id: string, s: Kv): Promise<boolean> {
  if (await s.setNX(K.active(pid), id, ACTIVE_TTL)) return true;
  const cur = await s.get(K.active(pid));
  if (cur === id) return true;
  if (cur && !(await activeRoomOf(pid, s))) return s.setNX(K.active(pid), id, ACTIVE_TTL); // stale claim, cleared above
  return false;
}
const busy = () => new DuelError(409, "You're already in a duel. Finish or leave it first.");
async function createRoom(mode: DuelMode, tier: TierId, lenMs: LengthMs, players: DuelPlayer[], s: Kv, code?: string): Promise<DuelRoom> {
  const id = ulid(), now = Date.now();
  const got: string[] = [];
  for (const p of players) {
    if (await claimSeat(p.pid, id, s)) { got.push(p.pid); continue; }
    for (const q of got) await s.delIfEq(K.active(q), id);
    throw busy();
  }
  const room: DuelRoom = { id, mode, tier, lenMs, code, createdAt: now, players, status: "lobby", books: {}, seq: 0 };
  for (const p of players) room.books[p.pid] = newBook(TIERS[tier].fuel);
  await s.set(K.room(id), JSON.stringify(room));
  await s.zadd(K.rooms(), [{ score: now, member: id }]);
  return room;
}
export const seatOf = (r: DuelRoom, pid: string) => r.players.find((p) => p.pid === pid) ?? null;
const opponentOf = (r: DuelRoom, pid: string) => r.players.find((p) => p.pid !== pid) ?? null;

/* ---------- ratings ---------- */
export async function ratingOf(pid: string, s: Kv = kv()): Promise<Rating> { return parse<Rating>(await s.get(K.rating(pid))) ?? newRating(); }

/* ---------- quick match ---------- */
/**
 * One poll of the ranked queue (the lobby calls this every ~1.5 s while searching). Pairs you with the waiting pilot
 * closest in rating whose window (and yours) covers the gap; windows widen the longer either has waited.
 * → { room } once matched, else { waitedMs, window }.
 */
export async function pollQueue(me: Pilot, tier: TierId, lenMs: LengthMs, s: Kv = kv()): Promise<{ room: DuelRoom } | { waitedMs: number; window: number }> {
  const already = await s.get(K.matched(me.pid));
  if (already) { const r = await getRoom(already, s); if (r && r.status === "lobby") return { room: r }; await s.del(K.matched(me.pid)); }
  const act = await activeRoomOf(me.pid, s);
  if (act) return { room: act }; // already seated somewhere: go back to it, never a second ranked room
  return withLockKey(s, K.qlock(tier, lenMs), async () => {
    const now = Date.now();
    await s.setNX(K.qsince(me.pid), String(now), 120);
    await s.setNX(K.qseen(me.pid), "1", 25);
    const since = Number(await s.get(K.qsince(me.pid))) || now;
    const mine = await ratingOf(me.pid, s);
    const members = await s.zrange(K.queue(tier, lenMs), 200);
    let best: { pid: string; name: string; gap: number } | null = null;
    for (const m of members) {
      const e = parse<{ pid: string; name: string; r: number }>(m);
      if (!e || e.pid === me.pid) continue;
      const seen = (await s.get(K.qseen(e.pid))) || (await s.get(K.qseenPrev(e.pid)));
      if (!seen) { await s.zrem(K.queue(tier, lenMs), m); continue; } // stopped polling: gone
      if (await activeRoomOf(e.pid, s)) { await s.zrem(K.queue(tier, lenMs), m); continue; } // seated elsewhere
      const theirSince = Number(await s.get(K.qsince(e.pid))) || now;
      const gap = Math.abs(e.r - mine.r);
      if (gap <= matchWindow(now - since) && gap <= matchWindow(now - theirSince) && (!best || gap < best.gap)) best = { pid: e.pid, name: e.name, gap };
    }
    const meMember = JSON.stringify({ pid: me.pid, name: me.name, r: mine.r });
    if (!best) {
      if (!members.includes(meMember)) {
        for (const m of members) { const e = parse<{ pid: string }>(m); if (e?.pid === me.pid) await s.zrem(K.queue(tier, lenMs), m); }
        await s.zadd(K.queue(tier, lenMs), [{ score: mine.r, member: meMember }]);
      }
      return { waitedMs: now - since, window: matchWindow(now - since) };
    }
    for (const m of members) { const e = parse<{ pid: string }>(m); if (e && (e.pid === me.pid || e.pid === best.pid)) await s.zrem(K.queue(tier, lenMs), m); }
    await s.del(K.qsince(me.pid), K.qsince(best.pid));
    const room = await createRoom("ranked", tier, lenMs, [await playerOf(me, s), await playerOf({ pid: best.pid, name: best.name }, s)], s);
    await s.setNX(K.matched(best.pid), room.id, 60);
    return { room };
  });
}
export async function leaveQueue(pid: string, tier: TierId, lenMs: LengthMs, s: Kv = kv()) {
  const members = await s.zrange(K.queue(tier, lenMs), 200);
  for (const m of members) { const e = parse<{ pid: string }>(m); if (e?.pid === pid) await s.zrem(K.queue(tier, lenMs), m); }
  await s.del(K.qsince(pid));
}

/* ---------- challenge a friend ---------- */
export async function createInvite(me: Pilot, tier: TierId, lenMs: LengthMs, s: Kv = kv()): Promise<DuelRoom> {
  if (await activeRoomOf(me.pid, s)) throw busy();
  for (let i = 0; i < 6; i++) {
    const code = makeCode();
    if (!(await s.setNX(K.code(code), "pending", 30 * 60))) continue;
    let room: DuelRoom;
    try { room = await createRoom("friend", tier, lenMs, [await playerOf(me, s)], s, code); } catch (e) { await s.del(K.code(code)); throw e; }
    await s.del(K.code(code)); await s.setNX(K.code(code), room.id, 30 * 60);
    return room;
  }
  throw new DuelError(503, "Couldn't make a code, try again.");
}
export async function joinInvite(me: Pilot, code: string, s: Kv = kv()): Promise<DuelRoom> {
  const id = await s.get(K.code(code));
  if (!id || id === "pending") throw new DuelError(404, "That code isn't open. Ask your friend for a new link.");
  const { room } = await mutate(id, async (r) => {
    if (seatOf(r, me.pid)) return [];
    if (r.status !== "lobby" || r.players.length >= 2) throw new DuelError(409, "That duel already has two pilots.");
    if (!(await claimSeat(me.pid, r.id, s))) throw busy();
    r.players.push(await playerOf(me, s)); r.books[me.pid] = newBook(TIERS[r.tier].fuel);
    return [{ type: "join", pid: me.pid }];
  }, s);
  return room;
}

/* ---------- in the room ---------- */
export async function setReady(id: string, pid: string, s: Kv = kv()) {
  return mutate(id, (r, now) => {
    const me = seatOf(r, pid); if (!me) throw new DuelError(403, "You're not in this duel.");
    if (r.status !== "lobby" || me.ready) return [];
    me.ready = true; const evs: NewDuelEvent[] = [{ type: "ready", pid }];
    if (r.players.length === 2 && r.players.every((p) => p.ready)) {
      r.status = "live"; r.startAt = now + COUNTDOWN_MS; r.endAt = r.startAt + r.lenMs;
      evs.push({ type: "start", startAt: r.startAt, endAt: r.endAt });
      for (const p of r.players) void s.expireIfEq(K.active(p.pid), r.id, ACTIVE_TTL).catch(() => false);
    }
    return evs;
  }, s);
}
export async function leave(id: string, pid: string, s: Kv = kv()) {
  const out = await mutate(id, (r) => {
    if (!seatOf(r, pid)) return [];
    if (r.status === "lobby") { r.status = "cancelled"; return [{ type: "leave", pid }]; }
    return [{ type: "leave", pid }]; // live: their book still settles at the buzzer
  }, s);
  if (out.room.status === "cancelled") { if (out.room.code) await s.del(K.code(out.room.code)); for (const p of out.room.players) await s.delIfEq(K.active(p.pid), id); }
  return out;
}

/** Where a gap starts: the last price the server saw (or GO). */
const gapFrom = (r: DuelRoom) => Math.max(r.mark?.at ?? 0, r.startAt ?? 0);
/** Does this tick need the candle tape? (nobody ticked the room for a while) */
function needsTape(r: DuelRoom, now: number): boolean { return r.status === "live" && now > (r.startAt ?? Infinity) && now - gapFrom(r) > GAP_MS; }
async function tapeFor(r: DuelRoom | null, now: number): Promise<Candle[] | null> {
  if (!r || !needsTape(r, now)) return null;
  return duelCandles(gapFrom(r) - 60_000, Math.min(now, (r.endAt ?? now) + OT_MS));
}
function bombAll(r: DuelRoom, price: number, evs: NewDuelEvent[]) {
  for (const p of r.players) {
    const b = bombAt(r.books[p.pid], price);
    if (b) { r.books[p.pid] = b.book; evs.push({ type: "bomb", pid: p.pid, price, steps: [b.step], book: b.book }); }
  }
}
/**
 * H-BOMBs, then the buzzer (overtime once if it's close). Every price used is one from before the buzzer:
 *  - a gap nobody watched is checked against the tape's lows/highs (a bomb can't be dodged by closing the tab),
 *  - the buzzer settles at the price AT the buzzer: the live price if we're on time, the last mark if it's right
 *    before the buzzer, else the tape's price at that moment. Never a price from after it.
 * → the settle price, "wait" (late, tape not ready yet), or null (still live).
 */
function tickInto(r: DuelRoom, now: number, price: number | null, evs: NewDuelEvent[], tape: Candle[] | null): number | "wait" | null {
  if (r.status !== "live" || now < (r.startAt ?? 0)) return null;
  const fuel0 = TIERS[r.tier].fuel;
  // only finished minutes count: an open candle's close is just today's price
  const closed = tape?.filter((c) => c.t + 60_000 <= now - TAPE_LAG_MS) ?? null;
  if (closed && now - gapFrom(r) > GAP_MS) {
    // only minutes wholly inside the gap: every open position was entered at or before gapFrom (a trade marks the
    // room first), so these highs/lows all came after entry and before the buzzer. Partial minutes are skipped:
    // a bomb can be missed there, but never invented.
    const from = gapFrom(r), to = Math.min(now, r.endAt ?? now);
    for (const c of closed) {
      if (c.t < from || c.t + 60_000 > to) continue;
      bombAll(r, c.l, evs); bombAll(r, c.h, evs);
    }
  }
  for (;;) {
    const endAt = r.endAt ?? Infinity;
    if (now < endAt) {
      if (!price) return null;
      bombAll(r, price, evs); r.mark = { p: price, at: now };
      return null;
    }
    // The buzzer price is fixed by what happened before the buzzer, never by when someone shows up afterwards.
    let p: number | null = null;
    if (r.mark && r.mark.at <= endAt && endAt - r.mark.at <= GAP_MS) p = r.mark.p;     // seen right before it
    else if (price && now - endAt <= ONTIME_MS) { p = price; bombAll(r, p, evs); }     // this tick IS the buzzer
    else p = priceAt(closed, endAt);                                                   // the buzzer's minute, once it's closed
    if (!p) {
      if (now - endAt < LATE_GIVEUP_MS) return "wait";
      p = r.mark?.p ?? r.players.map((q) => r.books[q.pid].pos?.entry).find((e) => !!e) ?? null; // last pre-buzzer price
      if (!p) { if (r.players.some((q) => r.books[q.pid].pos)) return "wait"; p = price ?? 1; } // nothing open: price is moot
    }
    const [a, b] = r.players;
    const diff = profitOf(r.books[a.pid], p, fuel0) - profitOf(r.books[b.pid], p, fuel0);
    if (needsOvertime(diff, fuel0, !!r.ot)) {
      r.ot = true; r.mark = { p, at: endAt }; r.endAt = endAt + OT_MS;
      evs.push({ type: "overtime", endAt: r.endAt });
      continue; // the overtime buzzer may already be behind us too
    }
    return p;
  }
}
/** Rating write for one ranked duel: both pilots' ratings change under both pilots' locks (sorted order, no deadlock). */
async function rateDuel(r: DuelRoom, scoreA: 0 | 0.5 | 1, s: Kv) {
  const [a, b] = r.players;
  const [k1, k2] = [a.pid, b.pid].sort().map(K.rlock);
  return withLockKey(s, k1, () => withLockKey(s, k2, async () => {
    const ra = await ratingOf(a.pid, s), rb = await ratingOf(b.pid, s);
    const out = rate(ra, rb, scoreA);
    await s.set(K.rating(a.pid), JSON.stringify(out.a)); await s.set(K.rating(b.pid), JSON.stringify(out.b));
    return out;
  }));
}
async function settle(r: DuelRoom, price: number, s: Kv): Promise<NewDuelEvent> {
  const fuel0 = TIERS[r.tier].fuel;
  const books: DuelResult["books"] = {}, profit: DuelResult["profit"] = {};
  for (const p of r.players) { books[p.pid] = settleBook(r.books[p.pid], price); profit[p.pid] = Math.round((books[p.pid].fuel - fuel0) * 100) / 100; }
  const [a, b] = r.players;
  const d = profit[a.pid] - profit[b.pid], tie = Math.abs(d) < 0.005;
  const winner = tie ? null : d > 0 ? a.pid : b.pid;
  const delta: Record<string, number> = { [a.pid]: 0, [b.pid]: 0 }, rating: Record<string, number> = { [a.pid]: a.rating, [b.pid]: b.rating };
  if (r.mode === "ranked" && (await s.setNX(K.rated(r.id), "1", 7 * 86400))) {
    let out: Awaited<ReturnType<typeof rateDuel>>;
    try { out = await rateDuel(r, tie ? 0.5 : d > 0 ? 1 : 0, s); } catch (e) { await s.del(K.rated(r.id)); throw e; } // retry next tick
    delta[a.pid] = out.da; delta[b.pid] = out.db; rating[a.pid] = out.a.r; rating[b.pid] = out.b.r;
  }
  r.books = books; r.status = "done";
  r.result = { winner, profit, delta, rating, books, price };
  for (const p of r.players) await s.delIfEq(K.active(p.pid), r.id);
  return { type: "end", result: r.result };
}
/** Run H-BOMB + buzzer checks (any request, or the stream's tick, can call this; the lock makes it once). */
export async function tick(id: string, price: number | null, s: Kv = kv()) {
  const pre = await getRoom(id, s);
  if (!pre || pre.status !== "live") return null;
  const tape = await tapeFor(pre, Date.now());
  if (!price && !tape && Date.now() < (pre.endAt ?? 0) + LATE_GIVEUP_MS) return null;
  return mutate(id, async (r, now) => {
    const evs: NewDuelEvent[] = [];
    const p = tickInto(r, now, price, evs, tape);
    if (typeof p === "number") evs.push(await settle(r, p, s));
    return evs;
  }, s);
}

export async function trade(id: string, pid: string, action: TradeAction, usd: number, price: number | null, s: Kv = kv()) {
  if (!price) throw new DuelError(503, "Price feed is catching up, try again.");
  const tape = await tapeFor(await getRoom(id, s), Date.now());
  return mutate(id, async (r, now) => {
    if (!seatOf(r, pid)) throw new DuelError(403, "You're not in this duel.");
    if (r.status !== "live") throw new DuelError(409, r.status === "done" ? "The duel is over." : "The duel hasn't started.");
    if (now < (r.startAt ?? 0)) throw new DuelError(409, "Wait for GO.");
    const evs: NewDuelEvent[] = [];
    const p = tickInto(r, now, price, evs, tape);
    if (typeof p === "number") { evs.push(await settle(r, p, s)); return evs; }
    if (p === "wait" || now >= (r.endAt ?? Infinity)) throw new DuelError(409, "Time's up.");
    const sizes = TIERS[r.tier].sizes;
    if (action !== "close" && !sizes.includes(usd)) throw new DuelError(400, "Pick a trade size.");
    const out = applyTrade(r.books[pid], action, usd, price, now - (r.startAt ?? now));
    if (!out) throw new DuelError(409, action === "close" ? "Nothing open." : "Out of duel fuel. Cash out to free some.");
    r.books[pid] = out.book;
    evs.push({ type: "trade", pid, action, price, steps: out.steps, book: out.book });
    return evs;
  }, s);
}
export async function chat(id: string, pid: string, text: string, s: Kv = kv()) {
  return mutate(id, (r) => { if (!seatOf(r, pid)) throw new DuelError(403, "You're not in this duel."); return [{ type: "chat", pid, text }]; }, s);
}
export async function trick(id: string, pid: string, kind: "spin" | "flip", s: Kv = kv()) {
  return mutate(id, (r) => { if (!seatOf(r, pid) || r.status !== "live") return []; return [{ type: "trick", pid, kind }]; }, s);
}
/** Both pilots tap REMATCH → a new room with the same seats (they still ready up). */
export async function rematch(id: string, pid: string, s: Kv = kv()) {
  let make: DuelRoom | null = null;
  const out = await mutate(id, async (r) => {
    if (!seatOf(r, pid)) throw new DuelError(403, "You're not in this duel.");
    if (r.status !== "done") throw new DuelError(409, "Finish this one first.");
    r.rematch ??= { by: [] };
    if (r.rematch.roomId) return [];
    if (!r.rematch.by.includes(pid)) r.rematch.by.push(pid);
    if (r.players.every((p) => r.rematch!.by.includes(p.pid))) {
      const seats = await Promise.all(r.players.map((p) => playerOf(p, s)));
      make = await createRoom(r.mode, r.tier, r.lenMs, seats, s);
      r.rematch.roomId = make.id;
    }
    return [{ type: "rematch", pid, roomId: r.rematch.roomId }];
  }, s);
  return { ...out, next: make as DuelRoom | null };
}
/** Is this pilot already in a lobby or live duel? (one duel at a time) */
export async function activeRoomOf(pid: string, s: Kv = kv()): Promise<DuelRoom | null> {
  const id = await s.get(K.active(pid)); if (!id) return null;
  const r = await getRoom(id, s);
  if (!r || r.status === "done" || r.status === "cancelled") { await s.delIfEq(K.active(pid), id); return null; }
  return r;
}
export const _keys = K;
export { opponentOf };
