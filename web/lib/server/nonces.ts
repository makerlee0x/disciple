/**
 * Single-use, per-request server nonces (W-3): username claims and chat login.
 * Each request gets a fresh random id stored as `<prefix>:<nonce>` → address with a short TTL, so issuing a nonce never
 * touches anyone else's (the old per-address key let GET ?nonce=1&address=<victim> delete a pending claim).
 * Pure over a tiny store interface (lib/server/kv in production): unit-tested by scripts/test-nonces.mts.
 */
import { randomBytes } from "crypto";

export type NonceStore = {
  setNX(k: string, v: string, ttlSec?: number): Promise<boolean>;
  get(k: string): Promise<string | null>;
  getDel(k: string): Promise<string | null>;
  del(...k: string[]): Promise<void>;
};
const NONCE_RE = /^[0-9a-f]{32}$/;
const key = (prefix: string, nonce: string) => `${prefix}:${nonce}`;
export const isNonce = (n: unknown): n is string => typeof n === "string" && NONCE_RE.test(n);

/** New nonce bound to `addr`; never overwrites an existing entry. */
export async function issueNonce(s: NonceStore, prefix: string, addr: string, ttlSec: number): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const n = randomBytes(16).toString("hex");
    if (await s.setNX(key(prefix, n), addr.toLowerCase(), ttlSec)) return n;
  }
  throw new Error("nonce store unavailable");
}
/** true if `nonce` is live and was issued for `addr` (does not consume it). */
export async function nonceValid(s: NonceStore, prefix: string, nonce: unknown, addr: string): Promise<boolean> {
  if (!isNonce(nonce)) return false;
  return (await s.get(key(prefix, nonce))) === addr.toLowerCase();
}
/** Atomically consume: true only for the first caller with the right address (GETDEL ⇒ no double use across lambdas). */
export async function consumeNonce(s: NonceStore, prefix: string, nonce: unknown, addr: string): Promise<boolean> {
  if (!isNonce(nonce)) return false;
  return (await s.getDel(key(prefix, nonce))) === addr.toLowerCase();
}
