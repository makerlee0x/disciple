import "server-only";
/**
 * Anon launch gas tab (maker 2026-11-20, "Tab on next fees"). A hidden launch used to be paid by a cash-out from the
 * player's wallet to the relayer, sent by the same relayer one nonce before the launch, so anyone could click from the
 * launch to the wallet ($SPACE). Now the relayer sends the launch with no payment and the launch's gas (in USDG) goes on
 * the account's tab. Each later cash-out quoted with the player's own sign-in carries up to TAB_STEP of it on top of the
 * network fee; once that cash-out lands, the tab drops by what it carried.
 *
 * Private: the tab is server KV only, never in a public quote (a quote without a matching sign-in never shows it), and
 * never on chain except as a slightly larger network fee on a later, unrelated cash-out.
 * Key: launchtab:<chain>:<wallet> → owed USDG base units. Unpaid tabs lapse after TAB_TTL_SEC.
 */
import type { Address } from "viem";
import { ACTIVE_CHAIN, deployment } from "../chains";
import { kv, type Kv } from "./kv";

const TAB_TTL_SEC = 90 * 24 * 3600;
const key = (wallet: string) => `launchtab:${ACTIVE_CHAIN.id}:${wallet.toLowerCase()}`;
const units = (usd: number) => BigInt(Math.round(usd * 10 ** deployment().usdgDecimals));

/** Most one cash-out carries (USDG base units): 2¢, so the fee stays close to a normal one. */
export const tabStep = (): bigint => units(Number(process.env.ANON_TAB_STEP_USD) > 0 ? Number(process.env.ANON_TAB_STEP_USD) : 0.02);
/** Most an account can owe before its next anon launch is refused (USDG base units): 25¢ ≈ 3 launches. */
export const tabMax = (): bigint => units(Number(process.env.ANON_TAB_MAX_USD) > 0 ? Number(process.env.ANON_TAB_MAX_USD) : 0.25);

export async function tabOwed(wallet: Address | string, s: Kv = kv()): Promise<bigint> {
  const v = await s.get(key(wallet));
  const n = v ? BigInt(Math.trunc(Number(v)) || 0) : BigInt(0);
  return n > BigInt(0) ? n : BigInt(0);
}

/** What the next cash-out carries: min(owed, step). */
export async function tabSlice(wallet: Address | string, s: Kv = kv()): Promise<bigint> {
  const owed = await tabOwed(wallet, s);
  const step = tabStep();
  return owed < step ? owed : step;
}

export async function addToTab(wallet: Address | string, amount: bigint, s: Kv = kv()): Promise<bigint> {
  if (amount <= BigInt(0)) return tabOwed(wallet, s);
  return BigInt(await s.incrByEx(key(wallet), Number(amount), TAB_TTL_SEC));
}

/** A cash-out that carried `paid` landed: take it off the tab (never below 0). */
export async function payTab(wallet: Address | string, paid: bigint, s: Kv = kv()): Promise<void> {
  if (paid <= BigInt(0)) return;
  const left = await s.incrByEx(key(wallet), -Number(paid), TAB_TTL_SEC);
  if (left <= 0) await s.del(key(wallet));
}

/**
 * Puts `amount` on the tab BEFORE the relayed tx is sent, refusing (and taking it back) when that would pass tabMax().
 * Audit 2026-11-21 M-1: checking first and adding only after the tx landed let many launches sent at once all pass the
 * check. Returns the function that takes the reservation back (call it when nothing landed).
 */
export async function reserveTab(wallet: Address | string, amount: bigint, refusal: string, s: Kv = kv()): Promise<() => Promise<void>> {
  if (amount <= BigInt(0)) return async () => undefined;
  const now = BigInt(await s.incrByEx(key(wallet), Number(amount), TAB_TTL_SEC));
  const release = () => payTab(wallet, amount, s);
  if (now > tabMax()) {
    await release().catch(() => undefined);
    throw Object.assign(new Error(refusal), { notSent: true });
  }
  return release;
}
