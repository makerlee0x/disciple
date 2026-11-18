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
import { account, accountIndexOf, fillPrice, txStatus, changeTier, marketBySymbol, marketNow, nextNonce, sendTx, LighterError, type LighterPosition } from "./rest";
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

/** Market order for $ fuel × leverage. Sets the market's leverage on Lighter first if it isn't already. */
export async function openMarket(cfg: LighterConfig, pid: string, m: LighterMarket, side: "long" | "short", fuelUsd: number) {
  const { p, w, nonce } = await keyed(cfg, pid);
  const { symbol, lev } = LIGHTER_MARKETS[m];
  const mk = await marketBySymbol(cfg, symbol);
  // one nonce read, then count up locally: Lighter's nextNonce can lag a just-sent tx, and a reused nonce drops the order
  let n = await nonce();
  if (p.lev?.[mk.market_id] !== lev) {
    const r = checked(w.SignUpdateLeverage(mk.market_id, levFraction(lev), 0, 0, n++, p.keyIndex, p.account));
    await sendTx(cfg, r.txType, r.txInfo);
    p.lev = { ...(p.lev ?? {}), [mk.market_id]: lev }; await putPlayer(cfg, pid, p);
  }
  const now = await marketNow(cfg, mk.market_id);
  const price = Number(now.mark_price || now.last_trade_price);
  const base = baseAmountFor(fuelUsd * lev, price, now.size_decimals);
  if (base < Math.round(Number(now.min_base_amount) * 10 ** now.size_decimals)) throw new LighterError(400, "That trade is under Lighter's minimum size.");
  const isAsk = side === "short";
  const fill = await fillPrice(cfg, mk.market_id, isAsk, base, now.size_decimals);
  if (fill == null) throw new LighterError(409, "Not enough on Lighter's book for that size.");
  const fee = p.approvedFee && cfg.partnerFee ? cfg.partnerFee : 0;
  const r = checked(w.SignCreateOrder(mk.market_id, clientOrderIndex(), base, worstPrice(fill, isAsk, cfg.slippage, now.price_decimals), isAsk ? 1 : 0,
    1 /* market */, 0 /* IOC */, 0, 0, 0, fee ? cfg.integratorIndex : 0, fee, 0, 0, 0, 0, n, p.keyIndex, p.account));
  const hash = await sendTx(cfg, r.txType, r.txInfo);
  return { hash, market: mk.market_id, base, price, fill, lev, tx: await txStatus(cfg, hash) };
}

/** Closes the whole position on a market (reduce-only market order). */
export async function closeMarket(cfg: LighterConfig, pid: string, m: LighterMarket) {
  const { p, w, nonce } = await keyed(cfg, pid);
  const mk = await marketBySymbol(cfg, LIGHTER_MARKETS[m].symbol);
  const pos = (await account(cfg, p.account))?.positions.find((x) => x.market_id === mk.market_id && Number(x.position) !== 0);
  if (!pos) throw new LighterError(409, "Nothing open.");
  const now = await marketNow(cfg, mk.market_id);
  const price = Number(now.mark_price || now.last_trade_price);
  const isAsk = pos.sign > 0; // close a long by selling
  const base = Math.round(Math.abs(Number(pos.position)) * 10 ** now.size_decimals);
  const fill = (await fillPrice(cfg, mk.market_id, isAsk, base, now.size_decimals)) ?? price;
  const fee = p.approvedFee && cfg.partnerFee ? cfg.partnerFee : 0;
  const r = checked(w.SignCreateOrder(mk.market_id, clientOrderIndex(), base, worstPrice(fill, isAsk, cfg.slippage, now.price_decimals), isAsk ? 1 : 0,
    1, 0, 1 /* reduce only */, 0, 0, fee ? cfg.integratorIndex : 0, fee, 0, 0, 0, 0, await nonce(), p.keyIndex, p.account));
  const hash = await sendTx(cfg, r.txType, r.txInfo);
  return { hash, market: mk.market_id, base, price, tx: await txStatus(cfg, hash) };
}
