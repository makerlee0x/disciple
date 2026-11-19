import "server-only";
/**
 * Site search (GET /api/search, top bar, maker 2026-11-19): pilots, rockets and market items in one call.
 *  - pilots: every claimed @username (lib/server/searchIndex) with its display name and picture from profile meta. The list
 *    is read whole and kept in memory for USERS_TTL_MS, so a search costs no KV reads on a warm instance.
 *  - rockets: the lobby's coin list (lib/server/home getHomeData, already cached, test and copycat coins left out):
 *    name, ticker, or a pasted contract address.
 *  - items: the catalogue (out items only, no Prestige unlocks) by title; listed ones carry the floor price, the number of
 *    open listings and the cheapest listing's id. Listed items come first.
 */
import { ITEMS, RARITIES, frozenOf, itemOut, itemTitle, HULL_NAMES, type Item } from "@/lib/collection";
import { pfpUrl, sanitizeDisplayName } from "@/lib/profileMeta";
import { MARKET_ENABLED } from "@/lib/features";
import {
  EMPTY_RESULT, SEARCH_MIN, SEARCH_PER_GROUP, isHexAddr, rankBy,
  type ItemHit, type PilotHit, type RocketHit, type SearchResult,
} from "@/lib/search";
import { kv, type Kv } from "./kv";
import { USERS_Z, fillUserIndex } from "./searchIndex";
import { getHomeData } from "./home";
import { listings } from "./market";
import { ensureCatalog } from "./catalog";

const USERS_TTL_MS = 120_000;
const LISTINGS_TTL_MS = 30_000;
const MAX_USERS = 20_000;

type UserRow = PilotHit & { address: string };
const g = globalThis as unknown as {
  __dscSearchUsers?: { at: number; rows: UserRow[] }; __dscSearchUsersP?: Promise<UserRow[]> | null;
  __dscSearchList?: { at: number; rows: Map<string, { floor: number; n: number; id: string }> };
};

async function mgetChunked(s: Kv, keys: string[]): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for (let i = 0; i < keys.length; i += 500) out.push(...(await s.mget(keys.slice(i, i + 500))));
  return out;
}

/** Every claimed pilot: username → wallet → profile meta (name, pfp). Stale names (pointing at no wallet) are skipped. */
export async function readUsers(s: Kv = kv()): Promise<UserRow[]> {
  await fillUserIndex(s).catch(() => 0);
  const names = await s.zrange(USERS_Z, MAX_USERS);
  if (!names.length) return [];
  const wallets = await mgetChunked(s, names.map((n) => `user:name:${n}`));
  const live = names.map((u, i) => ({ u, a: wallets[i] })).filter((x): x is { u: string; a: string } => !!x.a);
  const metas = await mgetChunked(s, live.map((x) => `user:meta:${x.a.toLowerCase()}`));
  return live.map(({ u, a }, i) => {
    let m: { name?: unknown; pfp?: unknown; nft?: unknown } = {};
    try { m = JSON.parse(metas[i] ?? "{}") ?? {}; } catch { /* bad meta ⇒ name only */ }
    const name = sanitizeDisplayName(m.name).slice(0, 48) || null;
    const pfp = typeof m.pfp === "string" ? pfpUrl(m.pfp) || null : null;
    return { username: u, name, pfp, nft: !!pfp && !!m.nft, address: a.toLowerCase() };
  });
}

async function users(): Promise<UserRow[]> {
  const c = g.__dscSearchUsers;
  if (c && Date.now() - c.at < USERS_TTL_MS) return c.rows;
  g.__dscSearchUsersP ??= readUsers()
    .then((rows) => { g.__dscSearchUsers = { at: Date.now(), rows }; return rows; })
    .catch((e) => { console.warn("[search] users failed", (e as Error).message); return c?.rows ?? []; })
    .finally(() => { g.__dscSearchUsersP = null; });
  return g.__dscSearchUsersP;
}

async function openListings(): Promise<Map<string, { floor: number; n: number; id: string }>> {
  const c = g.__dscSearchList;
  if (c && Date.now() - c.at < LISTINGS_TTL_MS) return c.rows;
  const rows = new Map<string, { floor: number; n: number; id: string }>();
  try {
    for (const l of await listings({ sort: "price-asc", limit: 500 })) {
      const r = rows.get(l.item);
      if (!r) rows.set(l.item, { floor: l.price, n: 1, id: l.id });
      else { r.n++; if (l.price < r.floor) { r.floor = l.price; r.id = l.id; } }
    }
  } catch (e) { console.warn("[search] listings failed", (e as Error).message); return c?.rows ?? rows; }
  g.__dscSearchList = { at: Date.now(), rows };
  return rows;
}

const RANK = new Map(RARITIES.map((r, i) => [r, i]));
const firstArt = (i: Item) => frozenOf(i).art.split(" ")[0] ?? "";

export function searchItems(q: string, listed: Map<string, { floor: number; n: number; id: string }>, now = Date.now()): ItemHit[] {
  const pool = ITEMS.filter((i) => !i.prestige && itemOut(i, now));
  const hits = rankBy(pool, (i) => [itemTitle(i), i.name, i.hull ? HULL_NAMES[i.hull] : null], q,
    (a, b) => Number(listed.has(b.id)) - Number(listed.has(a.id)) || (RANK.get(b.rar) ?? 0) - (RANK.get(a.rar) ?? 0), 60);
  // listed first within the top matches, then the rest
  const sorted = [...hits.filter((i) => listed.has(i.id)), ...hits.filter((i) => !listed.has(i.id))].slice(0, SEARCH_PER_GROUP);
  return sorted.map((i) => {
    const l = listed.get(i.id);
    return { id: i.id, title: itemTitle(i), kind: i.kind, rar: i.rar, art: firstArt(i), floor: l?.floor ?? null, listed: l?.n ?? 0, listing: l?.id ?? null };
  });
}

export function searchRockets(q: string, coins: { token: string; name: string; ticker: string; icon: string; mcapUsd: number; graduated: boolean }[]): RocketHit[] {
  const pick = (c: (typeof coins)[number]): RocketHit => ({ token: c.token, name: c.name, ticker: c.ticker, icon: c.icon, mcapUsd: c.mcapUsd, graduated: c.graduated });
  if (isHexAddr(q)) return coins.filter((c) => c.token.toLowerCase() === q).slice(0, 1).map(pick);
  return rankBy(coins, (c) => [c.ticker, c.name], q, (a, b) => b.mcapUsd - a.mcapUsd).map(pick);
}

export function searchPilots(q: string, rows: UserRow[]): PilotHit[] {
  const pick = ({ username, name, pfp, nft }: UserRow): PilotHit => ({ username, name, pfp, nft });
  if (isHexAddr(q)) return rows.filter((r) => r.address === q).slice(0, 1).map(pick);
  return rankBy(rows, (r) => [r.username, r.name], q, (a, b) => a.username.length - b.username.length).map(pick);
}

export async function siteSearch(q: string): Promise<SearchResult> {
  if (q.length < SEARCH_MIN && !isHexAddr(q)) return { ...EMPTY_RESULT, q };
  await ensureCatalog().catch(() => null);
  const [u, home, listed] = await Promise.all([
    users(),
    getHomeData(4_000).catch(() => null),
    MARKET_ENABLED ? openListings() : Promise.resolve(new Map()),
  ]);
  return {
    q,
    pilots: searchPilots(q, u),
    rockets: searchRockets(q, home?.coins ?? []),
    items: MARKET_ENABLED && !isHexAddr(q) ? searchItems(q, listed) : [],
  };
}
