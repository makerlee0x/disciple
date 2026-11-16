import "server-only";
/**
 * Rocket collection server (rules in lib/collection.ts): what each pilot owns, their unopened crates, opening them with
 * server randomness, the daily shop, and the equipped skin + trail (kept in the looks record so other pilots see it).
 *
 * KV keys (chain-namespaced):
 *   col:<chain>:own:<wallet>         set   item ids (skins "needle--nebula", trails "trail-mint")
 *   col:<chain>:crates:<wallet>      zset  score=at, member=Crate JSON  unopened crates
 *   col:<chain>:once:<src>:<wallet>  SET NX                              a crate source pays once ever
 *   col:<chain>:base:<wallet>        JSON  { p, l }                       level baseline: crates pay for levels after it
 *   col:<chain>:log:<wallet>         zset  score=at, member=Opened JSON   recent openings
 *   col:<chain>:streak:<wallet>      ranked duel win streak
 *   col:<chain>:dc:<day>:<wallet>    duel crates today (counter)
 * Crate XP and duplicate XP are ledger rows (kind "crate"); shop buys are negative ledger rows (kind "buy").
 */
import { randomInt, randomUUID } from "node:crypto";
import { ACTIVE_CHAIN } from "@/lib/chains";
import {
  CRATE, CRATE_PRICE, DUPE_XP, EARN, PRESTIGE_HULL, PRICE, SHOP_CRATE_ID, STARTER_SKIN, STARTER_TRAIL, dayIndex, dropPool, duelCrateTier, itemById,
  itemTitle, rollCrate, shopStock, trailId, RARITY_NAME, TRAILS,
  type Collection, type Crate, type Item, type Opened, type Rarity,
} from "@/lib/collection";
import { kv, type Kv } from "./kv";
import { award, ledgerOf, totals, withLock, xpSummary } from "./xp";

const ns = () => `col:${ACTIVE_CHAIN.id}`;
export const COLK = {
  own: (w: string) => `${ns()}:own:${w}`,
  crates: (w: string) => `${ns()}:crates:${w}`,
  once: (src: string, w: string) => `${ns()}:once:${src}:${w}`,
  base: (w: string) => `${ns()}:base:${w}`,
  log: (w: string) => `${ns()}:log:${w}`,
  streak: (w: string) => `${ns()}:streak:${w}`,
  dc: (day: number, w: string) => `${ns()}:dc:${day}:${w}`,
  looks: (w: string) => `looks:${ACTIVE_CHAIN.id}:${w}`,
};
const parse = <T,>(s: string | null): T | null => { if (!s) return null; try { return JSON.parse(s) as T; } catch { return null; } };
const lc = (w: string) => w.toLowerCase();
/** at most this many level crates per sync (a big jump still pays, over a few visits) */
const LEVEL_BATCH = 10;

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
 * A settled ranked duel (lib/server/duel/store settle): the winner's streak goes up and they get a crate (5 a day at
 * most); the loser's streak resets. Friend duels and ties drop nothing.
 */
export async function onDuelSettled(roomId: string, winner: string | null, loser: string | null, now = Date.now(), s: Kv = kv()): Promise<void> {
  if (loser) await s.set(COLK.streak(lc(loser)), "0");
  if (!winner) return;
  const w = lc(winner);
  if (!(await s.setNX(COLK.once(`duelset:${roomId}`, w), "1"))) return;   // a room settles once
  const streak = (Number(await s.get(COLK.streak(w))) || 0) + 1;
  await s.set(COLK.streak(w), String(streak));
  const today = await s.incrEx(COLK.dc(dayIndex(now), w), 2 * 86400);
  if (today > EARN.duelPerDay) return;
  const tier = duelCrateTier(streak);
  await grantCrate(w, tier, `duel:${roomId}`, streak >= 3 ? `Duel win streak x${streak}` : "Duel win", now, s);
}

/** Level, weekly-mission and welcome crates, worked out from the XP summary. Idempotent; run on every read. */
async function syncEarned(w: string, now: number, s: Kv) {
  const xp = await xpSummary(w, now, s);
  const lv = xp.level.level, p = xp.level.prestige;
  const base = parse<{ p: number; l: number }>(await s.get(COLK.base(w)));
  if (!base) {
    await s.set(COLK.base(w), JSON.stringify({ p, l: lv }));
    await grantCrate(w, EARN.welcome, "welcome", "Welcome to the Hangar", now, s);
  } else {
    let n = 0;
    const from = base.p === p ? base.l + 1 : 2;
    let l = from;
    for (; l <= lv && n < LEVEL_BATCH; l++) if (await grantCrate(w, EARN.level(l), `lvl:p${p}:${l}`, `Level ${l}`, now, s)) n++;
    if (base.p !== p || l - 1 !== base.l) await s.set(COLK.base(w), JSON.stringify({ p, l: l - 1 }));
  }
  if (xp.weekly.missions.length && xp.weekly.missions.every((m) => m.done)) await grantCrate(w, EARN.weekly, `week:${xp.weekly.period}`, "Weekly missions", now, s);
  return xp;
}

/* --------------------------------------------------------------- reading --------------------------------------------------------------- */

export async function ownedItems(w: string, s: Kv = kv()): Promise<Set<string>> {
  const set = new Set(await s.smembers(COLK.own(lc(w))));
  set.add(STARTER_SKIN); set.add(STARTER_TRAIL);
  return set;
}
async function cratesOf(w: string, s: Kv): Promise<Crate[]> {
  return (await s.zrange(COLK.crates(w), 200)).map((m) => parse<Crate>(m)).filter((c): c is Crate => !!c && !!CRATE[c.tier]);
}
export type Equipped = { skin: string; trail: string };
export async function equippedOf(w: string, s: Kv = kv()): Promise<Equipped> {
  const j = parse<{ skin?: string; trail?: string }>(await s.get(COLK.looks(lc(w))));
  return { skin: j?.skin && itemById(j.skin) ? j.skin : STARTER_SKIN, trail: j?.trail && itemById(j.trail) ? j.trail : STARTER_TRAIL };
}

export async function collectionOf(walletIn: string, now = Date.now(), s: Kv = kv()): Promise<Collection> {
  const w = lc(walletIn);
  const xp = await syncEarned(w, now, s);
  const [owned, crates, equipped, log] = await Promise.all([ownedItems(w, s), cratesOf(w, s), equippedOf(w, s), s.zrange(COLK.log(w), 10, true)]);
  return {
    wallet: w, owned: [...owned], crates, equipped, spendableXp: xp.spendableXp, prestige: xp.level.prestige,
    recent: log.map((m) => parse<Opened>(m)).filter((o): o is Opened => !!o),
  };
}

/* ---------------------------------------------------------------- writes ---------------------------------------------------------------- */

export type OpenResult = { ok: true; opened: Opened } | { ok: false; reason: string };

/** Open one crate: server random rarity + item from the live series, duplicates turn into XP, plus the crate's XP. */
export async function openCrate(walletIn: string, crateId: string, now = Date.now(), s: Kv = kv()): Promise<OpenResult> {
  const w = lc(walletIn);
  return withLock(w, s, async (): Promise<OpenResult> => {
    const raw = await s.zrange(COLK.crates(w), 200);
    const member = raw.find((m) => parse<Crate>(m)?.id === crateId);
    const crate = member ? parse<Crate>(member) : null;
    if (!member || !crate) return { ok: false, reason: "That crate is already open." };
    if (!(await s.zrem(COLK.crates(w), member))) return { ok: false, reason: "That crate is already open." };
    const item = rollCrate(crate.tier, dropPool(now), randomInt(0, 1_000_000) / 1_000_000, randomInt(0, 1_000_000) / 1_000_000);
    const owned = await ownedItems(w, s);
    const dupe = !!item && owned.has(item.id);
    if (item && !dupe) await s.sadd(COLK.own(w), item.id);
    const xp = CRATE[crate.tier].xp + (dupe && item ? DUPE_XP[item.rar] : 0);
    await award(w, { src: `crate:${crate.id}`, kind: "crate", xp, label: `${RARITY_NAME[crate.tier]} crate${dupe && item ? ` (${itemTitle(item)} again)` : ""}`, ts: now }, s);
    const opened: Opened = { crate, item, dupe, xp, at: now };
    await s.zadd(COLK.log(w), [{ score: now, member: JSON.stringify(opened) }]);
    return { ok: true, opened };
  }) as Promise<OpenResult>;
}

export type BuyResult = { ok: true; item: string; spendableXp: number; crate?: Crate } | { ok: false; reason: string };

/** Buy from today's shop with XP to spend (or the Common crate, always in stock). */
export async function buyItem(walletIn: string, id: string, now = Date.now(), s: Kv = kv()): Promise<BuyResult> {
  const w = lc(walletIn);
  const stock = shopStock(now);
  const isCrate = id === SHOP_CRATE_ID;
  const item: Item | undefined = isCrate ? undefined : [stock.featured, ...stock.daily].find((i) => i?.id === id) ?? undefined;
  if (!isCrate && !item) return { ok: false, reason: "That's not in the shop today." };
  const price = isCrate ? CRATE_PRICE : PRICE[item!.rar];
  if (!price) return { ok: false, reason: "That can't be bought." };
  return withLock(w, s, async (): Promise<BuyResult> => {
    if (item && (await ownedItems(w, s)).has(item.id)) return { ok: false, reason: "You already own that." };
    const t = totals(await ledgerOf(w, s));
    if (t.spendable < price) return { ok: false, reason: `You need ${(price - t.spendable).toLocaleString("en-US")} more XP.` };
    const src = isCrate ? `shopcrate:${randomUUID().slice(0, 12)}` : `skin:${item!.id}`;
    if (!(await award(w, { src, kind: "buy", xp: -price, label: isCrate ? "Common crate" : itemTitle(item!), ts: now }, s))) return { ok: false, reason: "You already own that." };
    if (item) { await s.sadd(COLK.own(w), item.id); return { ok: true, item: item.id, spendableXp: t.spendable - price }; }
    const c: Crate = { id: randomUUID().slice(0, 12), tier: "common", src, label: "Bought in the shop", at: now };
    await s.zadd(COLK.crates(w), [{ score: now, member: JSON.stringify(c) }]);
    return { ok: true, item: SHOP_CRATE_ID, spendableXp: t.spendable - price, crate: c };
  }) as Promise<BuyResult>;
}

export type EquipResult = { ok: true; equipped: Equipped } | { ok: false; reason: string };

/** Equip a skin + trail the pilot owns. Ring-tail skins need Prestige 1 and the same paint found on another hull. */
export async function equip(walletIn: string, skin: string, trail: string, s: Kv = kv()): Promise<EquipResult> {
  const w = lc(walletIn);
  const sk = itemById(skin), tr = itemById(trail);
  if (!sk || sk.kind !== "skin" || !tr || tr.kind !== "trail") return { ok: false, reason: "Pick a skin and a trail." };
  const owned = await ownedItems(w, s);
  if (sk.hull === PRESTIGE_HULL) {
    const xp = await xpSummary(w, Date.now(), s);
    if (xp.level.prestige < 1) return { ok: false, reason: "Ring-tail unlocks at Prestige 1." };
    if (![...owned].some((id) => id.endsWith(`--${sk.paint}`) && !id.startsWith(PRESTIGE_HULL))) return { ok: false, reason: `Find ${sk.name} on another hull first.` };
  } else if (!owned.has(sk.id)) return { ok: false, reason: "You haven't found that skin yet." };
  if (!owned.has(tr.id)) return { ok: false, reason: "You haven't found that trail yet." };
  const prev = parse<Record<string, unknown>>(await s.get(COLK.looks(w))) ?? {};
  await s.set(COLK.looks(w), JSON.stringify({ ...prev, skin: sk.id, trail: tr.id }));
  return { ok: true, equipped: { skin: sk.id, trail: tr.id } };
}

/** The engine's flame colour for a trail id. */
export const trailRgb = (id: string) => TRAILS.find((t) => trailId(t.id) === id)?.rgb ?? TRAILS[0].rgb;
