import "server-only";
/**
 * Turbo cash → Cash: a Lighter fast withdrawal (docs.lighter.xyz, Deposits, Transfers and Withdrawals, 2026-11-18).
 *   1. GET  /api/v1/fastwithdraw/info  (auth token)  → the fast-withdraw pool's account + the most it pays out now
 *   2. GET  /api/v1/transferFeeInfo                  → the transfer fee, charged ON TOP of the amount
 *   3. SignTransfer to the pool with memo = destination address (20 bytes) + 12 zero bytes, signed with Disciple's
 *      trading key, then the player's wallet signs `messageToSign` (Lighter needs the owner's L1 signature)
 *   4. POST /api/v1/fastwithdraw  (form: tx_info, to_address; auth token)
 * Fast withdrawals pay the collateral asset to any EVM address. Only venues whose payout lands as USDG on Robinhood
 * Chain (cfg.payoutIsCash: Lighter on Robinhood Chain) can send it straight to Cash; elsewhere this refuses rather than
 * send the player's money to a chain Cash doesn't read.
 */
import { formatUnits, isAddress, recoverMessageAddress, type Hex } from "viem";
import type { LighterConfig } from "./config";
import { getPlayer, putPlayer, open } from "./keys";
import { account, assetDetails, fastWithdrawInfo, fastWithdraw, nextNonce, transferFee, LighterError } from "./rest";
import { checked, signerFor } from "./signer";
import { relayCashAddress } from "./bridge";

/** Lighter's floor for transfers and withdrawals ("1 USDG or equivalent"); fast withdrawals of USDC need 4. */
export const WITHDRAW_MIN = 1;
/** Lighter main pays fast withdrawals in USDC: 4 minimum */
export const WITHDRAW_MIN_USDC = 4;
const minFor = (cfg: LighterConfig) => (cfg.payoutIsCash ? WITHDRAW_MIN : WITHDRAW_MIN_USDC);
/**
 * Where a withdrawal may go. Robinhood Chain exchange: straight to Cash. Lighter main: through Relay back to USDG
 * (relayCashAddress, needs LIGHTER_PAYOUT_CHAIN), or `raw` to the player's own wallet: the test that shows which chain
 * Lighter pays on. Never anywhere else.
 */
const canWithdraw = (cfg: LighterConfig) => cfg.payoutIsCash || cfg.network === "mainnet";
const PENDING_MS = 10 * 60_000;

/** memo: destination address (20 bytes) followed by 12 zero bytes, as 0x + 64 hex. Pure, tested. */
export function withdrawMemo(to: string): string {
  if (!isAddress(to, { strict: false })) throw new LighterError(400, "Bad address.");
  return `0x${to.slice(2).toLowerCase()}${"00".repeat(12)}`;
}

async function keyedPlayer(cfg: LighterConfig, pid: string) {
  const p = await getPlayer(cfg, pid);
  if (!p?.keyReady) throw new LighterError(409, "Finish Lighter set-up first.");
  const w = await signerFor(open(cfg.keySecret, p.enc), cfg.chainId, p.keyIndex, p.account);
  const tok = w.CreateAuthToken(Math.floor(Date.now() / 1000) + 600, p.keyIndex, p.account);
  if (!tok.authToken) throw new Error(`lighter auth: ${tok.error}`);
  return { p, w, auth: tok.authToken };
}

/** What the player can move back now: free collateral (open positions hold margin), capped by the pool's limit. */
export async function withdrawable(cfg: LighterConfig, pid: string): Promise<{ usd: number; fee: number; min: number }> {
  if (!canWithdraw(cfg)) throw new LighterError(409, "Moving Turbo cash back isn't open yet.");
  const { p, auth } = await keyedPlayer(cfg, pid);
  const [a, info] = await Promise.all([account(cfg, p.account), fastWithdrawInfo(cfg, p.account, auth)]);
  const fee = await transferFee(cfg, p.account, info.to_account_index, auth);
  const free = Number(a?.available_balance ?? 0);
  const cap = Math.min(Number(info.max_withdrawal_amount ?? Infinity), Number(info.withdraw_limit ?? Infinity));
  const feeUsd = fee / 1e6;
  return { usd: Math.max(0, Math.min(free - feeUsd, Number.isFinite(cap) ? cap : free)), fee: feeUsd, min: minFor(cfg) };
}

/** Step 1: sign the transfer to the fast-withdraw pool and hand back the message the player's wallet signs. */
export async function startWithdraw(cfg: LighterConfig, pid: string, usd: number, to: string, raw = false): Promise<{ message: string; usd: number; fee: number }> {
  if (!canWithdraw(cfg)) throw new LighterError(409, "Moving Turbo cash back isn't open yet.");
  const min = minFor(cfg);
  if (!(usd >= min)) throw new LighterError(400, `Move at least $${min}.`);
  if (!cfg.payoutIsCash) {
    // Lighter main pays USDC: raw = the player's own wallet only (test), else Relay's address back to USDG in Cash
    if (raw) { if (to.toLowerCase() !== pid.toLowerCase()) throw new LighterError(400, "Bad address."); }
    else to = (await relayCashAddress(pid, usd)).address;
  }
  const memo = withdrawMemo(to);
  const { p, w, auth } = await keyedPlayer(cfg, pid);
  const [info, assets, a] = await Promise.all([fastWithdrawInfo(cfg, p.account, auth), assetDetails(cfg), account(cfg, p.account)]);
  const asset = assets.find((x) => x.symbol === cfg.collateral) ?? assets.find((x) => /^USD/.test(x.symbol));
  const assetId = asset?.asset_id ?? asset?.asset_index;
  if (!asset || assetId == null) throw new LighterError(502, "Lighter didn't list its cash asset.");
  const fee = await transferFee(cfg, p.account, info.to_account_index, auth);
  const dec = asset.decimals ?? 6;
  const amount = Math.floor(usd * 10 ** dec);
  const free = Number(a?.available_balance ?? 0);
  if (usd + fee / 1e6 > free + 1e-9) throw new LighterError(400, `You can move up to $${Math.max(0, free - fee / 1e6).toFixed(2)} right now.`);
  const cap = Number(info.max_withdrawal_amount ?? NaN);
  if (Number.isFinite(cap) && usd > cap) throw new LighterError(400, `You can move up to $${cap.toFixed(2)} right now.`);
  const nonce = await nextNonce(cfg, p.account, p.keyIndex);
  const r = checked(w.SignTransfer(info.to_account_index, assetId, 0, 0, amount, fee, memo, 0, nonce, p.keyIndex, p.account));
  if (!r.messageToSign) throw new Error("lighter: no transfer message");
  await putPlayer(cfg, pid, { ...p, pending: { kind: "withdraw", txType: r.txType, txInfo: r.txInfo, message: r.messageToSign, at: Date.now(), to, usd } });
  return { message: r.messageToSign, usd: Number(formatUnits(BigInt(amount), dec)), fee: fee / 1e6 };
}

/** Step 2: the player's wallet signature → the fast withdrawal. Lighter pays `to` from its pool. */
export async function finishWithdraw(cfg: LighterConfig, pid: string, sig: string): Promise<{ usd: number; to: string }> {
  const p = await getPlayer(cfg, pid);
  const pend = p?.pending;
  if (!p || !pend || pend.kind !== "withdraw" || !pend.to || Date.now() - pend.at > PENDING_MS) throw new LighterError(409, "That request expired. Start again.");
  const who = await recoverMessageAddress({ message: pend.message, signature: sig as Hex }).catch(() => null);
  if (!who || who.toLowerCase() !== pid.toLowerCase()) throw new LighterError(403, "That signature isn't from your wallet.");
  const { auth } = await keyedPlayer(cfg, pid);
  const txInfo = JSON.stringify({ ...JSON.parse(pend.txInfo), L1Sig: sig });
  delete p.pending;
  await putPlayer(cfg, pid, p);   // one try per signature: a refused send needs a fresh nonce anyway
  await fastWithdraw(cfg, txInfo, pend.to, auth);
  return { usd: pend.usd ?? 0, to: pend.to };
}
