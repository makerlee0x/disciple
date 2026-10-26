/**
 * Testnet-only "Get test cash" (SITE new-player cash). The button renders ONLY when the active chain is RH testnet
 * 46630 (TEST_CASH_ENABLED); mainnet config never shows it. The server route (/api/test-cash) mints test USDG + some
 * test STRATEGY to the player's smart account, rate-limited to once an hour per account.
 * After the mints land we fire CASH_ARRIVED_EVENT: the one-tap watcher (lib/aa/session) retries the setup and the
 * wallet / cash panels re-read balances.
 * Copy strings: TEST_CASH_COPY (DRAFT, pending lee's approval). Plain, dollars only.
 */
import { createPublicClient, http, type Hex } from "viem";
import { ACTIVE_CHAIN } from "./chains";
import type { Address } from "./protocol";

export const TEST_CASH_CHAIN_ID = 46630;
/** Never true on mainnet config: keyed on the active chain id only. */
export const TEST_CASH_ENABLED = ACTIVE_CHAIN.id === TEST_CASH_CHAIN_ID;
export const TEST_CASH_USD = 500;
export const TEST_CASH_STRATEGY_USD = 250;
export const TEST_CASH_COOLDOWN_SEC = 3600;
/** window event: new cash may have arrived (test cash minted). */
export const CASH_ARRIVED_EVENT = "disciple:cash";

export const TEST_CASH_COPY = {
  button: "Get test cash",
  busy: "Adding test cash…",
  done: (usd: number) => `Added $${usd.toLocaleString("en-US")} in test cash.`,
  note: "Test cash is free and only works here while we test. It has no real value.",
  wait: (mins: number) => `You already got test cash. Try again in ${mins} min.`,
  off: "Test cash isn't available right now. Try again later.",
  needsCash: "Add cash first to turn on one-tap.",
  deposit: "Deposit",
} as const;

export type TestCashResult = { ok: true; usd: number } | { ok: false; text: string };

/** POST /api/test-cash, wait for the mints to land, then announce CASH_ARRIVED_EVENT. Never throws. */
export async function getTestCash(account: Address): Promise<TestCashResult> {
  if (!TEST_CASH_ENABLED) return { ok: false, text: TEST_CASH_COPY.off };
  try {
    const r = await fetch("/api/test-cash", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: account }) });
    const j = await r.json().catch(() => ({})) as { ok?: boolean; txHashes?: Hex[]; usd?: number; reason?: string; retryAfterSec?: number };
    if (!j.ok || !j.txHashes?.length) {
      console.warn("[disciple] test cash refused:", r.status, j.reason);
      if (r.status === 429) return { ok: false, text: TEST_CASH_COPY.wait(Math.max(1, Math.ceil((j.retryAfterSec ?? TEST_CASH_COOLDOWN_SEC) / 60))) };
      return { ok: false, text: TEST_CASH_COPY.off };
    }
    const pc = createPublicClient({ chain: ACTIVE_CHAIN, transport: http() });
    await Promise.all(j.txHashes.map((hash) => pc.waitForTransactionReceipt({ hash, timeout: 30_000 }).catch((e) => console.warn("[disciple] test cash receipt wait:", (e as Error).message?.split("\n")[0]))));
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CASH_ARRIVED_EVENT, { detail: { account } }));
    return { ok: true, usd: j.usd ?? TEST_CASH_USD };
  } catch (e) {
    console.warn("[disciple] test cash request failed:", (e as Error).message);
    return { ok: false, text: TEST_CASH_COPY.off };
  }
}
