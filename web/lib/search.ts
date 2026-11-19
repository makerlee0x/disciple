/**
 * Site search (top bar, maker 2026-11-19): pilots (@username and display name), rockets (name and ticker) and market items.
 * Shared types and the pure ranking used by /api/search (lib/server/search) and its tests.
 */

export const SEARCH_MIN = 2;
export const SEARCH_MAX = 40;
export const SEARCH_PER_GROUP = 5;

export type PilotHit = { username: string; name: string | null; pfp: string | null; nft: boolean };
export type RocketHit = { token: string; name: string; ticker: string; icon: string; mcapUsd: number; graduated: boolean };
export type ItemHit = { id: string; title: string; kind: string; rar: string; art: string; floor: number | null; listed: number; listing: string | null };
export type SearchResult = { q: string; pilots: PilotHit[]; rockets: RocketHit[]; items: ItemHit[] };
export const EMPTY_RESULT: SearchResult = { q: "", pilots: [], rockets: [], items: [] };

/** What the player typed, as matched: trimmed, lower case, no leading @ or $, at most SEARCH_MAX chars. */
export function normQuery(q: unknown): string {
  return String(q ?? "").trim().toLowerCase().replace(/^[@$]+/, "").replace(/\s+/g, " ").slice(0, SEARCH_MAX);
}

/** Match rank of `q` in `text` (lower is better): 0 exact, 1 starts with, 2 a word starts with, 3 contains, -1 no match. */
export function matchRank(text: string | null | undefined, q: string): number {
  if (!text || !q) return -1;
  const t = text.toLowerCase();
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (t.split(/[\s_\-|&.]+/).some((w) => w.startsWith(q))) return 2;
  return t.includes(q) ? 3 : -1;
}

/** Best rank over several fields (−1 when none match). At the same rank an earlier field wins (@username before display name). */
export function bestRank(fields: (string | null | undefined)[], q: string): number {
  let best = -1;
  fields.forEach((f, i) => { const r = matchRank(f, q); if (r >= 0) { const k = r + i * 0.1; if (best < 0 || k < best) best = k; } });
  return best;
}

/** Keep the rows that match, best match first; ties keep `tie` order (e.g. bigger mcap first). */
export function rankBy<T>(rows: T[], fields: (r: T) => (string | null | undefined)[], q: string, tie: (a: T, b: T) => number = () => 0, limit = SEARCH_PER_GROUP): T[] {
  return rows
    .map((r) => ({ r, k: bestRank(fields(r), q) }))
    .filter((x) => x.k >= 0)
    .sort((a, b) => a.k - b.k || tie(a.r, b.r))
    .slice(0, limit)
    .map((x) => x.r);
}

/** Fired after a search pick navigates, so a page that is already open (the market) can re-read its URL. */
export const SEARCH_NAV_EVENT = "disciple:search-nav";

export const isHexAddr = (s: string) => /^0x[0-9a-f]{40}$/.test(s);

/** Market search link: a listed item opens its cheapest copy, an unlisted one fills the market search. */
export const itemHref = (i: ItemHit) => (i.listing ? `/market?listing=${i.listing}` : `/market?q=${encodeURIComponent(i.title)}`);
export const pilotHref = (p: PilotHit) => `/u/${encodeURIComponent(p.username)}`;
export const rocketHref = (r: RocketHit) => `/coin/${r.token}`;
