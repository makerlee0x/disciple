import "server-only";
/** Guilds on lib/server/kv (Upstash in production, local file in dev). The logic lives in ./guildStore (unit-tested). */
import { kv } from "./kv";
import { createGuildStore, type GuildStore } from "./guildStore";

export const guilds = (): GuildStore => createGuildStore(kv());
/** Best-effort batch read for feeds: never throws (a KV hiccup just drops the tags). */
export async function guildTagsOf(wallets: string[]) {
  try { return await guilds().tagsOf(wallets); } catch (e) { console.warn("[guilds] tagsOf failed:", (e as Error).message); return {}; }
}
