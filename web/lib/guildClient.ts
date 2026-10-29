/**
 * Client side of /api/guilds. Signed actions use the same nonce + wallet signature pattern as the profile meta save.
 * Display lookup: batched, cached tags per wallet (one /api/guilds/of request per tick), also published for GAME as
 * window.__discipleGuilds[<wallet lc>] = { id, tag, mark } with a "disciple:guilds" event carrying the whole map.
 * (The existing "disciple:names" event and window.__discipleNames are unchanged, so engine.js keeps working.)
 */
import { IS_STATIC_PREVIEW } from "./base-path";
import { notifyProfileChanged, signWalletMessage } from "./profile";
import { GUILD_COPY, guildActionMessage, normalizeTag, sanitizeGuildName, validateGuildName, validateTag, type Guild, type GuildAction, type GuildTag } from "./guilds";

export const GUILDS_EVENT = "disciple:guilds";
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; tag: GuildTag | null }>();
const waiters = new Map<string, ((t: GuildTag | null) => void)[]>();
let timer: ReturnType<typeof setTimeout> | null = null;
export type GuildFetcher = (wallets: string[]) => Promise<Record<string, GuildTag | null>>;
const defaultFetcher: GuildFetcher = async (ws) => {
  const r = await fetch(`/api/guilds/of?w=${ws.join(",")}`);
  if (!r.ok) throw new Error(`guilds/of ${r.status}`);
  return ((await r.json()) as { guilds?: Record<string, GuildTag | null> }).guilds ?? {};
};
let fetcher: GuildFetcher = defaultFetcher;
/** Tests only. */
export function setGuildFetcher(f: GuildFetcher | null) { fetcher = f ?? defaultFetcher; }

function publish(changed: Record<string, GuildTag | null>) {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __discipleGuilds?: Record<string, GuildTag | null> };
  const m = (w.__discipleGuilds ??= {});
  let dirty = false;
  for (const [k, v] of Object.entries(changed)) { if (JSON.stringify(m[k] ?? null) !== JSON.stringify(v)) { m[k] = v; dirty = true; } }
  if (dirty) window.dispatchEvent(new CustomEvent(GUILDS_EVENT, { detail: { ...m } }));
}

async function flush() {
  timer = null;
  const ws = Array.from(waiters.keys());
  for (let i = 0; i < ws.length; i += 100) {
    const batch = ws.slice(i, i + 100);
    let got: Record<string, GuildTag | null> = {};
    try { got = await fetcher(batch); } catch (e) { console.warn("[disciple] guild tag lookup failed", e); }
    const out: Record<string, GuildTag | null> = {};
    for (const w of batch) {
      const tag = got[w] ?? null;
      cache.set(w, { at: Date.now(), tag }); out[w] = tag;
      (waiters.get(w) ?? []).forEach((f) => f(tag)); waiters.delete(w);
    }
    publish(out);
  }
}

/** Guild tag of `address` (cached 5 min), or null. Never throws. Lookups in the same tick share one request. */
export function lookupGuild(address: string | null | undefined): Promise<GuildTag | null> {
  if (IS_STATIC_PREVIEW || !isAddr(address)) return Promise.resolve(null);
  const k = address.toLowerCase();
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.tag);
  return new Promise((res) => {
    const list = waiters.get(k) ?? []; list.push(res); waiters.set(k, list);
    if (!timer) timer = setTimeout(() => void flush(), 30);
  });
}
export const cachedGuild = (address: string | null | undefined): GuildTag | null | undefined =>
  isAddr(address) ? cache.get(address.toLowerCase())?.tag : undefined;
export function clearGuildCache(address?: string) { if (address) cache.delete(address.toLowerCase()); else cache.clear(); }

/* ---------- reads ---------- */
export async function fetchMyGuild(address: string | null | undefined): Promise<{ guild: Guild | null; nextSwitchAt: number | null }> {
  if (IS_STATIC_PREVIEW || !isAddr(address)) return { guild: null, nextSwitchAt: null };
  try {
    const j = (await (await fetch(`/api/guilds?wallet=${address.toLowerCase()}`, { cache: "no-store" })).json()) as { guild?: Guild | null; nextSwitchAt?: number | null };
    return { guild: j.guild ?? null, nextSwitchAt: typeof j.nextSwitchAt === "number" && j.nextSwitchAt > Date.now() ? j.nextSwitchAt : null };
  } catch { return { guild: null, nextSwitchAt: null }; }
}
export async function listGuilds(): Promise<Guild[]> {
  if (IS_STATIC_PREVIEW) return [];
  try { return ((await (await fetch("/api/guilds?list=1")).json()) as { guilds?: Guild[] }).guilds ?? []; } catch { return []; }
}
export async function findGuildByTag(tag: string): Promise<Guild | null> {
  const t = normalizeTag(tag);
  if (IS_STATIC_PREVIEW || !/^[A-Z0-9]{1,5}$/.test(t)) return null;
  try { return ((await (await fetch(`/api/guilds?tag=${t}`, { cache: "no-store" })).json()) as { guild?: Guild | null }).guild ?? null; } catch { return null; }
}

/* ---------- signed actions ---------- */
export type GuildActionResult = { ok: true; guild: Guild | null } | { ok: false; reason: string; nextAllowedAt?: number };

async function act(action: GuildAction, address: string | null, path: string, p: { guildId?: string; tag?: string; name?: string }): Promise<GuildActionResult> {
  if (IS_STATIC_PREVIEW || !isAddr(address)) return { ok: false, reason: GUILD_COPY.signIn };
  const a = address.toLowerCase();
  try {
    const { nonce } = (await (await fetch(`/api/guilds?nonce=1&address=${a}`, { cache: "no-store" })).json()) as { nonce?: string };
    if (!nonce) return { ok: false, reason: GUILD_COPY.failed };
    const signed = await signWalletMessage(guildActionMessage(action, a, p, nonce), a);
    if (!signed) return { ok: false, reason: GUILD_COPY.declined };
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: a, ...p, nonce, ...signed }) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; guild?: Guild | null; reason?: string; nextAllowedAt?: number };
    if (!r.ok || !j.ok) return { ok: false, reason: j.reason || GUILD_COPY.failed, ...(j.nextAllowedAt ? { nextAllowedAt: j.nextAllowedAt } : {}) };
    clearGuildCache(a);
    publish({ [a]: j.guild ? { id: j.guild.id, tag: j.guild.tag, mark: j.guild.mark } : null });
    notifyProfileChanged();
    return { ok: true, guild: j.guild ?? null };
  } catch { return { ok: false, reason: GUILD_COPY.failed }; }
}
export const joinGuild = (guildId: string, address: string | null) => act("join", address, "/api/guilds/join", { guildId });
export const leaveGuild = (address: string | null) => act("leave", address, "/api/guilds/leave", {});
export function createGuild(tagIn: string, nameIn: string, address: string | null): Promise<GuildActionResult> {
  const tag = normalizeTag(tagIn), name = sanitizeGuildName(nameIn);
  const bad = validateTag(tag) ?? validateGuildName(name);
  if (bad) return Promise.resolve({ ok: false, reason: bad });
  return act("create", address, "/api/guilds", { tag, name });
}
