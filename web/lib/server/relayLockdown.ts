import "server-only";
/**
 * Shared relay admission leftovers used by the gasless relay: revoke/ban/strike gate and paid-send budget.
 * The 4337 self-bundler admission (requireSelfBundlerMode, admitRelay, lockedRelay, session keys) is removed.
 */
import { kv } from "./kv";
import { REVOKE_MARKER_TTL_SEC, revokeMarkerKey, banKey } from "../relayRevokeMarker";
import type { RelayMetrics } from "./relayMetrics";
const timed = <T>(m: RelayMetrics | undefined, stage: string, task: () => Promise<T>) => m ? m.span(stage, task) : task();

export { REVOKE_MARKER_TTL_SEC, revokeMarkerKey, banKey };
/** AUDIT hardening 6: the strike ledger (fastRelay TRUST, persisted at relay:trust:<sender>) becomes a gate. */
export const strikeSource: { local: (sender: string) => number } = { local: () => 0 };
const trustKey = (sender: string) => `relay:trust:${sender.toLowerCase()}`;
const revoked = () => Object.assign(new Error("session revoked; no submission"), { notSent: true });
const banned = () => Object.assign(new Error("session banned; no submission"), { notSent: true });
const strikeUntilOf = (raw: string | null | undefined): number => {
  if (!raw) return 0;
  try { const v = Number((JSON.parse(raw) as { strikeUntil?: unknown }).strikeUntil ?? 0); return Number.isFinite(v) ? v : Infinity; }
  catch { return Infinity; }   // unreadable ledger entry ⇒ fail closed
};
/** Wallet (+ optional Privy DID) revoke marker, permanent ban, and strike window, one MGET. Fail closed.
 *  did is the Privy user id (`did:privy:…`); when set, a ban/revoke/strike on the did also blocks any of that
 *  user's wallets (H1 / M1). Self-bundler calls without a did still check the wallet keys (incl. the ban).
 *  `extraKey` (gasless: the immutable market-status key) is fetched in the SAME MGET — no extra RTT — and
 *  returned so the caller can use it after the gate passes. A store error still fails closed (trade refused). */
export async function requireNotRevokedOrStruck(sender: string, now = Date.now(), did?: string | null, extraKey?: string | readonly (string | null | undefined)[] | null): Promise<string | (string | null)[] | null> {
  const ids = did ? [sender, did] : [sender];
  const extras = (extraKey == null ? [] : Array.isArray(extraKey) ? extraKey : [extraKey]).filter((k): k is string => typeof k === "string" && k.length > 0);
  const keys = ids.flatMap(id => [banKey(id), revokeMarkerKey(id), trustKey(id)]);
  keys.push(...extras);
  let vals: (string | null)[];
  try { vals = await kv().mget(keys); }
  catch { throw Object.assign(new Error("relay gate store unavailable; no submission"), { notSent: true }); }
  let until = ids.reduce((u, id) => Math.max(u, strikeSource.local(id)), 0);
  for (let i = 0; i < ids.length; i++) {
    const [ban, marker, trust] = vals.slice(i * 3, i * 3 + 3);
    if (ban !== null && ban !== undefined) throw banned();
    if (marker !== null && marker !== undefined) throw revoked();
    until = Math.max(until, strikeUntilOf(trust));
  }
  if (now < until) throw Object.assign(new Error("sender in relay strike backoff; no submission"), { notSent: true });
  if (extras.length === 0) return null;
  const ev = extras.map((_, i) => vals[ids.length * 3 + i] ?? null);
  return Array.isArray(extraKey) ? ev : ev[0] ?? null;
}
export const RELAY_SENDER_CAP = 20, RELAY_GLOBAL_CAP = 60, RELAY_BUDGET_WINDOW_SEC = 60;
export const RELAY_GLOBAL_KEY = "relay:paid:global";
/**
 * Paid-send budget (caps unchanged: 20/sender/min, 60 global/min; a store error throws ⇒ fail closed).
 * Vercel Security finding 1: one atomic EVAL checks the sender cap FIRST and charges the global counter only when the
 * sender is under its cap (and refunds it when the global cap is hit), so one sender's over-cap replays can't burn
 * everyone's global quota. Returns a refund for the global unit: the caller calls it when the op is rejected before
 * anything is signed (only an admitted send/broadcast keeps the global charge).
 */
export async function relaySendBudget(sender: string, metrics?: RelayMetrics): Promise<() => Promise<void>> {
  const store = kv();
  const r = await timed(metrics, "rateLimitStore", () => store.relayBudget(`relay:paid:sender:${sender.toLowerCase()}`, RELAY_GLOBAL_KEY,
    RELAY_SENDER_CAP, RELAY_GLOBAL_CAP, RELAY_BUDGET_WINDOW_SEC));
  if (r !== 0) throw new Error("relay rate limited");
  let refunded = false;
  return async () => { if (refunded) return; refunded = true; await store.decrIfPositive(RELAY_GLOBAL_KEY); };
}
