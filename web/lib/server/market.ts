import "server-only";
/**
 * Market and trade offers, server side (rules in lib/market.ts). Copies move between pilots inside Disciple's database;
 * each move is written to the copy's permanent record (lib/server/collection copyRecord), so a copy can become exactly one
 * token later with its whole history.
 *
 * KV keys (chain-namespaced, beside the collection's):
 *   mkt:<chain>:l:<id>        JSON Listing            one listing (kept after it sells or closes)
 *   mkt:<chain>:open          zset score=at, id       open listings
 *   mkt:<chain>:by:<wallet>   zset score=at, id       a seller's listings
 *   mkt:<chain>:sales:<item>  zset score=at, Sale     price history per item
 *   mkt:<chain>:sales         zset score=at, Sale     recent sales, every item
 *   mkt:<chain>:o:<id>        JSON Offer              one trade offer
 *   mkt:<chain>:offers:<w>    zset score=at, id       offers a pilot sent or got
 *   mkt:<chain>:hold:<id>     SET NX buyer            one buyer at a time while a payment is in flight
 *   mkt:<chain>:bought:<w>    zset score=at, id       listings a pilot bought (their Flight log)
 *   col:<chain>:listed:<uid>  listing id              (collection.ts) the copy is on the market
 *   col:<chain>:frozen:<uid>  reason                  (collection.ts) frozen by an admin
 *
 * Buying: the buyer signs ONE gasless USDG transfer (the same Permit2 withdraw the Cash panel uses): destination = the
 * seller, amount = price + network fee, fee = 7% + network fee, fee recipient = the relayer address. So the seller gets
 * exactly price - 7%, and the money never sits with Disciple. The copy moves only after the transfer is confirmed on chain.
 */
import { randomBytes } from "node:crypto";
import { ACTIVE_CHAIN, DEPLOYMENTS } from "@/lib/chains";
import { itemById, type Copy } from "@/lib/collection";
import {
  MAX_PRICE_CENTS, MIN_PRICE_CENTS, OFFER_MAX, OFFER_TTL_MS, cantMove, centsToRaw, marketFeeCents, sellerCents,
  type Listing, type MarketFilter, type Offer, type Sale,
} from "@/lib/market";
import { COLK, copyStore, wornCopies } from "./collection";
import { kv, type Kv } from "./kv";
import { usernameOf, walletOf } from "./usernames";
import { withLock } from "./xp";

const ns = () => `mkt:${ACTIVE_CHAIN.id}`;
export const MKT = {
  l: (id: string) => `${ns()}:l:${id}`,
  open: () => `${ns()}:open`,
  by: (w: string) => `${ns()}:by:${w}`,
  sales: (item?: string) => (item ? `${ns()}:sales:${item}` : `${ns()}:sales`),
  o: (id: string) => `${ns()}:o:${id}`,
  offers: (w: string) => `${ns()}:offers:${w}`,
  hold: (id: string) => `${ns()}:hold:${id}`,
  bought: (w: string) => `${ns()}:bought:${w}`,
};
const parse = <T,>(v: string | null): T | null => { if (!v) return null; try { return JSON.parse(v) as T; } catch { return null; } };
const lc = (w: string) => w.toLowerCase();
const newId = () => randomBytes(6).toString("hex");
type Fail = { ok: false; reason: string };
const fail = (reason: string): Fail => ({ ok: false, reason });
const isFail = (x: unknown): x is Fail => !!x && typeof x === "object" && (x as Fail).ok === false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run f holding both pilots' wallet locks (in address order, so two moves can't deadlock); retries while either is busy. */
async function withBoth<T>(a: string, b: string, s: Kv, f: () => Promise<T>, tries = 12): Promise<T | Fail> {
  const [x, y] = [lc(a), lc(b)].sort();
  for (let k = 0; k < tries; k++) {
    const r = await withLock(x, s, () => (x === y ? f() : withLock(y, s, f)));
    if (!(isFail(r) && r.reason === "Busy, try again.")) return r as T | Fail;
    await sleep(150 + k * 50);
  }
  return fail("Busy, try again.");
}

/** Why each of these copies (held by w) can't move, or null when they all can. */
async function checkMovable(w: string, inv: Copy[], uids: string[], s: Kv, o: { listing?: string } = {}): Promise<string | null> {
  const worn = new Set(Object.values(await wornCopies(w, inv, s)));
  for (const u of uids) {
    const c = inv.find((x) => x.uid === u);
    const [listed, frozen] = await Promise.all([s.get(COLK.listed(u)), s.get(COLK.frozen(u))]);
    const why = cantMove(c, { worn: worn.has(u), listed: !!listed && listed !== o.listing, frozen: !!frozen });
    if (why) return why;
  }
  return null;
}

/** Move copies from one inventory to another and write it into each copy's record. Call under both wallet locks. */
async function moveCopies(from: string, to: string, uids: string[], ev: { via: "trade" | "market"; offer?: string; listing?: string; price?: number; tx?: string }, now: number, s: Kv) {
  const src = await copyStore.invOf(from, now, s), dst = await copyStore.invOf(to, now, s);
  const moving = src.filter((c) => uids.includes(c.uid));
  await copyStore.writeInv(from, src.filter((c) => !uids.includes(c.uid)), s);
  await copyStore.writeInv(to, [...dst, ...moving], s);
  for (const c of moving) await copyStore.addEvent(c.uid, { ev: "moved", at: now, from, to, ...ev }, s);
}

/* ---------------------------------------------------------------- listings ---------------------------------------------------------------- */

export type ListResult = { ok: true; listing: Listing } | Fail;

/** Put one copy on the market for a price in cents. */
export async function listCopy(walletIn: string, uid: string, price: number, now = Date.now(), s: Kv = kv()): Promise<ListResult> {
  const w = lc(walletIn);
  if (!Number.isInteger(price) || price < MIN_PRICE_CENTS || price > MAX_PRICE_CENTS) return fail(`Pick a price from $${MIN_PRICE_CENTS / 100} to $${(MAX_PRICE_CENTS / 100).toLocaleString("en-US")}.`);
  const r = await withLock(w, s, async (): Promise<ListResult> => {
    const inv = await copyStore.invOf(w, now, s);
    const why = await checkMovable(w, inv, [uid], s);
    if (why) return fail(why);
    const c = inv.find((x) => x.uid === uid)!;
    const l: Listing = { id: newId(), uid, item: c.item, seller: w, price, at: now, state: "open" };
    if (!(await s.setNX(COLK.listed(uid), l.id))) return fail("It's already on the market.");
    await s.set(MKT.l(l.id), JSON.stringify(l));
    await s.zadd(MKT.open(), [{ score: now, member: l.id }]);
    await s.zadd(MKT.by(w), [{ score: now, member: l.id }]);
    return { ok: true, listing: l };
  });
  return r as ListResult;
}

async function readListing(id: string, s: Kv) { return /^[a-f0-9]{12}$/.test(id) ? parse<Listing>(await s.get(MKT.l(id))) : null; }
async function closeListing(l: Listing, state: "sold" | "closed", s: Kv, extra: Partial<Listing> = {}) {
  const done: Listing = { ...l, ...extra, state };
  await s.set(MKT.l(l.id), JSON.stringify(done));
  await s.zrem(MKT.open(), l.id);
  await s.delIfEq(COLK.listed(l.uid), l.id);
  return done;
}

/** Take your own listing off the market (not while a buyer's payment is in flight). */
export async function unlist(walletIn: string, id: string, s: Kv = kv()): Promise<{ ok: true } | Fail> {
  const w = lc(walletIn);
  // under the seller's lock, like buy admission: either the buyer marks it pending first and this refuses, or this closes it
  // first and the buyer's re-read sees it gone, so a paid-for copy is never released
  const r = await withLock(w, s, async (): Promise<{ ok: true } | Fail> => {
    const l = await readListing(id, s);
    if (!l || l.seller !== w) return fail("That isn't your listing.");
    if (l.state !== "open") return fail(l.state === "pending" ? "Someone is buying it right now." : "That listing is already closed.");
    if (await s.get(MKT.hold(id))) return fail("Someone is buying it right now.");
    await closeListing(l, "closed", s);
    return { ok: true };
  });
  return r;
}

/** Open listings, with each copy as it is now and the seller's name. Frozen copies and stale listings are left out. */
export async function listings(f: MarketFilter = {}, s: Kv = kv()): Promise<Listing[]> {
  const ids = await s.zrange(MKT.open(), 500, true);
  const rows = (ids.length ? await s.mget(ids.map(MKT.l)) : []).map((v) => parse<Listing>(v)).filter((l): l is Listing => !!l && l.state === "open");
  const out: Listing[] = [];
  for (const l of rows) {
    const it = itemById(l.item);
    if (!it) continue;
    if (f.item && l.item !== f.item) continue;
    if (f.kind && it.kind !== f.kind) continue;
    if (f.rar && it.rar !== f.rar) continue;
    if (f.series != null && it.series !== f.series) continue;
    out.push(l);
  }
  const full = await Promise.all(out.map((l) => withCopy(l, s)));
  let res = full.filter((l): l is Listing => !!l && (!f.trak || l.copy?.trak != null));
  const by = f.sort ?? "new";
  res = res.sort((a, b) => by === "price-asc" ? a.price - b.price : by === "price-desc" ? b.price - a.price : by === "burn-asc" ? (a.copy!.burn - b.copy!.burn) : b.at - a.at);
  return res.slice(0, Math.min(200, f.limit ?? 120));
}
async function withCopy(l: Listing, s: Kv): Promise<Listing | null> {
  const [rec, frozen, name] = await Promise.all([s.get(COLK.copy(l.uid)), s.get(COLK.frozen(l.uid)), usernameOf(l.seller).catch(() => null)]);
  const r = parse<{ copy: Copy; owner: string; burned: boolean }>(rec);
  if (frozen || !r || r.burned || r.owner !== l.seller) return null;
  return { ...l, copy: r.copy, sellerName: name };
}

/** One listing (any state), with its copy. */
export async function listingById(id: string, s: Kv = kv()): Promise<Listing | null> {
  const l = await readListing(id, s);
  if (!l) return null;
  const rec = parse<{ copy: Copy }>(await s.get(COLK.copy(l.uid)));
  return { ...l, copy: rec?.copy, sellerName: await usernameOf(l.seller).catch(() => null) };
}
export async function myListings(walletIn: string, s: Kv = kv()): Promise<Listing[]> {
  const ids = await s.zrange(MKT.by(lc(walletIn)), 100, true);
  const rows = (ids.length ? await s.mget(ids.map(MKT.l)) : []).map((v) => parse<Listing>(v)).filter((l): l is Listing => !!l);
  return Promise.all(rows.map(async (l) => ({ ...l, copy: parse<{ copy: Copy }>(await s.get(COLK.copy(l.uid)))?.copy })));
}
export async function salesOf(item?: string, limit = 50, s: Kv = kv()): Promise<Sale[]> {
  return (await s.zrange(MKT.sales(item), limit, true)).map((m) => parse<Sale>(m)).filter((x): x is Sale => !!x);
}

/* ----------------------------------------------------------------- buying ----------------------------------------------------------------- */

/** What the buyer signs for: the seller gets sellerRaw (price - 7%) plus nothing else; the 7% (feeRaw) goes to the treasury. */
export interface BuyTerms { listing: string; seller: string; price: number; fee: number; sellerGets: number; priceRaw: string; feeRaw: string; sellerRaw: string; decimals: number }
export async function buyTerms(id: string, s: Kv = kv()): Promise<BuyTerms | Fail> {
  const l = await readListing(id, s);
  if (!l || l.state !== "open") return fail("That listing is gone.");
  const d = DEPLOYMENTS[ACTIVE_CHAIN.id]?.usdgDecimals ?? 6;
  const fee = marketFeeCents(l.price);
  return {
    listing: l.id, seller: l.seller, price: l.price, fee, sellerGets: sellerCents(l.price), decimals: d,
    priceRaw: centsToRaw(l.price, d).toString(), feeRaw: centsToRaw(fee, d).toString(), sellerRaw: centsToRaw(sellerCents(l.price), d).toString(),
  };
}

/** The slice of a signed gasless withdraw the market checks (lib/trade/gaslessWithdraw ForwarderWithdrawRequest). */
export interface PayRequest { signer: string; destination: string; amount: bigint; fee: bigint }
/** A buy is two withdraws sent together: pay (seller's share + network fee) and cut (the 7%, to the treasury, no fee). */
export interface BuyRequest { pay: PayRequest; cut: PayRequest }
export interface RelayOutcome { success: boolean; txHash?: string }
export interface BuyDeps {
  /** parse the raw signed pair (lib/server/gaslessWithdrawRelay parseMarketBuyRequest) */
  parse: (raw: unknown) => BuyRequest;
  /** where the 7% goes; null ⇒ buying is off */
  treasury: () => string | null;
  /** today's network fee for both transfers, raw USDG */
  networkFee: (signer: string) => Promise<bigint>;
  /** submit both in one tx (lib/server/gaslessWithdrawRelay relayMarketBuy). Throws with notSent: true when nothing was sent. */
  relay: (raw: unknown) => Promise<RelayOutcome>;
}
export type BuyResult = { ok: true; listing: Listing; tx?: string } | { ok: false; reason: string; pending?: boolean };

/**
 * Buy a listing with two signed USDG transfers sent in one tx. One buyer at a time (hold). pay must give the seller exactly
 * the price minus 7% and cover today's network fee; cut must send exactly the 7% to the treasury. The copy moves only once
 * the payment is confirmed.
 */
export async function buyListing(buyerIn: string, id: string, raw: unknown, deps: BuyDeps, now = Date.now(), s: Kv = kv()): Promise<BuyResult> {
  const buyer = lc(buyerIn);
  const l = await readListing(id, s);
  if (!l || l.state !== "open") return fail("That listing is gone.");
  if (l.seller === buyer) return fail("That's your own listing.");
  if (await s.get(COLK.frozen(l.uid))) return fail("That copy is frozen while we look into it.");
  const treasury = deps.treasury();
  if (!treasury) return fail("Buying is switched off right now. Try again later.");
  let q: BuyRequest;
  try { q = deps.parse(raw); } catch { return fail("That payment didn't read right. Try again."); }
  const t = await buyTerms(id, s);
  if (isFail(t)) return t;
  if (lc(q.pay.signer) !== buyer || lc(q.cut.signer) !== buyer) return fail("Pay from the wallet you're signed in with.");
  if (lc(q.pay.destination) !== l.seller) return fail("That payment isn't to the seller.");
  if (lc(q.cut.destination) !== lc(treasury)) return fail("That payment doesn't match the price. Try again.");
  const sellerRaw = BigInt(t.sellerRaw), feeRaw = BigInt(t.feeRaw);
  if (q.pay.amount - q.pay.fee !== sellerRaw) return fail("That payment doesn't match the price. Try again.");
  if (q.cut.amount !== feeRaw || q.cut.fee !== BigInt(0)) return fail("That payment doesn't match the price. Try again.");
  const net = await deps.networkFee(buyer);
  if (q.pay.fee < net) return fail("The network fee changed. Try again.");

  // one buyer at a time: the hold outlives a slow relay, and the listing shows as pending so the seller can't pull it
  if (!(await s.setNX(MKT.hold(id), buyer, 600))) return fail("Someone else is buying it right now.");
  const pend = await withLock(l.seller, s, async () => {
    const cur = await readListing(id, s);
    if (!cur || cur.state !== "open") return fail("That listing is gone.");
    const inv = await copyStore.invOf(l.seller, now, s);
    if (!inv.some((c) => c.uid === l.uid)) return fail("The seller doesn't have it any more.");
    await s.set(MKT.l(id), JSON.stringify({ ...cur, state: "pending", buyer }));
    return { ok: true as const };
  });
  if (isFail(pend)) { await s.delIfEq(MKT.hold(id), buyer); return pend; }

  let res: RelayOutcome;
  try { res = await deps.relay(raw); }
  catch (e) {
    if ((e as { notSent?: boolean }).notSent) {
      await reopen(id, buyer, s);
      return fail((e as Error).message ? `Payment wasn't sent: ${(e as Error).message}` : "Payment wasn't sent. Try again.");
    }
    // sent (or maybe sent) but no answer: keep it pending; an admin settles it from the transfer on chain
    console.error("[market] buy outcome unknown", { id, buyer });
    return { ok: false, reason: "We're still confirming your payment. Check back in a minute.", pending: true };
  }
  if (!res.success) { await reopen(id, buyer, s); return fail("The payment didn't go through, so nothing was charged. Try again."); }
  const done = await settleSale(id, buyer, res.txHash, now, s);
  return isFail(done) ? { ...done, pending: true } : { ok: true, listing: done, tx: res.txHash };
}
async function reopen(id: string, buyer: string, s: Kv) {
  const cur = await readListing(id, s);
  if (cur && cur.state === "pending" && cur.buyer === buyer) { const { buyer: _b, ...rest } = cur; void _b; await s.set(MKT.l(id), JSON.stringify({ ...rest, state: "open" })); }
  await s.delIfEq(MKT.hold(id), buyer);
}

/** The payment landed: move the copy to the buyer, close the listing, record the sale. Also used by an admin to settle. */
export async function settleSale(id: string, buyerIn: string, tx: string | undefined, now = Date.now(), s: Kv = kv()): Promise<Listing | Fail> {
  const buyer = lc(buyerIn);
  const l = await readListing(id, s);
  if (!l) return fail("No such listing.");
  if (l.state === "sold") return l;
  const r = await withBoth(l.seller, buyer, s, async () => {
    const inv = await copyStore.invOf(l.seller, now, s);
    const c = inv.find((x) => x.uid === l.uid);
    if (!c) return fail("The seller doesn't have it any more.");
    await moveCopies(l.seller, buyer, [l.uid], { via: "market", listing: l.id, price: l.price, ...(tx ? { tx } : {}) }, now, s);
    const done = await closeListing(l, "sold", s, { buyer, soldAt: now, ...(tx ? { tx } : {}) });
    const sale: Sale = { listing: l.id, uid: l.uid, item: l.item, serial: c.serial, burn: c.burn, price: l.price, at: now };
    await s.zadd(MKT.sales(l.item), [{ score: now, member: JSON.stringify(sale) }]);
    await s.zadd(MKT.sales(), [{ score: now, member: JSON.stringify(sale) }]);
    await s.zadd(MKT.bought(buyer), [{ score: now, member: l.id }]);
    return done;
  });
  await s.delIfEq(MKT.hold(id), buyer);
  if (isFail(r)) console.error("[market] paid but not settled", { id, buyer, reason: r.reason });
  else await notifySold(r, s).catch((e) => console.error("[market] sold push", e));
  return r;
}

/** Tell the seller their item sold (push alert, kind "market"; the sale also lands in their Flight log). */
async function notifySold(l: Listing, s: Kv) {
  const { notify } = await import("./push");
  const { pushCopy } = await import("@/lib/push");
  const name = itemById(l.item)?.name ?? "Your item";
  await notify(l.seller, "market", `sold:${l.id}`, { ...pushCopy.sold(name, sellerCents(l.price)), url: "/profile#hg-log" }, Date.now(), s);
}

/* --------------------------------------------------------------- trade offers --------------------------------------------------------------- */

/** A wallet from "0x…", "@name" or "name". */
export async function resolvePilot(v: string): Promise<string | null> {
  const t = v.trim().replace(/^@/, "");
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) return lc(t);
  if (!/^[A-Za-z0-9_]{2,24}$/.test(t)) return null;
  const w = await walletOf(t.toLowerCase()).catch(() => null) ?? await walletOf(t).catch(() => null);
  return w ? lc(w) : null;
}

export type OfferResult = { ok: true; offer: Offer } | Fail;

/** Offer some of your copies for some of theirs (either side can be empty, not both). */
export async function makeOffer(fromIn: string, toIn: string, give: string[], want: string[], now = Date.now(), s: Kv = kv()): Promise<OfferResult> {
  const from = lc(fromIn), to = await resolvePilot(toIn);
  if (!to) return fail("We couldn't find that pilot.");
  if (to === from) return fail("You can't trade with yourself.");
  give = [...new Set(give)]; want = [...new Set(want)];
  if (!give.length && !want.length) return fail("Pick at least one copy.");
  if (give.length > OFFER_MAX || want.length > OFFER_MAX) return fail(`Up to ${OFFER_MAX} copies a side.`);
  // both inventories are read (and, for a legacy collection, migrated) under both wallet locks, so two offers at once
  // can't each mint a set of copies from the same legacy items
  const r = await withBoth(from, to, s, async (): Promise<OfferResult> => {
    const mine = await copyStore.invOf(from, now, s), theirs = await copyStore.invOf(to, now, s);
    const a = await checkMovable(from, mine, give, s); if (a) return fail(a);
    for (const u of want) { const c = theirs.find((x) => x.uid === u); const why = cantMove(c, { frozen: !!(await s.get(COLK.frozen(u))) }); if (why) return fail(why === "That copy isn't there any more." ? "They don't have one of those copies." : why); }
    const o: Offer = { id: newId(), from, to, give, want, at: now, state: "open" };
    await s.set(MKT.o(o.id), JSON.stringify(o));
    await s.zadd(MKT.offers(from), [{ score: now, member: o.id }]);
    await s.zadd(MKT.offers(to), [{ score: now, member: o.id }]);
    return { ok: true, offer: o };
  });
  return r;
}

async function readOffer(id: string, s: Kv) { return /^[a-f0-9]{12}$/.test(id) ? parse<Offer>(await s.get(MKT.o(id))) : null; }
async function endOffer(o: Offer, state: Offer["state"], now: number, s: Kv, note?: string) {
  const done: Offer = { ...o, state, doneAt: now, ...(note ? { note } : {}) };
  await s.set(MKT.o(o.id), JSON.stringify(done));
  return done;
}

/** Accept (the pilot it was sent to), decline (them) or cancel (the sender). Accepting swaps both sides at once. */
export async function answerOffer(walletIn: string, id: string, op: "accept" | "decline" | "cancel", now = Date.now(), s: Kv = kv()): Promise<OfferResult> {
  const w = lc(walletIn), o = await readOffer(id, s);
  if (!o || (o.from !== w && o.to !== w)) return fail("That offer isn't yours.");
  if (o.state !== "open") return fail("That offer is already closed.");
  if (now - o.at > OFFER_TTL_MS) return { ok: true, offer: await endOffer(o, "expired", now, s) };
  if (op === "cancel") return o.from === w ? { ok: true, offer: await endOffer(o, "cancelled", now, s) } : fail("Only the pilot who sent it can cancel it.");
  if (o.to !== w) return fail("Only the pilot it was sent to can answer it.");
  if (op === "decline") return { ok: true, offer: await endOffer(o, "declined", now, s) };
  const r = await withBoth(o.from, o.to, s, async (): Promise<OfferResult> => {
    const cur = await readOffer(id, s);
    if (!cur || cur.state !== "open") return fail("That offer is already closed.");
    const a = await checkMovable(o.from, await copyStore.invOf(o.from, now, s), o.give, s);
    if (a) return { ok: false, reason: `It can't go through: ${a.charAt(0).toLowerCase()}${a.slice(1)}` };
    const b = await checkMovable(o.to, await copyStore.invOf(o.to, now, s), o.want, s);
    if (b) return { ok: false, reason: `It can't go through: ${b.charAt(0).toLowerCase()}${b.slice(1)}` };
    if (o.give.length) await moveCopies(o.from, o.to, o.give, { via: "trade", offer: o.id }, now, s);
    if (o.want.length) await moveCopies(o.to, o.from, o.want, { via: "trade", offer: o.id }, now, s);
    return { ok: true, offer: await endOffer(cur, "accepted", now, s) };
  });
  return r as OfferResult;
}

/** A pilot's offers, newest first, with the copies filled in. Open offers past a week show as expired. */
export async function offersOf(walletIn: string, now = Date.now(), s: Kv = kv()): Promise<Offer[]> {
  const w = lc(walletIn);
  const ids = await s.zrange(MKT.offers(w), 60, true);
  const rows = (ids.length ? await s.mget(ids.map(MKT.o)) : []).map((v) => parse<Offer>(v)).filter((o): o is Offer => !!o);
  const rec = async (u: string) => parse<{ copy: Copy }>(await s.get(COLK.copy(u)))?.copy;
  return Promise.all(rows.map(async (o) => ({
    ...o, state: o.state === "open" && now - o.at > OFFER_TTL_MS ? "expired" as const : o.state,
    giveCopies: (await Promise.all(o.give.map(rec))).filter((c): c is Copy => !!c),
    wantCopies: (await Promise.all(o.want.map(rec))).filter((c): c is Copy => !!c),
    fromName: await usernameOf(o.from).catch(() => null), toName: await usernameOf(o.to).catch(() => null),
  })));
}

/* ------------------------------------------------------------------ admin ------------------------------------------------------------------ */

/** Freeze a copy (reported stolen or farmed): it can't be listed, bought or traded, and its open listing comes down. */
export async function freezeCopy(uid: string, reason: string, s: Kv = kv()) {
  if (!/^[a-f0-9]{16}$/.test(uid)) return fail("That isn't a copy id.");
  await s.set(COLK.frozen(uid), reason.slice(0, 200) || "frozen");
  const lid = await s.get(COLK.listed(uid));
  if (lid) { const l = await readListing(lid, s); if (l && l.state === "open") await closeListing(l, "closed", s); }
  return { ok: true as const };
}
export async function unfreezeCopy(uid: string, s: Kv = kv()) { await s.del(COLK.frozen(uid)); return { ok: true as const }; }
