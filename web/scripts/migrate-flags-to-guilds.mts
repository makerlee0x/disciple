/**
 * One-off: clear every old profile flag (Guilds V1). See lib/guildMigration.ts. DO NOT run against production until lee
 * says so; it is not wired into any deploy.
 *
 *   npx tsx scripts/migrate-flags-to-guilds.mts                 # dry run on the local dev KV file (KV_LOCAL_FILE or /tmp/disciple-kv.json)
 *   npx tsx scripts/migrate-flags-to-guilds.mts --apply         # write, local file
 *   npx tsx scripts/migrate-flags-to-guilds.mts --target=upstash [--apply]
 *        uses UPSTASH_REDIS_REST_URL / _TOKEN (or KV_REST_API_URL / _TOKEN) from the shell; SCANs user:meta:*
 * Dry run is the default. Prints counts only (never values, never tokens).
 */
import { readFile, writeFile } from "node:fs/promises";
import { clearOldFlag } from "../lib/guildMigration.ts";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const target = [...args].find((a) => a.startsWith("--target="))?.split("=")[1] ?? "local";
const PREFIX = "user:meta:";

async function local() {
  const file = process.env.KV_LOCAL_FILE || "/tmp/disciple-kv.json";
  let st: { kv?: Record<string, { v: string; exp: number }> };
  try { st = JSON.parse(await readFile(file, "utf8")); } catch { console.log(`no local KV file at ${file}: nothing to do`); return; }
  let seen = 0, changed = 0;
  for (const [k, e] of Object.entries(st.kv ?? {})) {
    if (!k.startsWith(PREFIX)) continue;
    seen++;
    const next = clearOldFlag(e.v);
    if (next) { changed++; if (apply) e.v = next; }
  }
  if (apply && changed) await writeFile(file, JSON.stringify(st));
  console.log(`local ${file}: ${seen} profiles, ${changed} with an old flag ${apply ? "cleared" : "(dry run, nothing written)"}`);
}

async function upstash() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !tok) { console.error("set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in this shell"); process.exit(2); }
  const cmd = async <T,>(...a: (string | number)[]): Promise<T> => {
    const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(a) });
    const j = (await r.json()) as { result?: T; error?: string };
    if (!r.ok || j.error) throw new Error(`upstash ${j.error || r.status}`);
    return j.result as T;
  };
  let cursor = "0", seen = 0, changed = 0;
  do {
    const [next, keys] = await cmd<[string, string[]]>("SCAN", cursor, "MATCH", `${PREFIX}*`, "COUNT", 500);
    cursor = next;
    for (const k of keys) {
      seen++;
      const v = clearOldFlag(await cmd<string | null>("GET", k));
      if (v) { changed++; if (apply) await cmd("SET", k, v); }
    }
  } while (cursor !== "0");
  console.log(`upstash: ${seen} profiles, ${changed} with an old flag ${apply ? "cleared" : "(dry run, nothing written)"}`);
}

await (target === "upstash" ? upstash() : local());
