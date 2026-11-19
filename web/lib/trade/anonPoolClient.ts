/**
 * Client for the anon launch pool (lib/anonPool, lib/server/anonPoolRelay). The player never signs the launch: the site
 * checks the Privy session, spends from the anon balance and a relayer sends AnonLaunchPool.launch. `wallet` is sent only
 * so the server can match the session; it is never put in the launch.
 */
import { type Address, type Hex } from "viem";
import { bigintToDecimal } from "./gaslessPermit2";
import { GaslessError, type GaslessSendResult } from "./gaslessClient";
import { privyIdentityToken } from "../aa/session";
import type { PoolLaunchArgs } from "../anonPool";

async function rpc<T>(method: string, param: unknown, url = "/api/gasless", fetchFn: typeof fetch = fetch): Promise<T> {
  const idToken = await privyIdentityToken().catch(() => null);
  const headers: Record<string, string> = { "content-type": "application/json", ...(idToken ? { "privy-id-token": idToken } : {}) };
  const r = await fetchFn(url, { method: "POST", headers, body: `{"jsonrpc":"2.0","id":1,"method":"${method}","params":[${JSON.stringify(param, bigintToDecimal)}]}` });
  const j = await r.json().catch(() => ({})) as { result?: T; error?: { message?: string; data?: GaslessError["data"] } };
  if (j.result === undefined) throw new GaslessError(j.error?.message ?? `anon balance HTTP ${r.status}`, j.error?.data ?? {}, r.status);
  return j.result;
}

/** Anon balance in raw USDG, and the pool address top-ups go to. */
export async function anonBalance(wallet: Address): Promise<{ balance: bigint; pool: Address }> {
  const r = await rpc<{ balance: string; pool: Address }>("disciple_anonPoolBalance", { wallet });
  return { balance: BigInt(r.balance), pool: r.pool };
}

/** After a top-up tx (USDG transfer or gasless withdraw to the pool) confirms: credit it to the anon balance. */
export async function creditAnonTopUp(wallet: Address, txHash: Hex): Promise<{ credited: bigint; balance: bigint }> {
  const r = await rpc<{ credited: string; balance: string }>("disciple_anonPoolCredit", { wallet, txHash });
  return { credited: BigInt(r.credited), balance: BigInt(r.balance) };
}

/** Launch from the pool. `usdgIn` = the First BOOST in raw USDG (0 = free Ticket). */
export async function launchFromAnonPool(wallet: Address, usdgIn: bigint, launch: PoolLaunchArgs): Promise<GaslessSendResult & { spent: bigint }> {
  const r = await rpc<{ txHash: Hex; success: boolean; receipt: { logs: GaslessSendResult["logs"] }; gasUsed: number; spent: string; server?: unknown }>(
    "disciple_anonPoolLaunch", { wallet, usdgIn, launch });
  if (!r.success) throw new GaslessError("The launch didn't go through. Your anon balance was not spent.", { notSent: false, txHash: r.txHash });
  return { txHash: r.txHash, logs: r.receipt.logs, gasUsed: r.gasUsed, server: r.server, spent: BigInt(r.spent) };
}

/** Cash out the anon balance to `to`. */
export async function cashOutAnonBalance(wallet: Address, to: Address, amount: bigint): Promise<Hex> {
  const r = await rpc<{ txHash: Hex; success: boolean }>("disciple_anonPoolPayout", { wallet, to, amount });
  if (!r.success) throw new GaslessError("The cash out didn't go through. Your anon balance was not spent.", { notSent: false, txHash: r.txHash });
  return r.txHash;
}
