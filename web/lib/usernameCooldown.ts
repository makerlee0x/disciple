/**
 * Username changes: at most one every 24 hours (lee, 2026-10-24). Pure, shared by /api/profile/username (authoritative)
 * and the profile UI (which only mirrors the server's nextAllowedAt).
 *
 * What counts as a change:
 *  - Re-claiming the name the wallet already has: NOT a change (idempotent, no timestamp, always allowed).
 *  - First username (from the space-themed default call sign): a real change of the name people see, so it is allowed
 *    right away (nothing to wait for) and starts the 24h clock.
 *  - Any rename after that: allowed only when 24h have passed since the last counted change; starts a new clock.
 * Wallets with no stored timestamp (named before this shipped) may rename once now.
 */
export const USERNAME_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export type UsernameChange =
  | { kind: "same" }
  | { kind: "allowed" }
  | { kind: "wait"; nextAllowedAt: number };

export function usernameChange(opts: { prev: string | null; next: string; lastChangeAt: number | null; now: number }): UsernameChange {
  const { prev, next, lastChangeAt, now } = opts;
  if (prev && prev === next) return { kind: "same" };
  if (lastChangeAt != null && Number.isFinite(lastChangeAt)) {
    const nextAllowedAt = lastChangeAt + USERNAME_COOLDOWN_MS;
    if (now < nextAllowedAt) return { kind: "wait", nextAllowedAt };
  }
  return { kind: "allowed" };
}

/** nextAllowedAt (ms) from the last counted change, or null when a change is allowed now. */
export function nextUsernameChangeAt(lastChangeAt: number | null, now: number): number | null {
  if (lastChangeAt == null || !Number.isFinite(lastChangeAt)) return null;
  const t = lastChangeAt + USERNAME_COOLDOWN_MS;
  return now < t ? t : null;
}

/** "Sun, Oct 25, 3:14 PM" in the viewer's own locale + time zone. */
export function formatLocalWhen(ts: number): string {
  try { return new Date(ts).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
  catch { return new Date(ts).toISOString(); }
}
