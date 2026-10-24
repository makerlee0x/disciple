import "server-only";
/**
 * Profile meta (pfp / bio / flag) on lib/server/kv, next to the username registry (lib/server/usernames).
 * Key: user:meta:<wallet lowercase> → JSON { pfp, bio, flag, lastUsernameChangeAt? }. Values are validated by
 * /api/profile/meta before they land here, and re-validated on read so a bad stored value never reaches the page.
 * lastUsernameChangeAt (ms epoch) is written only by /api/profile/username (24h rename cooldown, lib/usernameCooldown);
 * a meta save keeps it.
 */
import { kv } from "./kv";
import { isFlag, isPfpId, sanitizeBio, type ProfileMeta, BIO_MAX, bioLength } from "@/lib/profileMeta";

const metaKey = (a: string) => `user:meta:${a.toLowerCase()}`;
type Stored = Partial<ProfileMeta> & { lastUsernameChangeAt?: unknown };

async function readStored(wallet: string): Promise<Stored> {
  const raw = await kv().get(metaKey(wallet));
  if (!raw) return {};
  try { const j = JSON.parse(raw); return j && typeof j === "object" ? (j as Stored) : {}; } catch { return {}; }
}

export async function metaOf(wallet: string): Promise<ProfileMeta> {
  const j = await readStored(wallet);
  const bio = sanitizeBio(j.bio);
  return {
    pfp: typeof j.pfp === "string" && isPfpId(j.pfp) ? j.pfp : "",
    bio: bioLength(bio) <= BIO_MAX ? bio : "",
    flag: typeof j.flag === "string" && isFlag(j.flag) ? j.flag : "",
  };
}

export async function setMeta(wallet: string, m: ProfileMeta): Promise<void> {
  const prev = await readStored(wallet);
  const keep = typeof prev.lastUsernameChangeAt === "number" ? { lastUsernameChangeAt: prev.lastUsernameChangeAt } : {};
  await kv().set(metaKey(wallet), JSON.stringify({ pfp: m.pfp, bio: m.bio, flag: m.flag, ...keep }));
}

/** Last counted username change (ms epoch), or null. */
export async function lastUsernameChangeAt(wallet: string): Promise<number | null> {
  const v = (await readStored(wallet)).lastUsernameChangeAt;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function markUsernameChange(wallet: string, at: number): Promise<void> {
  const prev = await readStored(wallet);
  await kv().set(metaKey(wallet), JSON.stringify({ ...prev, lastUsernameChangeAt: at }));
}
