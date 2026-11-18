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
 * Minimums: $5 for a new account, $3 after (EVM chains); bridge and swap costs come out of the amount.
 */
import { kv } from "@/lib/server/kv";
import { ACTIVE_CHAIN } from "@/lib/chains";
import { lighterConfig, type LighterConfig } from "./config";
import { LighterError } from "./rest";

const BRIDGE = "https://bridge.lighter.xyz";
export const DEPOSIT_MIN_NEW = 5, DEPOSIT_MIN = 3;
/** Lighter on Robinhood Chain takes USDG straight in: 1 USDG minimum per deposit (docs, Robinhood Chain section). */
export const depositMins = (cfg: LighterConfig) => (cfg.payoutIsCash ? { minNew: 1, min: 1 } : { minNew: DEPOSIT_MIN_NEW, min: DEPOSIT_MIN });
export const TESTNET_FAUCET = "https://testnet.app.lighter.xyz";

type Uda = { depositAddr: string; blocked?: boolean };
const key = (w: string) => `lighter:uda:${w.toLowerCase()}`;
const intentKey = (cfg: LighterConfig, w: string) => `lighter:${cfg.network}:intent:${w.toLowerCase()}`;

/**
 * Lighter on Robinhood Chain: a persistent intent address tied to the player's wallet. USDG sent to it is credited to
 * that wallet's Lighter account (the first deposit creates it). No bridge, no builder key:
 * POST {host}/api/v1/createIntentAddress  chain_id=<our chain>&from_addr=<wallet>&amount=0&is_external_deposit=true
 */
async function intentAddress(cfg: LighterConfig, wallet: string): Promise<{ address: string }> {
  const hit = await kv().get(intentKey(cfg, wallet)).catch(() => null);
  if (hit) return { address: hit };
  const res = await fetch(`${cfg.url}/api/v1/createIntentAddress`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ chain_id: String(ACTIVE_CHAIN.id), from_addr: wallet, amount: "0", is_external_deposit: "true" }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = (await res.json().catch(() => ({}))) as { code?: number; message?: string; intent_address?: string };
  if (!res.ok || (j.code !== undefined && j.code !== 200) || !j.intent_address) throw new LighterError(res.status === 400 ? 400 : 502, j.message || "Lighter's deposit service didn't answer.");
  if (!/^0x[0-9a-fA-F]{40}$/.test(j.intent_address)) throw new LighterError(502, "Lighter sent a bad deposit address.");
  await kv().set(intentKey(cfg, wallet), j.intent_address);
  return { address: j.intent_address };
}

function bridgeKey() {
  const k = process.env.LIGHTER_BRIDGE_KEY;
  if (!k) throw new LighterError(503, "Adding cash to Lighter isn't switched on yet.");
  return k;
}

/** The player's Lighter deposit address (USDG on Robinhood Chain → USDC on Lighter perps). */
export async function depositAddress(wallet: string): Promise<{ address: string }> {
  const cfg = lighterConfig();
  if (cfg.payoutIsCash) return intentAddress(cfg, wallet);
  if (cfg.network !== "mainnet") throw new LighterError(409, "Lighter testnet takes test cash from its faucet, not Add cash.");
  const hit = await kv().get(key(wallet)).catch(() => null);
  if (hit) return { address: hit };
  const res = await fetch(`${BRIDGE}/v1/uda`, {
    method: "POST", headers: { "x-api-key": bridgeKey(), "content-type": "application/json" },
    body: JSON.stringify({ walletAddress: wallet, market: "perps", asset: "USDC" }), signal: AbortSignal.timeout(10_000),
  });
  const j = (await res.json().catch(() => ({}))) as Uda & { message?: string };
  if (!res.ok || !j.depositAddr) throw new LighterError(res.status === 400 ? 400 : 502, j.message || "Lighter's deposit service didn't answer.");
  if (j.blocked) throw new LighterError(403, "Lighter can't take deposits for this wallet.");
  if (!/^0x[0-9a-fA-F]{40}$/.test(j.depositAddr)) throw new LighterError(502, "Lighter sent a bad deposit address.");
  await kv().set(key(wallet), j.depositAddr);
  return { address: j.depositAddr };
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
