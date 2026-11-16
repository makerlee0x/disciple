import "server-only";
/**
 * Rocket collection server (rules in lib/collection.ts): each pilot's copies, their unopened crates, opening them with
 * provable server rolls, scrapping, trade-ups, and the equipped look (kept in the looks record so other
 * pilots see it). Prestige items (Ring-tail paints, the Halo trail, prestige name tags) aren't copies: a pilot has them
 * while their Prestige is high enough.
 *
 * KV keys (chain-namespaced):
 *   col:<chain>:inv:<wallet>         JSON  Copy[]                         every copy the pilot holds (the source of truth)
 *   col:<chain>:own:<wallet>         set   item ids                        legacy (before copies); migrated into inv once
 *   col:<chain>:supply:<item>        counter                               copies ever made of an item ("#14 of 312")
 *   col:<chain>:sfirst:<series>      first drop time of a series           first edition = its first 7 days
 *   col:<chain>:seed:<day>           hex   that UTC day's roll seed         sha256 published a day ahead, seed revealed after
 *   col:<chain>:crates:<wallet>      zset  score=at, member=Crate JSON      unopened crates
 *   col:<chain>:once:<src>:<wallet>  SET NX                                a crate source pays once ever
 *   col:<chain>:base:<wallet>        JSON  { p, l }                         first visit marker (the welcome crate pays once)
 *   col:<chain>:copy:<uid>           JSON  CopyRecord                       one copy's permanent record (never deleted or reused)
 *   col:<chain>:log:<wallet>         zset  score=at, member=Opened JSON     recent openings
 *   col:<chain>:streak:<wallet>      ranked duel win streak
 *   col:<chain>:dc:<week>:<wallet>   duel crates this week (counter)
 * Crate XP and scrap XP are ledger rows (kind "crate").
 *
 * Ready for NFTs later (maker, 16 Nov: trade in our database first, then move to tokens): every copy keeps a uid that is
 * never reused, its serial (never renumbered), its rolls and a permanent record of where it came from, who has held it
 * and how it ended (scrapped or traded up), so each copy can become exactly one token with its history. Starter copies
 * (serial 0, uid st-<item>, the same for every pilot) are bound and never become tokens.
 */
import { createHash, createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { ACTIVE_CHAIN } from "@/lib/chains";
import {
  CRATE, DUPE_XP, EARN, FIRST_EDITION_MS, FLIGHTTRAK_PCT, ITEMS, PRESTIGE_HULL, RARITY_NAME,
  STARTER_SKIN, STARTER_TAG, STARTER_TRAIL, TRADE_UP_N, TRAILS, dayIndex, dropPool, duelCrateTier, itemById, itemTitle, prestigeUnlocked, rollCrate,
  rollsFromDigest, tradeUpPool, tradeUpTarget, trailId,
  type Collection, type Copy, type Crate, type Item, type Opened, type Rarity, type Slot,
} from "@/lib/collection";
import { ensureCatalog } from "./catalog";
import { kv, type Kv } from "./kv";
import { award, ledgerOf, totals, withLock, xpSummary } from "./xp";

const ns = () => `col:${ACTIVE_CHAIN.id}`;
export const COLK = {
  inv: (w: string) => `${ns()}:inv:${w}`,
  own: (w: string) => `${ns()}:own:${w}`,
  supply: (item: string) => `${ns()}:supply:${item}`,
  sfirst: (n: number | string) => `${ns()}:sfirst:${n}`,
  seed: (day: number) => `${ns()}:seed:${day}`,
  crates: (w: string) => `${ns()}:crates:${w}`,
  once: (src: string, w: string) => `${ns()}:once:${src}:${w}`,
  base: (w: string) => `${ns()}:base:${w}`,
  log: (w: string) => `${ns()}:log:${w}`,
  streak: (w: string) => `${ns()}:streak:${w}`,
  dc: (week: number, w: string) => `${ns()}:dc:${week}:${w}`,
  looks: (w: string) => `looks:${ACTIVE_CHAIN.id}:${w}`,
  copy: (uid: string) => `${ns()}:copy:${uid}`,
  /** the open market listing a copy is on (lib/server/market.ts); while set, the copy can't be scrapped, traded up or equipped */
  listed: (uid: string) => `${ns()}:listed:${uid}`,
  /** a frozen copy (reported stolen or farmed): can't be listed, bought or traded */
  frozen: (uid: string) => `${ns()}:frozen:${uid}`,
  /** a ranked pair already paid a crate today (same opponent counts once a day) */
  pair: (day: number, a: string, b: string) => `${ns()}:pair:${day}:${[a, b].sort().join(":")}`,
};
const parse = <T,>(s: string | null): T | null => { if (!s) return null; try { return JSON.parse(s) as T; } catch { return null; } };
const lc = (w: string) => w.toLowerCase();
const FOREVER = 10 * 365 * 86400;
/** the week a duel crate counts toward (Monday 00:00 UTC) */
export const weekIndex = (now: number) => Math.floor((dayIndex(now) + 3) / 7);
/** crate sources whose items never trade: the welcome crate (and level-up and shop crates, if any were made before the cut) */
const boundSrc = (src: string) => src === "welcome" || src.startsWith("lvl:") || src.startsWith("shopcrate:");
const STARTERS = [STARTER_SKIN, STARTER_TRAIL, STARTER_TAG];

/* ------------------------------------------------------------- provable rolls ------------------------------------------------------------- */

/** That UTC day's roll seed (made on first use). */
async function daySeed(day: number, s: Kv): Promise<string> {
  await s.setNX(COLK.seed(day), randomBytes(32).toString("hex"), 400 * 86400);
  return (await s.get(COLK.seed(day)))!;
}
export const seedHash = (seed: string) => createHash("sha256").update(seed).digest("hex");
/** Today's and tomorrow's seed hashes, plus the last 7 days' seeds (revealed). Public: GET /api/collection?proof=1. */
export async function rollProof(now = Date.now(), s: Kv = kv()) {
  const d = dayIndex(now);
  const [t, n] = await Promise.all([daySeed(d, s), daySeed(d + 1, s)]);
  const past = (await s.mget(Array.from({ length: 7 }, (_, k) => COLK.seed(d - 1 - k)))).map((seed, k) => ({ day: d - 1 - k, seed, hash: seed ? seedHash(seed) : null })).filter((x) => x.seed);
  return { today: { day: d, hash: seedHash(t) }, tomorrow: { day: d + 1, hash: seedHash(n) }, revealed: past };
}
/** Random-but-honest numbers for a crate: HMAC(today's seed, crate id). */
async function provableRolls(crateId: string, now: number, s: Kv) {
  const day = dayIndex(now), seed = await daySeed(day, s);
  const hex = createHmac("sha256", seed).update(crateId).digest("hex");
  return { rolls: rollsFromDigest(hex), proof: { day, input: crateId, hash: seedHash(seed) } };
}
const freshRolls = () => rollsFromDigest(randomBytes(32).toString("hex"));

/* ---------------------------------------------------------------- copies ---------------------------------------------------------------- */

async function readInv(w: string, s: Kv): Promise<Copy[] | null> { return parse<Copy[]>(await s.get(COLK.inv(w))); }
const writeInv = (w: string, inv: Copy[], s: Kv) => s.set(COLK.inv(w), JSON.stringify(inv));

/** First edition: within 7 days of the first copy of its series (or its mid-series drop) ever dropping (series-0 items count from Series 1). */
async function firstEdition(item: Item, now: number, s: Kv): Promise<boolean> {
  const n = item.drop ?? (item.series || 1);
  await s.setNX(COLK.sfirst(n), String(now));
  return now - Number(await s.get(COLK.sfirst(n))) < FIRST_EDITION_MS;
}
/** One event in a copy's life. made: where it came from; burned: scrapped or traded up (into = the new copy); moved: a trade
 *  offer or a market sale (price in cents). Later: minted. */
export type CopyEvent =
  | { ev: "made"; at: number; owner: string; origin: Copy["origin"]; crate?: string; proofDay?: number; from?: string[] }
  | { ev: "burned"; at: number; owner: string; why: "scrap" | "tradeup"; into?: string }
  | { ev: "moved"; at: number; from: string; to: string; via: "trade" | "market"; offer?: string; listing?: string; price?: number; tx?: string };
/** A copy's permanent record: the copy as made, who holds it now, and its history. Kept after it's burned. */
export interface CopyRecord { copy: Copy; owner: string; burned: boolean; history: CopyEvent[] }
export async function copyRecord(uid: string, s: Kv = kv()): Promise<CopyRecord | null> { return /^[a-f0-9]{16}$/.test(uid) ? parse<CopyRecord>(await s.get(COLK.copy(uid))) : null; }
async function addEvent(uid: string, e: CopyEvent, s: Kv) {
  const r = await copyRecord(uid, s); if (!r) return;
  r.history.push(e); if (e.ev === "burned") r.burned = true; if (e.ev === "moved") r.owner = e.to;
  await s.set(COLK.copy(uid), JSON.stringify(r));
}
/** A new copy: a fresh uid (claimed with SET NX, so never reused), the next serial for its item, and its record. */
async function makeCopy(item: Item, origin: Copy["origin"], bound: boolean, r: { burn: number; seed: number; trak: boolean }, now: number, s: Kv,
  owner: string, how: { crate?: string; proofDay?: number; from?: string[] } = {}, fe?: boolean): Promise<Copy> {
  const serial = await s.incrEx(COLK.supply(item.id), FOREVER);
  const copy: Copy = { uid: "", item: item.id, serial, burn: Math.round(r.burn * 1e6) / 1e6, seed: r.seed, trak: r.trak ? 0 : null, fe: fe ?? (await firstEdition(item, now, s)), origin, at: now, bound };
  const rec: CopyRecord = { copy, owner, burned: false, history: [{ ev: "made", at: now, owner, origin, ...how }] };
  for (;;) { copy.uid = randomBytes(8).toString("hex"); if (await s.setNX(COLK.copy(copy.uid), JSON.stringify(rec))) break; }
  return copy;
}
const starterCopy = (item: string, now: number): Copy => ({ uid: `st-${item}`.slice(0, 40), item, serial: 0, burn: 0, seed: 0, trak: null, fe: false, origin: "starter", at: now, bound: true });

/**
 * The pilot's copies. First read turns the legacy owned-id set into copies (rolled fresh, serials in the order they're
 * found here) and adds the starters. Call inside withLock when you'll write.
 */
async function invOf(w: string, now: number, s: Kv): Promise<Copy[]> {
  let inv = await readInv(w, s);
  if (inv) return inv;
  inv = STARTERS.map((id) => starterCopy(id, now));
  for (const id of await s.smembers(COLK.own(w))) {
    const it = itemById(id); if (!it || it.prestige || STARTERS.includes(id)) continue;
    inv.push(await makeCopy(it, "migrated", false, freshRolls(), now, s, w));
  }
  await writeInv(w, inv, s);
  await s.del(COLK.own(w));   // copies are the record from now on
  return inv;
}

/** What a pilot owns: item ids of their copies, the starters, and (with their Prestige) the prestige items. */
export async function ownedItems(w: string, s: Kv = kv(), prestige = 0, inv?: Copy[]): Promise<Set<string>> {
  const have = inv ?? (await readInv(lc(w), s));
  const set = new Set((have ?? []).map((c) => c.item));
  if (!have) for (const id of await s.smembers(COLK.own(lc(w)))) set.add(id);   // legacy, before the first migration
  for (const id of STARTERS) set.add(id);
  for (const i of ITEMS) if (prestigeUnlocked(i, prestige)) set.add(i.id);
  return set;
}

/** Is the copy on the market (or mid-sale)? Listed copies can't be scrapped, traded up or equipped. */
export async function isListed(uid: string, s: Kv = kv()): Promise<boolean> { return !!(await s.get(COLK.listed(uid))); }
export async function frozenReason(uid: string, s: Kv = kv()): Promise<string | null> { return s.get(COLK.frozen(uid)); }
/** For lib/server/market.ts: the inventory read/write and the copy record, used only under the wallet lock. */
export const copyStore = { invOf, readInv, writeInv, addEvent, lc };

/* ------------------------------------------------------------- granting ------------------------------------------------------------- */

/** Give one crate, once ever per (src, wallet). true if it was given now. */
export async function grantCrate(walletIn: string, tier: Rarity, src: string, label: string, now = Date.now(), s: Kv = kv()): Promise<boolean> {
  const w = lc(walletIn);
  if (!(await s.setNX(COLK.once(src, w), String(now)))) return false;
  const c: Crate = { id: randomUUID().slice(0, 12), tier, src, label, at: now };
  await s.zadd(COLK.crates(w), [{ score: now, member: JSON.stringify(c) }]);
  return true;
}

/**
 * A settled ranked duel (lib/server/duel/store settle): the winner's streak goes up, a FlightTrak skin they flew counts the
 * win, and they get a crate (15 a week at most); the loser's streak resets. Friend duels and ties drop nothing.
 */
export async function onDuelSettled(roomId: string, winner: string | null, loser: string | null, now = Date.now(), s: Kv = kv()): Promise<void> {
  await ensureCatalog(s);
  if (loser) await s.set(COLK.streak(lc(loser)), "0");
  if (!winner) return;
  const w = lc(winner);
  if (!(await s.setNX(COLK.once(`duelset:${roomId}`, w), "1"))) return;   // a room settles once
  // the same two pilots only pay a crate once a day (stops two accounts farming each other); the streak still counts
  const samePair = !!loser && !(await s.setNX(COLK.pair(dayIndex(now), w, lc(loser)), "1", 2 * 86400));
  const streak = (Number(await s.get(COLK.streak(w))) || 0) + 1;
  await s.set(COLK.streak(w), String(streak));
  await countFlightTrak(w, now, s).catch(() => {});
  if (samePair) return;
  const week = await s.incrEx(COLK.dc(weekIndex(now), w), 9 * 86400);
  if (week > EARN.duelPerWeek) return;
  const tier = duelCrateTier(streak);
  await grantCrate(w, tier, `duel:${roomId}`, streak >= 3 ? `Duel win streak x${streak}` : "Duel win", now, s);
}
async function countFlightTrak(w: string, now: number, s: Kv) {
  const uid = (await equippedOf(w, s)).copy.skin;
  if (!uid) return;
  for (let k = 0; k < 3; k++) {
    const r = await withLock(w, s, async () => {
      const inv = await invOf(w, now, s), c = inv.find((x) => x.uid === uid);
      if (c && c.trak != null) {
        c.trak++; await writeInv(w, inv, s);
        const l = parse<LooksRec & { fx?: { skin?: { trak?: number } } }>(await s.get(COLK.looks(w)));
        if (l?.copy?.skin === uid && l.fx?.skin) { l.fx.skin.trak = c.trak; await s.set(COLK.looks(w), JSON.stringify(l)); }
      }
      return { ok: true as const };
    });
    if (r.ok) return;
  }
}

/** Weekly-mission and welcome crates, worked out from the XP summary. Idempotent; run on every read. Levels don't drop
 *  crates (maker cut them 2026-11-16, with the XP shop): wins are how you find things. */
async function syncEarned(w: string, now: number, s: Kv) {
  const xp = await xpSummary(w, now, s);
  if (await s.setNX(COLK.base(w), JSON.stringify({ p: xp.level.prestige, l: xp.level.level }))) await grantCrate(w, EARN.welcome, "welcome", "Welcome to the Hangar", now, s);
  if (xp.weekly.missions.length && xp.weekly.missions.every((m) => m.done)) await grantCrate(w, EARN.weekly, `week:${xp.weekly.period}`, "Weekly missions", now, s);
  return xp;
}

/* --------------------------------------------------------------- reading --------------------------------------------------------------- */

async function cratesOf(w: string, s: Kv): Promise<Crate[]> {
  return (await s.zrange(COLK.crates(w), 200)).map((m) => parse<Crate>(m)).filter((c): c is Crate => !!c && !!CRATE[c.tier]);
}
export type Equipped = { skin: string; trail: string; tag: string; flourish: string; copy: Partial<Record<Slot, string>> };
type LooksRec = { skin?: string; trail?: string; tag?: string; flourish?: string; copy?: Partial<Record<Slot, string>>; fx?: unknown };
export async function equippedOf(w: string, s: Kv = kv()): Promise<Equipped> {
  const j = parse<LooksRec>(await s.get(COLK.looks(lc(w))));
  const ok = (id: string | undefined, kind: string) => !!id && itemById(id)?.kind === kind;
  return {
    skin: ok(j?.skin, "skin") ? j!.skin! : STARTER_SKIN, trail: ok(j?.trail, "trail") ? j!.trail! : STARTER_TRAIL, tag: ok(j?.tag, "tag") ? j!.tag! : STARTER_TAG,
    flourish: ok(j?.flourish, "flourish") ? j!.flourish! : "", copy: j?.copy ?? {},
  };
}

export async function collectionOf(walletIn: string, now = Date.now(), s: Kv = kv()): Promise<Collection> {
  await ensureCatalog(s);
  const w = lc(walletIn);
  const xp = await syncEarned(w, now, s);
  let inv = await readInv(w, s);
  if (!inv) { const r = await withLock(w, s, () => invOf(w, now, s)); inv = Array.isArray(r) ? r : STARTERS.map((id) => starterCopy(id, now)); }
  const [owned, crates, eq, log] = await Promise.all([ownedItems(w, s, xp.level.prestige, inv), cratesOf(w, s), equippedOf(w, s), s.zrange(COLK.log(w), 10, true)]);
  const ids = [...new Set(inv.map((c) => c.item))];
  const sup = ids.length ? await s.mget(ids.map((id) => COLK.supply(id))) : [];
  return {
    wallet: w, owned: [...owned], copies: inv, supply: Object.fromEntries(ids.map((id, k) => [id, Number(sup[k]) || 0])), crates,
    equipped: { skin: eq.skin, trail: eq.trail, tag: eq.tag, flourish: eq.flourish }, equippedCopy: eq.copy,
    spendableXp: xp.spendableXp, prestige: xp.level.prestige,
    recent: log.map((m) => parse<Opened>(m)).filter((o): o is Opened => !!o),
  };
}

/* ---------------------------------------------------------------- writes ---------------------------------------------------------------- */

export type OpenResult = { ok: true; opened: Opened } | { ok: false; reason: string };

/** Open one crate: a provable roll picks the rarity, the item (live series) and the copy's burn/seed/FlightTrak, plus XP. */
export async function openCrate(walletIn: string, crateId: string, now = Date.now(), s: Kv = kv()): Promise<OpenResult> {
  await ensureCatalog(s);
  const w = lc(walletIn);
  return withLock(w, s, async (): Promise<OpenResult> => {
    const raw = await s.zrange(COLK.crates(w), 200);
    const member = raw.find((m) => parse<Crate>(m)?.id === crateId);
    const crate = member ? parse<Crate>(member) : null;
    if (!member || !crate) return { ok: false, reason: "That crate is already open." };
    if (!(await s.zrem(COLK.crates(w), member))) return { ok: false, reason: "That crate is already open." };
    const { rolls, proof } = await provableRolls(crate.id, now, s);
    const item = rollCrate(crate.tier, dropPool(now), rolls.r1, rolls.r2);
    const inv = await invOf(w, now, s);
    const dupe = !!item && inv.some((c) => c.item === item.id);
    let copy: Copy | undefined;
    if (item) { copy = await makeCopy(item, "crate", boundSrc(crate.src), rolls, now, s, w, { crate: crate.id, ...(proof ? { proofDay: proof.day } : {}) }); inv.push(copy); await writeInv(w, inv, s); }
    const xp = CRATE[crate.tier].xp;
    await award(w, { src: `crate:${crate.id}`, kind: "crate", xp, label: `${RARITY_NAME[crate.tier]} crate`, ts: now }, s);
    const opened: Opened = { crate, item, copy, dupe, xp, at: now, proof };
    await s.zadd(COLK.log(w), [{ score: now, member: JSON.stringify(opened) }]);
    return { ok: true, opened };
  }) as Promise<OpenResult>;
}


export type ScrapResult = { ok: true; xp: number } | { ok: false; reason: string };

/** Scrap a copy for XP (the copy is destroyed). Not the one you fly, and not a starter. */
export async function scrapCopy(walletIn: string, uid: string, now = Date.now(), s: Kv = kv()): Promise<ScrapResult> {
  await ensureCatalog(s);
  const w = lc(walletIn);
  return withLock(w, s, async (): Promise<ScrapResult> => {
    const inv = await invOf(w, now, s), k = inv.findIndex((c) => c.uid === uid);
    if (k < 0) return { ok: false, reason: "You don't have that copy." };
    const c = inv[k], it = itemById(c.item);
    if (!it || c.origin === "starter") return { ok: false, reason: "Starter items can't be scrapped." };
    if (Object.values((await equippedOf(w, s)).copy).includes(uid)) return { ok: false, reason: "Take it off before you scrap it." };
    if (await isListed(uid, s)) return { ok: false, reason: "Take it off the market before you scrap it." };
    inv.splice(k, 1); await writeInv(w, inv, s);
    await addEvent(uid, { ev: "burned", at: now, owner: w, why: "scrap" }, s);
    const xp = DUPE_XP[it.rar];
    await award(w, { src: `scrap:${uid}`, kind: "crate", xp, label: `Scrapped ${itemTitle(it)}`, ts: now }, s);
    return { ok: true, xp };
  }) as Promise<ScrapResult>;
}

export type TradeUpResult = { ok: true; copy: Copy; item: Item } | { ok: false; reason: string };

/**
 * Trade up: exactly 10 copies of one rarity from one series (none worn, no starters) become 1 copy of the next rarity
 * from that series, with their burn averaged. Bound if any input was bound. Never into Mythic.
 */
export async function tradeUp(walletIn: string, uids: string[], now = Date.now(), s: Kv = kv()): Promise<TradeUpResult> {
  await ensureCatalog(s);
  const w = lc(walletIn);
  const want = [...new Set(uids)];
  if (want.length !== TRADE_UP_N) return { ok: false, reason: `A trade-up takes ${TRADE_UP_N} copies.` };
  return withLock(w, s, async (): Promise<TradeUpResult> => {
    const inv = await invOf(w, now, s);
    const ins = want.map((u) => inv.find((c) => c.uid === u));
    if (ins.some((c) => !c)) return { ok: false, reason: "You don't have one of those copies." };
    const copies = ins as Copy[], items = copies.map((c) => itemById(c.item)!);
    if (copies.some((c) => c.origin === "starter") || items.some((i) => !i || i.prestige)) return { ok: false, reason: "Starter and prestige items can't be traded up." };
    const rar = items[0].rar, series = items[0].series;
    if (items.some((i) => i.rar !== rar || i.series !== series)) return { ok: false, reason: "All 10 must be the same rarity from the same series." };
    if (!tradeUpTarget(rar)) return { ok: false, reason: `${RARITY_NAME[rar]} can't be traded up. Mythic only comes from crates.` };
    const eq = Object.values((await equippedOf(w, s)).copy);
    if (copies.some((c) => eq.includes(c.uid))) return { ok: false, reason: "Take off what you're flying first." };
    for (const c of copies) if (await isListed(c.uid, s)) return { ok: false, reason: "One of those is on the market. Take it off first." };
    const pool = tradeUpPool(series, rar, now);
    if (!pool.length) return { ok: false, reason: "Nothing to trade up into for that series yet." };
    const out = pool[randomInt(0, pool.length)];
    const r = freshRolls();
    // first edition only comes out of crates
    const copy = await makeCopy(out, "tradeup", copies.some((c) => c.bound), { burn: copies.reduce((a, c) => a + c.burn, 0) / copies.length, seed: r.seed, trak: randomInt(0, 100) < FLIGHTTRAK_PCT }, now, s, w, { from: want }, false);
    const left = inv.filter((c) => !want.includes(c.uid)); left.push(copy);
    await writeInv(w, left, s);
    for (const u of want) await addEvent(u, { ev: "burned", at: now, owner: w, why: "tradeup", into: copy.uid }, s);
    return { ok: true, copy, item: out };
  }) as Promise<TradeUpResult>;
}

export type EquipResult = { ok: true; equipped: Omit<Equipped, "copy"> & { copy: Partial<Record<Slot, string>> } } | { ok: false; reason: string };

/**
 * Equip a look. Each slot takes a copy uid, or an item id (prestige items, or your best copy of that item). The tag and
 * flourish left out keep what's on; flourish "none" takes it off. Ring-tail skins need Prestige 1 and the same paint
 * found on another hull; prestige trails and tags need that Prestige.
 */
export async function equip(walletIn: string, skin: string, trail: string, tag = "", flourish = "", s: Kv = kv()): Promise<EquipResult> {
  await ensureCatalog(s);
  const w = lc(walletIn);
  const now = Date.now(), prestige = (await xpSummary(w, now, s)).level.prestige;
  const inv = (await readInv(w, s)) ?? STARTERS.map((id) => starterCopy(id, now));
  const owned = await ownedItems(w, s, prestige, inv);
  const prev = parse<LooksRec>(await s.get(COLK.looks(w))) ?? {};
  // copies on the market can't be flown: they're skipped when an item id picks your best copy, and refused by uid
  const onMarket = new Set(inv.length ? (await s.mget(inv.map((c) => COLK.listed(c.uid)))).flatMap((v, k) => (v ? [inv[k].uid] : [])) : []);
  const best = (id: string) => inv.filter((c) => c.item === id && !onMarket.has(c.uid)).sort((a, b) => a.burn - b.burn)[0];
  // resolve a slot to { item, copy? } or a reason
  const pick = (v: string, kind: Slot): { item: Item; copy?: Copy } | string => {
    const c = inv.find((x) => x.uid === v);
    if (c) { const it = itemById(c.item); return it && it.kind === kind ? { item: it, copy: c } : "That copy doesn't go there."; }
    const it = itemById(v);
    if (!it || it.kind !== kind) return `Pick a ${kind === "tag" ? "name tag" : kind}.`;
    if (it.hull === PRESTIGE_HULL) {
      if (prestige < 1) return "Ring-tail unlocks at Prestige 1.";
      if (![...owned].some((id) => id.endsWith(`--${it.paint}`) && !id.startsWith(PRESTIGE_HULL))) return `Find ${it.name} on another hull first.`;
      return { item: it };
    }
    if (it.prestige) return prestigeUnlocked(it, prestige) ? { item: it } : `${it.name} unlocks at Prestige ${it.prestige}.`;
    const b = best(it.id);
    return b ? { item: it, copy: b } : it.kind === "skin" ? "You haven't found that skin yet." : it.kind === "trail" ? "You haven't found that trail yet." : "You haven't found that yet.";
  };
  if ([skin, trail, tag, flourish].some((v) => v && onMarket.has(v))) return { ok: false, reason: "That copy is on the market. Take it off the market to fly it." };
  const sk = pick(skin, "skin"), tr = pick(trail, "trail");
  if (typeof sk === "string") return { ok: false, reason: sk };
  if (typeof tr === "string") return { ok: false, reason: tr };
  const tg = tag ? pick(tag, "tag") : (prev.copy?.tag && inv.some((c) => c.uid === prev.copy!.tag) ? pick(prev.copy.tag, "tag") : pick(STARTER_TAG, "tag"));
  if (typeof tg === "string") return { ok: false, reason: tg };
  let fl: { item: Item; copy?: Copy } | null = null;
  if (flourish && flourish !== "none") { const f = pick(flourish, "flourish"); if (typeof f === "string") return { ok: false, reason: f }; fl = f; }
  else if (!flourish && prev.copy?.flourish && inv.some((c) => c.uid === prev.copy!.flourish)) { const f = pick(prev.copy.flourish, "flourish"); if (typeof f !== "string") fl = f; }
  const copy: Partial<Record<Slot, string>> = {};
  if (sk.copy) copy.skin = sk.copy.uid; if (tr.copy) copy.trail = tr.copy.uid; if (tg.copy) copy.tag = tg.copy.uid; if (fl?.copy) copy.flourish = fl.copy.uid;
  // fx: what other pilots' engines need to draw this copy (burn, pattern seed, FlightTrak count)
  const fx = (c?: Copy) => (c ? { burn: c.burn, seed: c.seed, ...(c.trak != null ? { trak: c.trak } : {}) } : undefined);
  const rec = { ...prev, skin: sk.item.id, trail: tr.item.id, tag: tg.item.id, flourish: fl?.item.id ?? "", copy, fx: { skin: fx(sk.copy), trail: fx(tr.copy) } };
  await s.set(COLK.looks(w), JSON.stringify(rec));
  return { ok: true, equipped: { skin: sk.item.id, trail: tr.item.id, tag: tg.item.id, flourish: fl?.item.id ?? "", copy } };
}

/** The engine's flame colour for a trail id. */
export const trailRgb = (id: string) => TRAILS.find((t) => trailId(t.id) === id)?.rgb ?? TRAILS[0].rgb;