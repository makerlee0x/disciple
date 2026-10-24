import "server-only";
/**
 * Profile meta (pfp / bio / flag) on lib/server/kv, next to the username registry (lib/server/usernames).
 * Key: user:meta:<wallet lowercase> → JSON ProfileMeta. Values are validated by /api/profile/meta before they land here,
 * and re-validated on read so a bad stored value never reaches the page.
 */
import { kv } from "./kv";
import { EMPTY_META, isFlag, isPfpId, sanitizeBio, type ProfileMeta, BIO_MAX, bioLength } from "@/lib/profileMeta";

const metaKey = (a: string) => `user:meta:${a.toLowerCase()}`;

export async function metaOf(wallet: string): Promise<ProfileMeta> {
  const raw = await kv().get(metaKey(wallet));
  if (!raw) return { ...EMPTY_META };
  try {
    const j = JSON.parse(raw) as Partial<ProfileMeta>;
    const bio = sanitizeBio(j.bio);
    return {
      pfp: typeof j.pfp === "string" && isPfpId(j.pfp) ? j.pfp : "",
      bio: bioLength(bio) <= BIO_MAX ? bio : "",
      flag: typeof j.flag === "string" && isFlag(j.flag) ? j.flag : "",
    };
  } catch { return { ...EMPTY_META }; }
}

export async function setMeta(wallet: string, m: ProfileMeta): Promise<void> {
  await kv().set(metaKey(wallet), JSON.stringify({ pfp: m.pfp, bio: m.bio, flag: m.flag }));
}
