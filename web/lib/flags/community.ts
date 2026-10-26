/**
 * Coin-community flags, offered next to country flags in the profile flag picker (lee, 2026-10-24).
 * Add / remove a community here: { id, label, asset }. `id` is what gets stored and signed (lib/profileMeta), so keep it
 * stable once shipped; ids are lower case with a "c-" prefix so they can never collide with an ISO country code.
 * `asset` lives under public/. The current SVGs are PLACEHOLDERS (label initials on brand tokens) until BRAND delivers
 * the real art; swap the files, keep the ids.
 */
export type CommunityFlag = { id: string; label: string; asset: string };

export const COMMUNITY_FLAGS: readonly CommunityFlag[] = [
  { id: "c-pepe", label: "PEPE", asset: "/flags/community/c-pepe.svg" },
  { id: "c-cryptopunks", label: "CryptoPunks", asset: "/flags/community/c-cryptopunks.svg" },
  { id: "c-mog", label: "MOG", asset: "/flags/community/c-mog.svg" },
  { id: "c-ai", label: "AI", asset: "/flags/community/c-ai.svg" },
  { id: "c-doge", label: "DOGE", asset: "/flags/community/c-doge.svg" },
  { id: "c-bonk", label: "BONK", asset: "/flags/community/c-bonk.svg" },
];

export const COMMUNITY_FLAG_ID_RE = /^c-[a-z0-9-]{1,30}$/;
const BY_ID = new Map(COMMUNITY_FLAGS.map((f) => [f.id, f]));
export const isCommunityFlag = (id: string) => BY_ID.has(id);
export const communityFlag = (id: string): CommunityFlag | null => BY_ID.get(id) ?? null;
