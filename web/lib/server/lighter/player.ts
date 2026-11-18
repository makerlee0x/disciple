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
import { account, accountIndexOf, book, fillFrom, midOf, changeTier, marketBySymbol, nextNonce, sendTx, LighterError, type LighterPosition } from "./rest";
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
const hot = new Map<string, { p: LighterPlayer; at: number; nonce?: number }>();
const HOT_MS = 10 * 60_000;
function forget(cfg: LighterConfig, pid: string) { hot.delete(`${cfg.network}:${pid}`); }
/** Loads the player, signer, key and market list into this instance ahead of a duel, so the first tap is warm. */
export async function warm(cfg: LighterConfig, pid: string) {
  const [h] = await Promise.all([hotPlayer(cfg, pid), marketBySymbol(cfg, "BTC").catch(() => null)]);
  await signerFor(keyOf(cfg, h.p), cfg.chainId, h.p.keyIndex, h.p.account);
  if (h.nonce == null) await takeNonce(cfg, h, 0);
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
  return fresh as { p: LighterPlayer; at: number; nonce?: number };
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

/** Market order for $ fuel × leverage. One parallel read (book + nonce, both skipped when warm except the book), then
 *  one signed send. Sets the market's leverage on Lighter first, once per player per market. */
export async function openMarket(cfg: LighterConfig, pid: string, m: LighterMarket, side: "long" | "short", fuelUsd: number) {
  const t: Timings = {}; const t0 = performance.now();
  const { symbol, lev } = LIGHTER_MARKETS[m];
  const [h, mk] = await Promise.all([hotPlayer(cfg, pid), marketBySymbol(cfg, symbol)]);
  const p = h.p;
  const w = await signerFor(keyOf(cfg, p), cfg.chainId, p.keyIndex, p.account);
  const needLev = p.lev?.[mk.market_id] !== lev;
  const [b, n0] = await Promise.all([book(cfg, mk.market_id), takeNonce(cfg, h, needLev ? 2 : 1)]);
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
  const r = checked(w.SignCreateOrder(mk.market_id, clientOrderIndex(), base, worstPrice(fill, isAsk, cfg.slippage, mk.price_decimals), isAsk ? 1 : 0,
    1 /* market */, 0 /* IOC */, 0, 0, 0, fee ? cfg.integratorIndex : 0, fee, 0, 0, 0, 0, n, p.keyIndex, p.account));
  const t1 = performance.now();
  const hash = await send(cfg, h, r.txType, r.txInfo);
  lap(t, "send", t1); lap(t, "server", t0);
  return { hash, market: mk.market_id, base, price: ref, fill, lev, ms: t };
}

/** Closes the whole position on a market (reduce-only market order): position, book and nonce read in parallel. */
export async function closeMarket(cfg: LighterConfig, pid: string, m: LighterMarket) {
  const t: Timings = {}; const t0 = performance.now();
  const [h, mk] = await Promise.all([hotPlayer(cfg, pid), marketBySymbol(cfg, LIGHTER_MARKETS[m].symbol)]);
  const p = h.p;
  const w = await signerFor(keyOf(cfg, p), cfg.chainId, p.keyIndex, p.account);
  const [a, b, n] = await Promise.all([account(cfg, p.account), book(cfg, mk.market_id), takeNonce(cfg, h)]);
  lap(t, "read", t0);
  const pos = a?.positions.find((x) => x.market_id === mk.market_id && Number(x.position) !== 0);
  if (!pos) { h.nonce = undefined; throw new LighterError(409, "Nothing open."); }
  const isAsk = pos.sign > 0; // close a long by selling
  const base = Math.round(Math.abs(Number(pos.position)) * 10 ** mk.size_decimals);
  const fill = fillFrom(b, isAsk, base, mk.size_decimals) ?? midOf(b);
  const fee = p.approvedFee && cfg.partnerFee ? cfg.partnerFee : 0;
  const r = checked(w.SignCreateOrder(mk.market_id, clientOrderIndex(), base, worstPrice(fill, isAsk, cfg.slippage, mk.price_decimals), isAsk ? 1 : 0,
    1, 0, 1 /* reduce only */, 0, 0, fee ? cfg.integratorIndex : 0, fee, 0, 0, 0, 0, n, p.keyIndex, p.account));
  const t1 = performance.now();
  const hash = await send(cfg, h, r.txType, r.txInfo);
  lap(t, "send", t1); lap(t, "server", t0);
  return { hash, market: mk.market_id, base, price: fill, ms: t };
}
