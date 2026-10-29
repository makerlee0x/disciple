/**
 * Flags → guilds migration, pure part (lee, Mon Oct 26 2026 9:01 AM CT: "Clear old flags silently").
 * Every old flag (coin-community "c-…" ids and country codes, since country flags are dropped in V1) is cleared from the
 * player's profile meta (user:meta:<wallet>). Nobody is moved into a guild and nobody gets a prompt or notice.
 * Returns the new stored JSON, or null when there is nothing to change (idempotent: a second run changes nothing).
 */
export function clearOldFlag(raw: string | null): string | null {
  if (!raw) return null;
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  if (typeof o.flag !== "string" || o.flag === "") return null;
  return JSON.stringify({ ...o, flag: "" });
}
