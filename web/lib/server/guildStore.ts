/**
 * Guilds V1 store: pure over a small KV interface (lib/server/kv in production, memory in scripts/test-guilds.mts).
 * Keys (plan: disciple-notes/clans-v1-plan.md, written as "clans"):
 *   guild:<id>            → JSON { id, tag, name, mark, createdBy, createdAt, emptySince? }   (player-made guilds only;
 *                          starter guilds live in code, lib/guildSeed)
 *   guild:tag:<TAG>       → id, claimed with SET NX, so each tag is unique (starter tags are reserved in code)
 *   guild:member:<wallet> → JSON { id, at }  · one guild per player
 *   guild:members:<id>    → sorted set of wallets (score = join time). The future guild board reads this.
 *   guild:last:<wallet>   → ms of the player's last counted switch (join another guild, or leave): once a day
 *   guild:index           → sorted set of player-made guild ids (score = createdAt), for the picker list
 * Wallets are lower case, same as user:addr:<wallet> (lib/server/usernames).
 */
import { randomBytes } from "crypto";
import {
  GUILD_COPY, GUILD_SWITCH_COOLDOWN_MS, EMPTY_GUILD_HOLD_MS, isGuildId, seedGuild, seedGuilds, toTag, validateGuildName, validateTag,
  type Guild, type GuildTag,
} from "@/lib/guilds";

export type GuildKv = {
  get(k: string): Promise<string | null>;
  mget(ks: string[]): Promise<(string | null)[]>;
  set(k: string, v: string): Promise<void>;
  setNX(k: string, v: string, ttlSec?: number): Promise<boolean>;
  del(...k: string[]): Promise<void>;
  zadd(k: string, items: { score: number; member: string }[]): Promise<void>;
  zrange(k: string, limit?: number, rev?: boolean): Promise<string[]>;
  zrem(k: string, ...members: string[]): Promise<number>;
};
type Stored = { id: string; tag: string; name: string; mark: string; createdBy: string; createdAt: number; emptySince?: number };
type Member = { id: string; at: number };
export type GuildResult = { ok: true; guild: Guild | null } | { ok: false; reason: string; status: number; nextAllowedAt?: number };

const K = {
  guild: (id: string) => `guild:${id}`,
  tag: (t: string) => `guild:tag:${t}`,
  member: (w: string) => `guild:member:${w.toLowerCase()}`,
  members: (id: string) => `guild:members:${id}`,
  last: (w: string) => `guild:last:${w.toLowerCase()}`,
  index: "guild:index",
};
const MAX_MEMBERS_READ = 100_000;
const parse = <T,>(v: string | null): T | null => { if (!v) return null; try { return JSON.parse(v) as T; } catch { return null; } };
const fromStored = (s: Stored): Guild => ({ id: s.id, tag: s.tag, name: s.name, mark: s.mark || "", seed: false });

export function createGuildStore(s: GuildKv, now: () => number = Date.now) {
  async function storedGuild(id: string): Promise<Stored | null> { return isGuildId(id) && id.startsWith("u-") ? parse<Stored>(await s.get(K.guild(id))) : null; }
  async function guildById(id: string): Promise<Guild | null> {
    if (!isGuildId(id)) return null;
    const seed = seedGuild(id); if (seed) return seed;
    const st = await storedGuild(id); return st ? fromStored(st) : null;
  }
  async function memberCount(id: string): Promise<number> { return (await s.zrange(K.members(id), MAX_MEMBERS_READ)).length; }
  async function withCount(c: Guild | null): Promise<Guild | null> { return c ? { ...c, members: await memberCount(c.id) } : null; }
  async function memberOf(wallet: string): Promise<Member | null> { return parse<Member>(await s.get(K.member(wallet))); }
  async function lastSwitch(wallet: string): Promise<number | null> { const v = Number(await s.get(K.last(wallet))); return Number.isFinite(v) && v > 0 ? v : null; }
  /** ms when the player may switch again, or null when allowed now. */
  async function nextSwitchAt(wallet: string): Promise<number | null> {
    const l = await lastSwitch(wallet); if (l == null) return null;
    const t = l + GUILD_SWITCH_COOLDOWN_MS; return now() < t ? t : null;
  }

  async function guildByTag(tag: string): Promise<Guild | null> {
    const t = tag.toUpperCase();
    const seed = seedGuilds().find((c) => c.tag === t); if (seed) return seed;
    const id = await s.get(K.tag(t)); return id ? guildById(id) : null;
  }

  /** The player's guild, or null. A member record pointing at a missing guild reads as no guild. */
  async function guildOf(wallet: string): Promise<Guild | null> { const m = await memberOf(wallet); return m ? guildById(m.id) : null; }

  /** Batch: wallet (lower case) → tag, for feeds (chat, holders, names). Missing / no guild → null. */
  async function tagsOf(wallets: string[]): Promise<Record<string, GuildTag | null>> {
    const ws = Array.from(new Set(wallets.map((w) => w.toLowerCase()))).filter((w) => /^0x[0-9a-f]{40}$/.test(w));
    const out: Record<string, GuildTag | null> = {};
    if (!ws.length) return out;
    const ms = (await s.mget(ws.map(K.member))).map((v) => parse<Member>(v));
    const ids = Array.from(new Set(ms.filter((m): m is Member => !!m && isGuildId(m.id)).map((m) => m.id)));
    const userIds = ids.filter((id) => !seedGuild(id));
    const stored = userIds.length ? (await s.mget(userIds.map(K.guild))).map((v) => parse<Stored>(v)) : [];
    const byId = new Map<string, GuildTag>();
    for (const id of ids) { const c = seedGuild(id); if (c) byId.set(id, toTag(c)!); }
    stored.forEach((st) => { if (st) byId.set(st.id, toTag(fromStored(st))!); });
    ws.forEach((w, i) => { const m = ms[i]; out[w] = (m && byId.get(m.id)) || null; });
    return out;
  }

  async function removeFrom(wallet: string, id: string) {
    await s.zrem(K.members(id), wallet);
    const st = await storedGuild(id);
    if (st && (await memberCount(id)) === 0) await s.set(K.guild(id), JSON.stringify({ ...st, emptySince: now() }));
  }
  async function addTo(wallet: string, id: string) {
    const t = now();
    await s.set(K.member(wallet), JSON.stringify({ id, at: t } satisfies Member));
    await s.zadd(K.members(id), [{ score: t, member: wallet }]);
    const st = await storedGuild(id);
    if (st?.emptySince) { const { emptySince: _e, ...rest } = st; void _e; await s.set(K.guild(id), JSON.stringify(rest)); }
  }
  /** Switching (from one guild to another, or leaving) is once a day. Joining from no guild is always allowed. */
  async function switchBlocked(wallet: string, cur: Member | null): Promise<GuildResult | null> {
    if (!cur) return null;
    const next = await nextSwitchAt(wallet);
    return next ? { ok: false, reason: "wait", status: 429, nextAllowedAt: next } : null;
  }

  async function join(walletIn: string, id: string): Promise<GuildResult> {
    const wallet = walletIn.toLowerCase();
    const guild = await guildById(id);
    if (!guild) return { ok: false, reason: GUILD_COPY.unknown, status: 404 };
    const cur = await memberOf(wallet);
    if (cur?.id === id) return { ok: true, guild: await withCount(guild) }; // already in: no-op, no clock
    const blocked = await switchBlocked(wallet, cur); if (blocked) return blocked;
    if (cur) { await removeFrom(wallet, cur.id); await s.set(K.last(wallet), String(now())); }
    await addTo(wallet, id);
    return { ok: true, guild: await withCount(guild) };
  }

  async function leave(walletIn: string): Promise<GuildResult> {
    const wallet = walletIn.toLowerCase();
    const cur = await memberOf(wallet);
    if (!cur) return { ok: true, guild: null };
    const blocked = await switchBlocked(wallet, cur); if (blocked) return blocked;
    await s.del(K.member(wallet));
    await removeFrom(wallet, cur.id);
    await s.set(K.last(wallet), String(now()));
    return { ok: true, guild: null };
  }

  /** Frees a tag whose guild has had 0 members for EMPTY_GUILD_HOLD_MS. true if the tag is free now. */
  async function releaseStaleTag(tag: string): Promise<boolean> {
    const id = await s.get(K.tag(tag)); if (!id) return true;
    const st = await storedGuild(id);
    if (st && (!st.emptySince || now() - st.emptySince < EMPTY_GUILD_HOLD_MS)) return false;
    if (st && (await memberCount(id)) > 0) return false;
    await s.del(K.tag(tag), K.guild(id)); await s.zrem(K.index, id);
    return true;
  }

  /** Start a guild (tag + name already normalized) and join it. The caller checks the username gate. */
  async function create(walletIn: string, tag: string, name: string): Promise<GuildResult> {
    const wallet = walletIn.toLowerCase();
    const bad = validateTag(tag) ?? validateGuildName(name);
    if (bad) return { ok: false, reason: bad, status: 400 };
    const cur = await memberOf(wallet);
    const blocked = await switchBlocked(wallet, cur); if (blocked) return blocked;
    const id = `u-${randomBytes(6).toString("hex")}`;
    let won = await s.setNX(K.tag(tag), id);
    if (!won && (await releaseStaleTag(tag))) won = await s.setNX(K.tag(tag), id);
    if (!won) return { ok: false, reason: GUILD_COPY.tagTaken, status: 409 };
    const st: Stored = { id, tag, name, mark: "", createdBy: wallet, createdAt: now() };
    await s.set(K.guild(id), JSON.stringify(st));
    await s.zadd(K.index, [{ score: st.createdAt, member: id }]);
    if (cur) { await removeFrom(wallet, cur.id); await s.set(K.last(wallet), String(now())); }
    await addTo(wallet, id);
    return { ok: true, guild: await withCount(fromStored(st)) };
  }

  /** Picker list: starter guilds, then the newest player-made guilds. With member counts. */
  async function list(limit = 48): Promise<Guild[]> {
    const ids = await s.zrange(K.index, limit, true);
    const made = (await Promise.all(ids.map(guildById))).filter((c): c is Guild => !!c);
    return Promise.all([...seedGuilds(), ...made].map(async (c) => (await withCount(c))!));
  }


  return { guildById, guildByTag, guildOf, tagsOf, join, leave, create, list, nextSwitchAt, memberCount, withCount };
}
export type GuildStore = ReturnType<typeof createGuildStore>;
