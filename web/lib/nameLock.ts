/**
 * Off-chain name + call-sign (ticker) lock. Shared client/server; no I/O.
 *
 * Existing pattern: launchpads like pump.fun, and most indexers, keep names in the frontend/DB
 * rather than an on-chain registrar. We do the same in site KV. Two rockets may share a name or
 * a ticker, but not both, once an ASCENDED rocket has claimed the pair. The image is not in the
 * key (creators can still change images after ascend).
 *
 * This replaces the parked Oct 31 Quick Launch rule (exact name+ticker+IMAGE match; also a
 * separate lock on an ascended rocket's name OR ticker alone). That rule was never shipped on main.
 */
import { MAINNET_CHAIN_ID } from "./networkConfig";

/** Outer Space / graduation mcap (lib/config CURVE.graduationMcap). */
export const NAME_LOCK_DROP_USD = 33_333;
/** Continuous time the holder must stay below NAME_LOCK_DROP_USD before the key can free. */
export const NAME_LOCK_DROP_MS = 24 * 60 * 60 * 1000;

/**
 * Draft error text for a taken name+ticker — not yet approved by lee.
 * Launch form and the API return this as `reason` on mainnet when a lock is held.
 */
export const NAME_LOCK_TAKEN_MSG =
  "An ASCENDED rocket already uses this name and call sign. Change the name or the call sign.";

export function nameLockEnforced(chainId: number): boolean {
  return chainId === MAINNET_CHAIN_ID;
}

/**
 * Trim leading/trailing whitespace, lowercase ASCII A–Z only.
 * Inner spaces and non-ASCII characters must match exactly (no Unicode folding, no space collapse).
 */
export function normalizeLockPart(value: string): string {
  return String(value ?? "").trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Lock key: normalized name + ticker. Image is not part of the key. */
export function nameLockKey(name: string, ticker: string): string {
  return JSON.stringify([normalizeLockPart(name), normalizeLockPart(ticker)]);
}

export type ChainPos = { block: number; logIndex: number };

export function laterThan(a: ChainPos, b: ChainPos): boolean {
  return a.block > b.block || (a.block === b.block && a.logIndex > b.logIndex);
}

export type LockRecord = {
  token: string;
  claimedAt: number;
  claimedBlock: number;
  claimedLogIndex: number;
  belowSince: number | null;
};

/** First-to-ascend wins. Same rocket is idempotent. Another rocket already holding the key → no-op. */
export function claimOnAscend(
  lock: LockRecord | null,
  token: string,
  pos: ChainPos,
  at: number,
): { lock: LockRecord; wrote: boolean } {
  const t = token.toLowerCase();
  if (lock) return { lock, wrote: false };
  return { lock: { token: t, claimedAt: at, claimedBlock: pos.block, claimedLogIndex: pos.logIndex, belowSince: null }, wrote: true };
}

/**
 * A launch is refused only when a claim already exists (and this token is not the holder).
 * Copies that were live before the claim are grandfathered: they are not locked and do not take the lock.
 */
export function launchBlockedByLock(opts: { enforced: boolean; lock: LockRecord | null; token?: string | null }): { blocked: boolean; reason?: string } {
  if (!opts.enforced || !opts.lock) return { blocked: false };
  if (opts.token && opts.token.toLowerCase() === opts.lock.token) return { blocked: false };
  return { blocked: true, reason: NAME_LOCK_TAKEN_MSG };
}

/** Slipped-in copy: launched after the current claim, and is not the holder. Grandfathered launches are not flagged. */
export function isSlippedInCopy(opts: { token: string; launched: ChainPos; lock: LockRecord | null }): boolean {
  if (!opts.lock) return false;
  if (opts.token.toLowerCase() === opts.lock.token) return false;
  return laterThan(opts.launched, { block: opts.lock.claimedBlock, logIndex: opts.lock.claimedLogIndex });
}

export type McapObservation = { belowSince: number | null; mayRelease: boolean };

/** Record the first time mcap is seen below the floor; any reading at or above resets the timer. */
export function observeLockMcap(
  belowSince: number | null,
  mcapUsd: number,
  now: number,
  dropUsd = NAME_LOCK_DROP_USD,
  dropMs = NAME_LOCK_DROP_MS,
): McapObservation {
  if (!(mcapUsd < dropUsd)) return { belowSince: null, mayRelease: false };
  const start = belowSince ?? now;
  return { belowSince: start, mayRelease: now - start >= dropMs };
}

/**
 * Free the key only after 24h continuously marked below AND a final check that is still below.
 * If the final check is at or above the floor, the timer resets.
 */
export function applyMcapTick(
  lock: LockRecord,
  seenMcap: number,
  now: number,
  finalMcap?: number,
  dropUsd = NAME_LOCK_DROP_USD,
  dropMs = NAME_LOCK_DROP_MS,
): { lock: LockRecord | null; released: boolean } {
  const obs = observeLockMcap(lock.belowSince, seenMcap, now, dropUsd, dropMs);
  if (!obs.mayRelease) return { lock: { ...lock, belowSince: obs.belowSince }, released: false };
  const final = finalMcap ?? seenMcap;
  if (final < dropUsd && now - (obs.belowSince ?? now) >= dropMs) return { lock: null, released: true };
  if (!(final < dropUsd)) return { lock: { ...lock, belowSince: null }, released: false };
  return { lock: { ...lock, belowSince: obs.belowSince }, released: false };
}

export async function fetchNameLock(
  name: string,
  ticker: string,
  f: typeof fetch = fetch,
): Promise<{ enforced: boolean; available: boolean; reason?: string } | null> {
  try {
    const u = `/api/name-lock?name=${encodeURIComponent(name)}&ticker=${encodeURIComponent(ticker)}`;
    const r = await f(u, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json() as { enforced?: boolean; available?: boolean; reason?: string };
    if (typeof j.available !== "boolean") return null;
    return { enforced: j.enforced === true, available: j.available, reason: typeof j.reason === "string" ? j.reason : undefined };
  } catch {
    return null;
  }
}

export async function fetchNameLockCopy(
  coin: string,
  f: typeof fetch = fetch,
): Promise<{ enforced: boolean; copy: boolean; holder?: string } | null> {
  try {
    const r = await f(`/api/name-lock?coin=${encodeURIComponent(coin)}`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json() as { enforced?: boolean; copy?: boolean; holder?: string };
    return { enforced: j.enforced === true, copy: j.copy === true, holder: typeof j.holder === "string" ? j.holder : undefined };
  } catch {
    return null;
  }
}
