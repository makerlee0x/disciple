import "server-only";
/**
 * Add cash into Lighter. Disciple cash is USDG on Robinhood Chain; Lighter's Universal Deposit Address (UDA, run by
 * Fun.xyz at bridge.lighter.xyz) takes USDG on Robinhood Chain and credits USDC to the player's Lighter perps account,
 * creating the account on the first deposit (docs.lighter.xyz, Deposits, Transfers and Withdrawals, 2026-11-18).
 * The address is per wallet and stays the same, so it's cached. The player's cash moves there with the usual gasless
 * withdraw (lib/trade/gaslessWithdrawClient), so there's nothing new to sign up for.
 *
 *   LIGHTER_BRIDGE_KEY   the x-api-key Lighter issues to builders (Discord #support ticket). Server-side only.
 *
 * Mainnet only: Lighter's testnet has no deposit route (its faucet funds test accounts).
 * Minimum: TURBO_MIN_IN ($6, lib/lighter/mins) on every network; bridge and swap costs come out of the amount.
 */
import { kv } from "@/lib/server/kv";
import { TURBO_MIN_IN } from "@/lib/lighter/mins";
import { lighterConfig, type LighterConfig } from "./config";
import { LighterError } from "./rest";

const BRIDGE = "https://bridge.lighter.xyz";
export const DEPOSIT_MIN_NEW = TURBO_MIN_IN, DEPOSIT_MIN = TURBO_MIN_IN;   // maker 2026-11-20: one $6 minimum everywhere
/** Lighter on Robinhood Chain takes USDG straight in: 1 USDG minimum per deposit (docs, Robinhood Chain section). */
export const depositMins = (cfg: LighterConfig) => (cfg.payoutIsCash ? { minNew: 1, min: 1 } : cfg.network === "mainnet" ? { minNew: RELAY_MIN, min: RELAY_MIN } : { minNew: DEPOSIT_MIN_NEW, min: DEPOSIT_MIN });
/** The chain whose USDG the deposit address takes: Robinhood Chain mainnet for Lighter main (4663). The browser
 *  refuses to send from any other chain, so test USDG on a testnet build never goes to a real deposit address. */
export const depositChain = (cfg: LighterConfig) => cfg.depositChainId ?? (cfg.network === "mainnet" ? 4663 : null);

/**
 * Lighter main (maker 2026-11-18, picked over Lighter on Robinhood Chain for its 0.5 bp Plus fee): it doesn't take
 * Robinhood Chain deposits, but it gives each wallet an intent address for USDC on Arbitrum (CCTP, 5 USDC min). Relay
 * (relay.link) swaps the player's USDG on Robinhood Chain into USDC on Arbitrum and delivers it to that address. Its
 * deposit-address mode means the player only sends USDG to an address, which the gasless cash-out already does: no gas,
 * no new signature. Quoted live 2026-11-18: about $0.04 on $10, filled in ~1 s.
 */
const RELAY = "https://api.relay.link";
export const RELAY_MIN = TURBO_MIN_IN;   // maker 2026-11-20: $6. Lighter's 5 USDC intent minimum, after our cash-out gas and Relay's few cents
const LIGHTER_INTENT_MIN = 5;
export const ARBITRUM_ID = 42161;
export const ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
export const RH_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const RH_CHAIN = 4663;

/** etaSec: Relay's time estimate for the swap + bridge (seconds), when it gives one. */
export type RelayDeposit = { address: string; outUsd: number; feeUsd: number | null; etaSec?: number };
/** Relay's /quote answer (deposit-address mode) -> where to send and what arrives. Throws on a shape we don't know. Pure, tested. */
export function parseRelayDeposit(j: unknown): RelayDeposit {
  const o = (j ?? {}) as { steps?: { id?: string; depositAddress?: string }[]; details?: { currencyOut?: { amount?: string }; timeEstimate?: number }; fees?: { relayer?: { amountUsd?: string } }; message?: string };
  const step = o.steps?.find((x) => x.id === "deposit" && typeof x.depositAddress === "string");
  if (!step?.depositAddress || !/^0x[0-9a-fA-F]{40}$/.test(step.depositAddress)) throw new LighterError(502, o.message || "The swap service didn't answer.");
  const out = Number(o.details?.currencyOut?.amount) / 1e6;
  if (!(out > 0)) throw new LighterError(502, "The swap service didn't answer.");
  const fee = Number(o.fees?.relayer?.amountUsd);
  const eta = Number(o.details?.timeEstimate);
  return { address: step.depositAddress, outUsd: out, feeUsd: Number.isFinite(fee) ? fee : null, ...(eta > 0 && eta < 3600 ? { etaSec: Math.round(eta) } : {}) };
}

type RelayLeg = { from: number; fromToken: string; to: number; toToken: string };
const TO_TURBO: RelayLeg = { from: RH_CHAIN, fromToken: RH_USDG, to: ARBITRUM_ID, toToken: ARBITRUM_USDC };
const TO_CASH: RelayLeg = { from: ARBITRUM_ID, fromToken: ARBITRUM_USDC, to: RH_CHAIN, toToken: RH_USDG };

async function relayQuote(leg: RelayLeg, wallet: string, recipient: string, usd: number): Promise<RelayDeposit> {
  const res = await fetch(`${RELAY}/quote`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user: wallet, recipient, refundTo: wallet, useDepositAddress: true, tradeType: "EXACT_INPUT",
      originChainId: leg.from, originCurrency: leg.fromToken, destinationChainId: leg.to, destinationCurrency: leg.toToken,
      amount: String(Math.round(usd * 1e6)),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new LighterError(502, (j as { message?: string }).message || "The swap service didn't answer.");
  return parseRelayDeposit(j);
}

async function relayDeposit(wallet: string, recipient: string, usd: number): Promise<RelayDeposit> {
  const d = await relayQuote(TO_TURBO, wallet, recipient, usd);
  if (d.outUsd < LIGHTER_INTENT_MIN) throw new LighterError(400, `Add at least $${RELAY_MIN.toFixed(2)}.`);
  return d;
}

/** Lighter main -> Cash: a Relay deposit address on Arbitrum that turns `usd` of USDC into USDG in the wallet on
 *  Robinhood Chain. Lighter's fast withdrawal pays it. Only once LIGHTER_PAYOUT_CHAIN=42161 says that's where the fast
 *  withdrawal pays (Lighter's docs don't name the chain; checked with a test withdrawal to the player's own wallet). */
export async function relayCashAddress(wallet: string, usd: number): Promise<RelayDeposit> {
  if (process.env.LIGHTER_PAYOUT_CHAIN !== String(ARBITRUM_ID)) throw new LighterError(409, "Moving Turbo cash back isn't open yet.");
  return relayQuote(TO_CASH, wallet, wallet, usd);
}
export const TESTNET_FAUCET = "https://testnet.app.lighter.xyz";

const intentKey = (cfg: LighterConfig, w: string) => `lighter:${cfg.network}:intent:${w.toLowerCase()}`;

/**
 * Lighter on Robinhood Chain: a persistent intent address tied to the player's wallet. USDG sent to it is credited to
 * that wallet's Lighter account (the first deposit creates it). No bridge, no builder key:
 * POST {host}/api/v1/createIntentAddress  chain_id=<our chain>&from_addr=<wallet>&amount=0&is_external_deposit=true
 */
async function intentAddress(cfg: LighterConfig, wallet: string, chainId = cfg.depositChainId): Promise<{ address: string }> {
  const k = chainId === cfg.depositChainId ? intentKey(cfg, wallet) : `${intentKey(cfg, wallet)}:${chainId}`;
  const hit = await kv().get(k).catch(() => null);
  if (hit) return { address: hit };
  const res = await fetch(`${cfg.url}/api/v1/createIntentAddress`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ chain_id: String(chainId), from_addr: wallet, amount: "0", is_external_deposit: "true" }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = (await res.json().catch(() => ({}))) as { code?: number; message?: string; intent_address?: string };
  if (!res.ok || (j.code !== undefined && j.code !== 200) || !j.intent_address) throw new LighterError(res.status === 400 ? 400 : 502, j.message || "Lighter's deposit service didn't answer.");
  if (!/^0x[0-9a-fA-F]{40}$/.test(j.intent_address)) throw new LighterError(502, "Lighter sent a bad deposit address.");
  await kv().set(k, j.intent_address);
  return { address: j.intent_address };
}

function bridgeKey() {
  const k = process.env.LIGHTER_BRIDGE_KEY;
  if (!k) throw new LighterError(503, "Adding cash to Lighter isn't switched on yet.");
  return k;
}

/** The player's Lighter deposit address (USDG on Robinhood Chain → USDC on Lighter perps). */
export async function depositAddress(wallet: string, usd?: number): Promise<{ address: string; outUsd?: number; feeUsd?: number | null; etaSec?: number }> {
  const cfg = lighterConfig();
  if (cfg.payoutIsCash) return intentAddress(cfg, wallet);
  if (cfg.network === "mainnet") {
    // Lighter main: Relay, USDG -> USDC on Arbitrum -> the wallet's Lighter intent address. Not the Fun.xyz bridge:
    // it kept $0.85 of a $10 deposit (8.5%) on 2026-11-18; Relay quoted ~$0.04.
    if (!(typeof usd === "number" && usd > 0)) throw new LighterError(400, "Pick an amount.");
    const intent = await intentAddress(cfg, wallet, ARBITRUM_ID);
    return relayDeposit(wallet, intent.address, usd);
  }
  throw new LighterError(409, "Lighter testnet takes test cash from its faucet, not Add cash.");
}

/** Where the player's deposits are on Lighter's side (PROCESSING, then COMPLETED once credited). Raw, for display. */
export async function depositStatus(wallet: string): Promise<{ state: "none" | "processing" | "completed" | "unknown"; raw?: unknown }> {
  const res = await fetch(`${BRIDGE}/v1/uda/status/${wallet}`, { headers: { "x-api-key": bridgeKey() }, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return { state: "none" };
  const raw = await res.json().catch(() => null);
  const txt = JSON.stringify(raw ?? "").toUpperCase();
  // the docs name the states but not the shape: the newest one wins, so look for PROCESSING before COMPLETED
  const state = txt.includes("PROCESSING") ? "processing" : txt.includes("COMPLETED") ? "completed" : "unknown";
  return { state, raw };
}
