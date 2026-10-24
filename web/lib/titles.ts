/**
 * Profile titles (lee, 2026-10-24, "like Guild Wars"): a player shows ONE earned title next to their name and can
 * change it any time. Titles are the identity labels in lib/identity (Believer, Gate Keeper, Diamond Hands, …), earned
 * from playstyle metrics. They are NOT the season tier (ANOINTED, points → lib/config seasonRank) or the level
 * (points → lib/prestige); those stay as they are.
 *
 * Earned = deriveIdentity(stats).matched. Pure and shared by the client (header, picker) and the server
 * (/api/profile/meta validates a chosen title against the same set). Stats come from profileStatsFor(): TODAY THAT IS
 * SAMPLE DATA (lib/mock/sample-trades, seeded by username, else address) because the indexer doesn't serve per-wallet
 * playstyle stats yet. The server check therefore proves "earned on the profile as shown", not real play; swap
 * profileStatsFor() for real stats and both sides follow.
 *
 * Default (no pick yet, or the pick is no longer earned): the highest-weight earned title, i.e. the same title the
 * header showed first before titles were pickable. Titles have no rarity or earned-at time, so weight is the rule.
 */
import { IDENTITIES, identityRuleText, type IdentityDef, type IdentityId } from "./identity";
import { PROFILE_COPY } from "./copy/profile";
import { PERSONAS, buildPersonaStats, type PersonaBundle, type PersonaId } from "./mock/sample-trades";

export const TITLE_IDS: readonly IdentityId[] = IDENTITIES.map((d) => d.id);
const BY_ID = new Map<string, IdentityDef>(IDENTITIES.map((d) => [d.id, d]));
export const isTitleId = (s: string): s is IdentityId => BY_ID.has(s);
export const titleDef = (id: string): IdentityDef | null => BY_ID.get(id) ?? null;
/** Tooltip text: the rule, then the blurb. */
export const titleTooltip = (id: IdentityId): string => { const d = BY_ID.get(id); return d ? `${identityRuleText(id)}. ${d.blurb}` : ""; };

/** Seed for the (sample) stats: claimed username, else the wallet address. Same on profile pages and the server. */
export const profileStatsSeed = (username: string | null | undefined, address: string | null | undefined) =>
  String(username || "").trim().toLowerCase().replace(/^@/, "") || String(address || "").trim().toLowerCase();

export function samplePersonaFor(seed: string): PersonaId {
  if (!seed) return "believer";
  const ids = Object.keys(PERSONAS) as PersonaId[];
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ids[h % ids.length];
}
/** The one place profile stats come from (SAMPLE until the indexer serves real per-wallet stats). */
export const profileStatsFor = (seed: string): PersonaBundle => buildPersonaStats(samplePersonaFor(seed));

/** Earned title ids, best (highest weight) first. */
export function earnedTitleIds(matched: readonly IdentityDef[]): IdentityId[] {
  return [...matched].sort((a, b) => b.weight - a.weight).map((d) => d.id);
}
export const earnedTitlesFor = (seed: string): IdentityId[] => earnedTitleIds(profileStatsFor(seed).identity.matched);

export const defaultTitle = (earned: readonly IdentityId[]): IdentityId | null => earned[0] ?? null;
/** What the header shows: the pick if it's still earned, else the default. null = no title earned. */
export function shownTitle(chosen: string | null | undefined, earned: readonly IdentityId[]): IdentityId | null {
  return chosen && (earned as readonly string[]).includes(chosen) ? (chosen as IdentityId) : defaultTitle(earned);
}

export const TITLE_ERRORS = {
  unknown: PROFILE_COPY["edit.title.error.unknown"],
  locked: PROFILE_COPY["edit.title.error.locked"],
} as const;
/** null = ok. "" = no pick (use the default). */
export function validateTitle(chosen: string, earned: readonly IdentityId[]): string | null {
  if (!chosen) return null;
  if (!isTitleId(chosen)) return TITLE_ERRORS.unknown;
  if (!earned.includes(chosen)) return TITLE_ERRORS.locked;
  return null;
}
