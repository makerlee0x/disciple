import "server-only";
/**
 * A Disciple player on Lighter: set-up steps and market orders. The player's wallet (their Privy address) owns their
 * Lighter account; Disciple holds a trading key for it (./keys.ts) and signs orders server-side, so a duel never shows a
 * wallet popup mid-match.
 *
 * Set-up, in order (status() says which step is next):
 *   1. deposit   the player funds Lighter once; that creates their Lighter account
 *   2. key       Disciple makes a trading key; the player's wallet signs Lighter's "Register Lighter Account" message once
 *   3. tier      the account moves to Plus (0.5 bp a side; needed for a partner fee)
 *   4. approve   the player's wallet signs Lighter's "Approve Integrator" message once: Disciple's partner fee, capped
 *   then ready.
 */
import { recoverMessageAddress, type Hex } from "viem";
import { clientOrderIndex, baseAmountFor, levFraction, worstPrice } from "@/lib/lighter/math";
import { LIGHTER_MARKETS, type LighterConfig, type LighterMarket } from "./config";
import { getPlayer, putPlayer, seal, open, type LighterPlayer } from "./keys";
import { account, accountIndexOf, book, fillFrom, midOf, type Book, changeTier, marketBySymbol, nextNonce, sendTx, LighterError, type LighterPosition } from "./rest";
import { checked, signer, signerFor } from "./signer";

export type Step = "deposit" | "key" | "tier" | "approve" | "ready";
const APPROVAL_DAYS = 365;

export async function status(cfg: LighterConfig, pid: string): Promise<{ step: Step; account: number | null; collateral?: string; positions?: LighterPosition[]; lookup?: string[] }> {
  const p = await getPlayer(cfg, pid);
  const trace: string[] = [];
  const acct = p?.account ?? (await accountIndexOf(cfg, pid, trace));
  if (acct == null) return { step: "deposit", account: null, lookup: trace };
  const a = await account(cfg, acct).catch(() => null);
  const base = { account: acct, collateral: a?.collateral, positions: (a?.positions ?? []).filter((x) => Number(x.position) !== 0) };
  if (!p?.keyReady) return { step: "key", ...base };
  if (p.tier !== cfg.tier) return { step: "tier", ...base };
  if (cfg.partnerFee && !(p.approvedFee && p.approvedFee >= cfg.partnerFee && (p.approvedExpiry ?? 0) > Date.now())) return { step: "approve", ...base };
  return { step: "ready", ...base };
}

/** Step 2a: make a trading key and hand back Lighter's message for the player's wallet to sign. */
export async function startKey(cfg: LighterConfig, pid: string): Promise<{ message: string }> {
  const acct = await accountIndexOf(cfg, pid);
  if (acct == null) throw new LighterError(409, "Add cash to Lighter first.");
  const w = await signer();
  const key = w.GenerateAPIKey(); if (key.error) throw new Error(key.error);
  await signerFor(key.privateKey, cfg.chainId, cfg.apiKeyIndex, acct);
  const nonce = await nextNonce(cfg, acct, cfg.apiKeyIndex);
  const r = checked(w.SignChangePubKey(key.publicKey, 0, nonce, cfg.apiKeyIndex, acct));
  if (!r.messageToSign) throw new Error("lighter: no message to sign");
  const prev = await getPlayer(cfg, pid);
  const p: LighterPlayer = { ...(prev ?? {}), account: acct, keyIndex: cfg.apiKeyIndex, pub: key.publicKey, enc: seal(cfg.keySecret, key.privateKey), keyReady: false,
    pending: { kind: "key", txType: r.txType, txInfo: r.txInfo, message: r.messageToSign, at: Date.now() } };
  await putPlayer(cfg, pid, p);
  return { message: r.messageToSign };
}

/** Steps 2b / 4b: the player's wallet signature on the pending message → send it to Lighter. */
export async function finishSigned(cfg: LighterConfig, pid: string, kind: "key" | "approve", sig: string) {
  const p = await getPlayer(cfg, pid);
  const pend = p?.pending;
  if (!p || !pend || pend.kind !== kind || Date.now() - pend.at > 10 * 60_000) throw new LighterError(409, "That request expired. Start again.");
  const who = await recoverMessageAddress({ message: pend.message, signature: sig as Hex }).catch(() => null);
  if (!who || who.toLowerCase() !== pid.toLowerCase()) throw new LighterError(403, "That signature isn't from your wallet.");
  const txInfo = JSON.stringify({ ...JSON.parse(pend.txInfo), L1Sig: sig });
  const hash = await sendTx(cfg, pend.txType, txInfo);
  if (kind === "key") Object.assign(p, { keyReady: true });
  else Object.assign(p, { approvedFee: cfg.partnerFee, approvedExpiry: Date.now() + APPROVAL_DAYS * 86_400_000 });
  delete p.pending;
  await putPlayer(cfg, pid, p);
  forget(cfg, pid);
  return { hash };
}

async function keyed(cfg: LighterConfig, pid: string) {
  const p = await getPlayer(cfg, pid);
  if (!p?.keyReady) throw new LighterError(409, "Finish Lighter set-up first.");
  const w = await signerFor(open(cfg.keySecret, p.enc), cfg.chainId, p.keyIndex, p.account);
  return { p, w, nonce: () => nextNonce(cfg, p.account, p.keyIndex) };
}

/** Step 3: move the account to Plus (signed with the trading key; no wallet popup). */
export async function setTier(cfg: LighterConfig, pid: string) {
  const { p, w } = await keyed(cfg, pid);
  const tok = w.CreateAuthToken(Math.floor(Date.now() / 1000) + 600, p.keyIndex, p.account);
  if (!tok.authToken) throw new Error(`lighter auth: ${tok.error}`);
  await changeTier(cfg, p.account, cfg.tier, tok.authToken);
  await putPlayer(cfg, pid, { ...p, tier: cfg.tier });
  forget(cfg, pid);
}

/** Step 4a: Disciple's partner fee approval; the player's wallet must sign it (Lighter requires an L1 signature). */
export async function startApprove(cfg: LighterConfig, pid: string): Promise<{ message: string }> {
  if (!cfg.partnerFee) throw new LighterError(409, "No partner fee is set.");
  const { p, w, nonce } = await keyed(cfg, pid);
  const r = checked(w.SignApproveIntegrator(cfg.integratorIndex, cfg.partnerFee, 0, 0, 0, Date.now() + APPROVAL_DAYS * 86_400_000, 0, await nonce(), p.keyIndex, p.account));
  if (!r.messageToSign) throw new Error("lighter: no approve message");
  await putPlayer(cfg, pid, { ...p, pending: { kind: "approve", txType: r.txType, txInfo: r.txInfo, message: r.messageToSign, at: Date.now() } });
  return { message: r.messageToSign };
}

/** Per-instance hot cache so a tap costs one signed send: the player's record, their nonce counter. Lighter rejects a
 *  wrong nonce, so on any send error we drop the counter and the next tap re-reads it. */
type Hot = { p: LighterPlayer; at: number; nonce?: number; pos?: Record<number, { sign: number; base: number; at: number }> };
const hot = new Map<string, Hot>();
const HOT_MS = 10 * 60_000;
function forget(cfg: LighterConfig, pid: string) { hot.delete(`${cfg.network}:${pid}`); }
/** Loads the player, signer, key and market list into this instance ahead of a duel, so the first tap is warm. */
export async function warm(cfg: LighterConfig, pid: string) {
  const [h, mk] = await Promise.all([hotPlayer(cfg, pid), marketBySymbol(cfg, "BTC").catch(() => null)]);
  await signerFor(keyOf(cfg, h.p), cfg.chainId, h.p.keyIndex, h.p.account);
  // also keeps the pooled connection to Lighter open; a duel calls this every few seconds as a heartbeat
  await Promise.all([h.nonce == null ? takeNonce(cfg, h, 0) : null, mk ? refreshBook(cfg, mk.market_id).catch(() => null) : null]);
}
async function hotPlayer(cfg: LighterConfig, pid: string) {
  const k = `${cfg.network}:${pid}`;
  const h = hot.get(k);
  if (h && Date.now() - h.at < HOT_MS) return h;
  const p = await getPlayer(cfg, pid);
  if (!p?.keyReady) throw new LighterError(409, "Finish Lighter set-up first.");
  const fresh = { p, at: Date.now() };
  hot.set(k, fresh);
  if (hot.size > 2000) hot.delete(hot.keys().next().value as string);
  return fresh as Hot;
}
const privKeys = new Map<string, string>();
function keyOf(cfg: LighterConfig, p: LighterPlayer) {
  let k = privKeys.get(p.pub); if (!k) { k = open(cfg.keySecret, p.enc); privKeys.set(p.pub, k); } return k;
}
async function takeNonce(cfg: LighterConfig, h: { p: LighterPlayer; nonce?: number }, count = 1) {
  const n = h.nonce ?? (await nextNonce(cfg, h.p.account, h.p.keyIndex));
  h.nonce = n + count;
  return n;
}
async function send(cfg: LighterConfig, h: { nonce?: number }, txType: number, txInfo: string) {
  try { return await sendTx(cfg, txType, txInfo); } catch (e) { h.nonce = undefined; throw e; }
}
export type Timings = Record<string, number>;
const lap = (t: Timings, k: string, t0: number) => { t[k] = Math.round(performance.now() - t0); };

/** Last order book per market in this instance. A tap prices off a book under BOOK_MS old and refreshes it alongside
 *  its send, so the hot path is one round trip; the duel's heartbeat (warm) keeps it fresh between taps. */
const books = new Map<string, { b: Book; at: number }>();
const BOOK_MS = 5_000;
async function bookFor(cfg: LighterConfig, marketId: number, t: Timings) {
  const k = `${cfg.network}:${marketId}`;
  const c = books.get(k);
  if (c && Date.now() - c.at < BOOK_MS) { t.book = 0; return c.b; }
  const t0 = performance.now();
  const b = await refreshBook(cfg, marketId);
  lap(t, "book", t0);
  return b;
}
async function refreshBook(cfg: LighterConfig, marketId: number) {
  const b = await book(cfg, marketId);
  books.set(`${cfg.network}:${marketId}`, { b, at: Date.now() });
  return b;
}
/** Sends a signed tx; on a nonce clash (another server instance moved it) re-reads the nonce, re-signs once, resends. */
async function sendSigned(cfg: LighterConfig, h: { p: LighterPlayer; nonce?: number }, sign: (n: number) => { txType: number; txInfo: string }, n: number) {
  const r = sign(n);
  try { return await sendTx(cfg, r.txType, r.txInfo); }
  catch (e) {
    h.nonce = undefined;
    if (!(e instanceof LighterError) || !/nonce/i.test(e.message)) throw e;
    const n2 = await takeNonce(cfg, h);
    const r2 = sign(n2);
    return await sendTx(cfg, r2.txType, r2.txInfo);
  }
}

/** Market order for $ fuel × leverage: warm, it's one signed send (book and nonce come from this instance's cache).
 *  Sets the market's leverage on Lighter first, once per player per market. */
export async function openMarket(cfg: LighterConfig, pid: string, m: LighterMarket, side: "long" | "short", fuelUsd: number) {
  const t: Timings = {}; const t0 = performance.now();
  const { symbol, lev } = LIGHTER_MARKETS[m];
  const [h, mk] = await Promise.all([hotPlayer(cfg, pid), marketBySymbol(cfg, symbol)]);
  const p = h.p;
  const w = await signerFor(keyOf(cfg, p), cfg.chainId, p.keyIndex, p.account);
  const needLev = p.lev?.[mk.market_id] !== lev;
  const [b, n0] = await Promise.all([bookFor(cfg, mk.market_id, t), takeNonce(cfg, h, needLev ? 2 : 1)]);
  lap(t, "read", t0);
  let n = n0;
  if (needLev) {
    const r = checked(w.SignUpdateLeverage(mk.market_id, levFraction(lev), 0, 0, n++, p.keyIndex, p.account));
    await send(cfg, h, r.txType, r.txInfo);
    p.lev = { ...(p.lev ?? {}), [mk.market_id]: lev }; void putPlayer(cfg, pid, p).catch(() => {});
    lap(t, "leverage", t0);
  }
  const isAsk = side === "short";
  const ref = midOf(b);
  if (!ref) throw new LighterError(409, "Lighter's book is empty right now.");
  const base = baseAmountFor(fuelUsd * lev, ref, mk.size_decimals);
  if (base < Math.round(Number(mk.min_base_amount) * 10 ** mk.size_decimals)) throw new LighterError(400, "That trade is under Lighter's minimum size.");
  const fill = fillFrom(b, isAsk, base, mk.size_decimals);
  if (fill == null) throw new LighterError(409, "Not enough on Lighter's book for that size.");
  const fee = p.approvedFee && cfg.partnerFee ? cfg.partnerFee : 0;
  const cap = worstPrice(fill, isAsk, cfg.slippage, mk.price_decimals);
  const t1 = performance.now();
  const [hash] = await Promise.all([
    sendSigned(cfg, h, (nn) => checked(w.SignCreateOrder(mk.market_id, clientOrderIndex(), base, cap, isAsk ? 1 : 0,
      1 /* market */, 0 /* IOC */, 0, 0, 0, fee ? cfg.integratorIndex : 0, fee, 0, 0, 0, 0, nn, p.keyIndex, p.account)), n),
    refreshBook(cfg, mk.market_id).catch(() => null), // for the next tap; runs alongside the send
  ]);
  lap(t, "send", t1); lap(t, "server", t0);
  // what this instance believes is open, so a close needn't read the account first
  const pos = h.pos?.[mk.market_id];
  const signed = (pos ? pos.sign * pos.base : 0) + (isAsk ? -base : base);
  h.pos = { ...(h.pos ?? {}), [mk.market_id]: { sign: Math.sign(signed) || 1, base: Math.abs(signed), at: Date.now() } };
  return { hash, market: mk.market_id, base, price: ref, fill, lev, ms: t };
}

/** Closes the whole position on a market (reduce-only market order). Uses this instance's record of the open when it
 *  has one (reduce-only means Lighter never flips us if it's off), else reads the account. */
export async function closeMarket(cfg: LighterConfig, pid: string, m: LighterMarket) {
  const t: Timings = {}; const t0 = performance.now();
  const [h, mk] = await Promise.all([hotPlayer(cfg, pid), marketBySymbol(cfg, LIGHTER_MARKETS[m].symbol)]);
  const p = h.p;
  const w = await signerFor(keyOf(cfg, p), cfg.chainId, p.keyIndex, p.account);
  const known = h.pos?.[mk.market_id];
  const [pos, b, n] = await Promise.all([
    known && known.base > 0 && Date.now() - known.at < HOT_MS ? Promise.resolve(known)
      : account(cfg, p.account).then((a) => {
        const x = a?.positions.find((q) => q.market_id === mk.market_id && Number(q.position) !== 0);
        return x ? { sign: x.sign, base: Math.round(Math.abs(Number(x.position)) * 10 ** mk.size_decimals), at: Date.now() } : null;
      }),
    bookFor(cfg, mk.market_id, t), takeNonce(cfg, h)]);
  lap(t, "read", t0);
  if (!pos) { h.nonce = undefined; throw new LighterError(409, "Nothing open."); }
  const isAsk = pos.sign > 0; // close a long by selling
  const fill = fillFrom(b, isAsk, pos.base, mk.size_decimals) ?? midOf(b);
  const fee = p.approvedFee && cfg.partnerFee ? cfg.partnerFee : 0;
  const cap = worstPrice(fill, isAsk, cfg.slippage, mk.price_decimals);
  const t1 = performance.now();
  const [hash] = await Promise.all([
    sendSigned(cfg, h, (nn) => checked(w.SignCreateOrder(mk.market_id, clientOrderIndex(), pos.base, cap, isAsk ? 1 : 0,
      1, 0, 1 /* reduce only */, 0, 0, fee ? cfg.integratorIndex : 0, fee, 0, 0, 0, 0, nn, p.keyIndex, p.account)), n),
    refreshBook(cfg, mk.market_id).catch(() => null),
  ]);
  lap(t, "send", t1); lap(t, "server", t0);
  if (h.pos) delete h.pos[mk.market_id];
  return { hash, market: mk.market_id, base: pos.base, price: fill, ms: t };
}

/**
 * Pre-signed tap orders. The server signs the player's next long, short and close ahead of time, all at the same nonce
 * (so only one of them can ever go through), each with a tight price cap, Disciple's fee and a short expiry. The browser
 * holds the set and a tap sends one straight to Lighter: no trip through Disciple's server on the tap. The trading key
 * never leaves the server. After a tap the browser asks for the next set, telling us which order it used.
 */
export const TICKET_TTL_MS = 15_000;
type Signed = { txType: number; txInfo: string; cap: number; base: number };
/** `opens[i]` is the long and short for `sizes[i]` dollars of fuel (null when that size is under Lighter's minimum);
 *  `long` / `short` are opens[0], for callers with one size. */
export type Ticket = {
  url: string; nonce: number; exp: number; market: number; lev: number; mid: number;
  opens: ({ usd: number; long: Signed; short: Signed } | null)[];
  long?: Signed; short?: Signed; close?: Signed & { side: "long" | "short" };
};
type Issued = { nonce: number; market: number; bases: number[]; close?: { sign: number; base: number } };
const issued = new Map<string, Issued[]>(); // per player, the last few sets, to apply what the browser says it used

export type Used = { nonce: number; kind: "long" | "short" | "close"; i?: number };
export const MAX_SIZES = 6;
export async function presign(cfg: LighterConfig, pid: string, m: LighterMarket, sizes: number[], used?: Used, floor = 0): Promise<Ticket & { ms: Timings }> {
  const t: Timings = {}; const t0 = performance.now();
  const { symbol, lev } = LIGHTER_MARKETS[m];
  const [h, mk] = await Promise.all([hotPlayer(cfg, pid), marketBySymbol(cfg, symbol)]);
  const p = h.p;
  const key = `${cfg.network}:${pid}`;
  // what the browser just did moves our idea of the position and the nonce
  const prev = used ? issued.get(key)?.find((x) => x.nonce === used.nonce && x.market === mk.market_id) : undefined;
  if (used && prev) {
    const pos = h.pos?.[mk.market_id];
    const cur = pos ? pos.sign * pos.base : 0;
    const b = prev.bases[used.i ?? 0] ?? 0;
    const next = used.kind === "close" ? 0 : cur + (used.kind === "long" ? b : -b);
    h.pos = { ...(h.pos ?? {}), [mk.market_id]: { sign: Math.sign(next) || 1, base: Math.abs(next), at: Date.now() } };
  }
  const known = h.pos?.[mk.market_id];
  const trustKnown = known && Date.now() - known.at < 3_000; // right after a tap Lighter's account read can lag
  const [b, lighterNonce, pos] = await Promise.all([
    bookFor(cfg, mk.market_id, t),
    used ? Promise.resolve(used.nonce + 1) : nextNonce(cfg, p.account, p.keyIndex),
    trustKnown ? Promise.resolve(known) : account(cfg, p.account).then((a) => {
      const x = a?.positions.find((q) => q.market_id === mk.market_id && Number(q.position) !== 0);
      const v = x ? { sign: x.sign, base: Math.round(Math.abs(Number(x.position)) * 10 ** mk.size_decimals), at: 0 } : { sign: 1, base: 0, at: 0 };
      h.pos = { ...(h.pos ?? {}), [mk.market_id]: v };
      return v;
    }),
  ]);
  lap(t, "read", t0);
  let n = Math.max(lighterNonce, floor);
  const w = await signerFor(keyOf(cfg, p), cfg.chainId, p.keyIndex, p.account);
  h.nonce = undefined; // the server's own open/close re-read the nonce after this
  if (p.lev?.[mk.market_id] !== lev) { // once per market, before the first set
    const r = checked(w.SignUpdateLeverage(mk.market_id, levFraction(lev), 0, 0, n++, p.keyIndex, p.account));
    await sendTx(cfg, r.txType, r.txInfo);
    p.lev = { ...(p.lev ?? {}), [mk.market_id]: lev }; void putPlayer(cfg, pid, p).catch(() => {});
    lap(t, "leverage", t0);
  }
  const mid = midOf(b);
  if (!mid) throw new LighterError(409, "Lighter's book is empty right now.");
  const minBase = Math.round(Number(mk.min_base_amount) * 10 ** mk.size_decimals);
  const bases = sizes.map((usd) => { const b0 = baseAmountFor(usd * lev, mid, mk.size_decimals); return b0 > 0 && b0 >= minBase ? b0 : 0; });
  if (!bases.some((x) => x > 0)) throw new LighterError(400, "That trade is under Lighter's minimum size.");
  const fee = p.approvedFee && cfg.partnerFee ? cfg.partnerFee : 0;
  const exp = Date.now() + TICKET_TTL_MS;
  const order = (isAsk: boolean, size: number, reduce: boolean): Signed => {
    const cap = worstPrice(fillFrom(b, isAsk, size, mk.size_decimals) ?? mid, isAsk, cfg.slippage, mk.price_decimals);
    const r = checked(w.SignCreateOrder(mk.market_id, clientOrderIndex(), size, cap, isAsk ? 1 : 0, 1 /* market */, 0 /* IOC */,
      reduce ? 1 : 0, 0, 0, fee ? cfg.integratorIndex : 0, fee, 0, 0, 0, 0, n, p.keyIndex, p.account));
    return { txType: r.txType, txInfo: r.txInfo, cap, base: size };
  };
  w.SetOrderTxExpiry(exp);
  let tk: Ticket;
  try {
    const opens = bases.map((b0, i) => (b0 ? { usd: sizes[i], long: order(false, b0, false), short: order(true, b0, false) } : null));
    tk = { url: cfg.url, nonce: n, exp, market: mk.market_id, lev, mid, opens, long: opens[0]?.long, short: opens[0]?.short };
    // closing a long sells; reduce-only so a stale size can never flip the player
    if (pos.base > 0) tk.close = { ...order(pos.sign > 0, pos.base, true), side: pos.sign > 0 ? "long" : "short" };
  } finally { w.SetOrderTxExpiry(0); }
  const list = [{ nonce: n, market: mk.market_id, bases, close: pos.base > 0 ? { sign: pos.sign, base: pos.base } : undefined },
    ...(issued.get(key) ?? []).filter((x) => x.nonce !== n || x.market !== mk.market_id)].slice(0, 6);
  issued.set(key, list);
  if (issued.size > 2000) issued.delete(issued.keys().next().value as string);
  void refreshBook(cfg, mk.market_id).catch(() => null); // keeps the next set's caps fresh
  lap(t, "server", t0);
  return { ...tk, ms: t };
}

/** Fallback when the browser can't reach Lighter itself: sends one of the player's pre-signed orders as it is. */
export async function relay(cfg: LighterConfig, pid: string, txType: number, txInfo: string) {
  if (txType !== 14 /* create order */) throw new LighterError(400, "Bad order.");
  const h = await hotPlayer(cfg, pid);
  let info: { AccountIndex?: number };
  try { info = JSON.parse(txInfo); } catch { throw new LighterError(400, "Bad order."); }
  if (info.AccountIndex !== h.p.account) throw new LighterError(403, "Not your order.");
  return { hash: await sendTx(cfg, txType, txInfo) };
}
