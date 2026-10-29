/**
 * Username lookup for display (live retest #5): the header wallet chip and the TRADES feed names.
 * Keys are lowercase addresses — the same as the username store (lib/server/usernames user:addr:<lc>) and
 * /api/profile/username?address=<lc>. Cached per address (a name changes rarely; PROFILE_CHANGED clears the cache),
 * one request per address in flight, so a busy feed doesn't hammer the API.
 */
import { fetchUsernameStatus } from "./profile";
import { lookupGuild } from "./guildClient";

const TTL_MS = 5 * 60_000;
type Hit = { at: number; name: string | null };
const cache = new Map<string, Hit>();
const inflight = new Map<string, Promise<string | null>>();
export type NameFetcher = (addressLc: string) => Promise<string | null>;
const defaultFetcher: NameFetcher = async (a) => (await fetchUsernameStatus(a)).username;

export const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

/** The claimed username of `address` (no @), or null. Never throws. */
export async function lookupName(address: string | null | undefined, fetcher: NameFetcher = defaultFetcher, now = Date.now()): Promise<string | null> {
  if (!isAddr(address)) return null;
  const k = address.toLowerCase();
  const hit = cache.get(k);
  if (hit && now - hit.at < TTL_MS) return hit.name;
  let p = inflight.get(k);
  if (!p) {
    p = fetcher(k).then((n) => { const name = n ? String(n).trim().replace(/^@/, "") || null : null; cache.set(k, { at: Date.now(), name }); return name; },
      (e) => { console.warn("[disciple] username lookup failed", k, e); return hit?.name ?? null; })
      .finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}

/** First claimed name among `addresses` (e.g. the smart account, then its owner). */
export async function lookupFirstName(addresses: (string | null | undefined)[], fetcher?: NameFetcher): Promise<string | null> {
  for (const a of addresses) { const n = await lookupName(a, fetcher); if (n) return n; }
  return null;
}

/** Synchronous cache read (null = unknown or no name). */
export const cachedName = (address: string | null | undefined): string | null => (isAddr(address) ? cache.get(address.toLowerCase())?.name ?? null : null);

export function clearNameCache() { cache.clear(); inflight.clear(); }

/** Header chip text: "@name" when claimed, else the short address. */
export function chipLabel(username: string | null | undefined, address: string): string {
  const u = String(username ?? "").trim().replace(/^@/, "");
  return u ? `@${u}` : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Feed names for the flight engine: window.__discipleNames[lc] = name, and a "disciple:names" event with the map after
 * each new name. (engine.js still prints short(addr): it needs to read this map — GAME patch in the PR body.)
 * Guilds V1: the same call also looks up the trader's guild tag, published as window.__discipleGuilds[lc] = { id, tag, mark }
 * with a "disciple:guilds" event (lib/guildClient). The names map and event above are unchanged.
 */
export function publishTraderName(address: string | null | undefined, fetcher?: NameFetcher) {
  if (typeof window === "undefined" || !isAddr(address)) return;
  const k = address.toLowerCase();
  void lookupGuild(k);
  const w = window as unknown as { __discipleNames?: Record<string, string> };
  if (w.__discipleNames && k in w.__discipleNames) return;
  void lookupName(k, fetcher).then((n) => {
    if (!n) return;
    const m = (w.__discipleNames ??= {});
    if (m[k] === n) return;
    m[k] = n;
    window.dispatchEvent(new CustomEvent("disciple:names", { detail: { ...m } }));
  });
}
