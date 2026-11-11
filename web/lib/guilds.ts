/**
 * Guilds V1, tags only. lee renamed clans to guilds (Mon Oct 26 2026, 8:59 AM CT). Plan: disciple-notes/clans-v1-plan.md
 * (written as "clans"). Pure, shared by client and server.
 * Flags became guilds: a guild is a 2–5 char tag (A–Z 0–9, upper case, unique, case-insensitive) a player wears next
 * to their name. One guild per player. Open: anyone can join any guild, no invites, no leader role.
 * Every default below is a constant so lee can change it in one place.
 * Starter guilds come from lib/guildSeed (swappable). Players with a claimed username can start new ones (lib/server/guilds).
 */
import { GUILD_LOGOS_COMMITTED, GUILD_SEED, guildLogoPath, type GuildCategory, type SeedGuild } from "./guildSeed";
import { maskProfanity } from "./chat/filter";
import { bioLength, sanitizeBio } from "./profileMeta";

/** mark: logo path under public/ for the 24×24 slot, or "" for the lettered placeholder. category: starter guilds only. */
export type Guild = { id: string; tag: string; name: string; mark: string; seed: boolean; category?: GuildCategory; members?: number };
/** What feeds carry next to a name: chat from.guild, /api/holders rows, window.__discipleGuilds. */
export type GuildTag = { id: string; tag: string; mark: string };

export const GUILD_TAG_MIN = 2;
export const GUILD_TAG_MAX = 5;
export const GUILD_TAG_RE = new RegExp(`^[A-Z0-9]{${GUILD_TAG_MIN},${GUILD_TAG_MAX}}$`);
/** g-… starter guilds (lib/guildSeed), u-… player-made guilds. */
export const GUILD_ID_RE = /^(g-[a-z0-9-]{1,30}|u-[0-9a-f]{12})$/;
/** One guild per player (the store keeps a single guild:member:<wallet> record; raising this needs a "primary" guild). */
export const GUILDS_PER_PLAYER = 1;
/** Country flags dropped with guilds: hidden in the profile header, edit sheet and leaderboard. Flip to bring them back. */
export const COUNTRY_FLAGS_ENABLED = false;
export const GUILD_NAME_MAX = 24;
/** Switching guilds (join another, or leave): once a day (lee default). */
export const GUILD_SWITCH_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** A guild with 0 members keeps its tag this long, then the tag frees up. */
export const EMPTY_GUILD_HOLD_MS = 30 * 24 * 60 * 60 * 1000;
export const RESERVED_TAGS: ReadonlySet<string> = new Set(["DSC", "ADMIN", "DEV", "MOD", "ROOT", "API", "YOU", "MODS", "STAFF", "TEAM", "HELP", "DSCPL"]);

const SEED_BY_ID = new Map<string, SeedGuild>(GUILD_SEED.map((c) => [c.id, c]));
const SEED_BY_TAG = new Map<string, SeedGuild>(GUILD_SEED.map((c) => [c.tag, c]));
const fromSeed = (s: SeedGuild): Guild => ({ id: s.id, tag: s.tag, name: s.name, category: s.category, mark: GUILD_LOGOS_COMMITTED && s.coingeckoId ? guildLogoPath(s.id) : "", seed: true });
export const seedGuild = (id: string): Guild | null => { const s = SEED_BY_ID.get(id); return s ? fromSeed(s) : null; };
export const seedGuildByTag = (tag: string): Guild | null => { const s = SEED_BY_TAG.get(normalizeTag(tag)); return s ? fromSeed(s) : null; };
export const seedGuilds = (): Guild[] => GUILD_SEED.map(fromSeed);

export const normalizeTag = (s: unknown) => String(s ?? "").trim().replace(/^\[|\]$/g, "").toUpperCase();
export const isGuildId = (s: unknown): s is string => typeof s === "string" && GUILD_ID_RE.test(s);

/** null when the (normalized) tag can be used for a NEW guild, else a short reason for the player. */
export function validateTag(tag: string): string | null {
  if (!GUILD_TAG_RE.test(tag)) return GUILD_COPY.tagRule;
  if (RESERVED_TAGS.has(tag) || SEED_BY_TAG.has(tag)) return GUILD_COPY.tagTaken;
  if (maskProfanity(tag) !== tag || maskProfanity(tag.toLowerCase()) !== tag.toLowerCase()) return GUILD_COPY.tagBlocked;
  return null;
}
/** Canonical guild name: same clean-up as the bio, then the chat word filter. */
export const sanitizeGuildName = (s: unknown) => sanitizeBio(s);
export function validateGuildName(name: string): string | null {
  if (!name) return GUILD_COPY.nameNeeded;
  if (bioLength(name) > GUILD_NAME_MAX || name.length > 200) return GUILD_COPY.nameRule;
  if (maskProfanity(name) !== name) return GUILD_COPY.nameBlocked;
  return null;
}
export const toTag = (c: Guild | null | undefined): GuildTag | null => (c ? { id: c.id, tag: c.tag, mark: c.mark } : null);

export type GuildAction = "create" | "join" | "leave";
/** Signed by the wallet for each action (same idea as profileMetaMessage). Covers every field + a single-use nonce. */
export const guildActionMessage = (action: GuildAction, address: string, p: { guildId?: string; tag?: string; name?: string }, nonce: string) =>
  `DISCIPLE guild ${action}\n\nWallet: ${address.toLowerCase()}\n` +
  (action === "create" ? `Tag: ${p.tag}\nName: ${p.name}\n` : action === "join" ? `Guild: ${p.guildId}\n` : "") +
  `Nonce: ${nonce}\n\nSigning proves you own this wallet. It costs nothing and sends no transaction.`;

/** Player copy. Pending lee approval (listed in the PR body); BRAND finishes the picker copy. Dollars-free, no jargon. */
export const GUILD_COPY = {
  label: "Guild",
  helper: "Pick a guild. Your tag shows next to your name everywhere.",
  none: "No guild",
  pick: "Pick a guild",
  join: "Join",
  joined: "Joined",
  leave: "Leave guild",
  start: "Start a guild",
  search: "Search by tag",
  noMatch: "No guild with that tag yet.",
  tagLabel: "Tag",
  tagHelp: `${GUILD_TAG_MIN} to ${GUILD_TAG_MAX} letters or numbers.`,
  nameLabel: "Guild name",
  create: "Start guild",
  needUsername: "Claim a username first to start a guild.",
  tagRule: `Tags are ${GUILD_TAG_MIN} to ${GUILD_TAG_MAX} letters or numbers.`,
  tagTaken: "That tag is taken.",
  tagBlocked: "That tag isn't allowed.",
  nameNeeded: "Give your guild a name.",
  nameRule: `Guild names are up to ${GUILD_NAME_MAX} characters.`,
  nameBlocked: "That name isn't allowed.",
  wait: (when: string) => `You can switch guilds again ${when}.`,
  members: (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "member" : "members"}`,
  signIn: "Sign in to pick a guild.",
  failed: "Could not save your guild. Try again.",
  declined: "Signature declined.",
  unknown: "That guild doesn't exist.",
  wear: (tag: string) => `Guild ${tag}`,
  playerGuilds: "Player guilds",
  starterNote: "Community tags. Not affiliated with or endorsed by any project.",
} as const;
