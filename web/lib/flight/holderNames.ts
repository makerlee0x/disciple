/**
 * Holder display names for the coin-screen holders list (KOTH panel / chat HOLDERS tab).
 * Claimed username (`@name`, via lib/nameLookup: per-address module cache that survives list refreshes + one in-flight
 * request per address) → the address's default call sign (lib/defaultUsername) → short 0x… address.
 * /api/profile/username has no batch mode, so lookups for addresses we haven't seen run through a small concurrency
 * limit; a refresh only fetches addresses that aren't cached yet. Protocol rows (labelled) are never looked up.
 */
import { cachedName, lookupName, type NameFetcher } from "../nameLookup";
import { defaultUsername } from "../defaultUsername";

export const HOLDER_NAME_CONCURRENCY = 3;
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const done = new Set<string>();   // addresses whose lookup finished this session (name or no name)

/** What the holders list prints for `address` given a resolved username (or none). */
export function holderDisplayName(address: string, username: string | null | undefined): string {
  const u = String(username ?? "").trim().replace(/^@/, "");
  if (u) return `@${u}`;
  if (!isAddr(address)) return String(address ?? "");
  return defaultUsername(address) || shortAddr(address);
}

/** Synchronous name from what's cached now (default call sign until the claimed name is known). */
export const holderNameNow = (address: string) => holderDisplayName(address, cachedName(address));

/** Resolve the not-yet-looked-up addresses with ≤ `limit` requests at a time. Resolves true if any new claimed name appeared. */
export async function resolveHolderNames(addresses: string[], opts: { limit?: number; fetcher?: NameFetcher } = {}): Promise<boolean> {
  const todo = [...new Set(addresses.filter(isAddr).map((a) => a.toLowerCase()))].filter((a) => !done.has(a));
  let i = 0, found = false;
  const worker = async () => { while (i < todo.length) { const a = todo[i++]; const n = await lookupName(a, opts.fetcher); done.add(a); if (n) found = true; } };
  await Promise.all(Array.from({ length: Math.min(opts.limit ?? HOLDER_NAME_CONCURRENCY, todo.length) }, worker));
  return found;
}

export function _resetHolderNames() { done.clear(); }
