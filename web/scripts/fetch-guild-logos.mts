/**
 * One-off, for lee's review: download the starter guilds' logos from CoinGecko's public API into OUR folder, so the
 * site serves its own copies (never hotlinks). Nothing here runs in the build or at request time.
 *
 *   npx tsx scripts/fetch-guild-logos.mts                                  # → public/guilds/<id>.<ext>
 *   npx tsx scripts/fetch-guild-logos.mts --out=/workspace/disciple-notes/guild-logos [--only=g-pepe,g-mog]
 *
 * Guilds with coingeckoId null (no confident CoinGecko match) are skipped. Downloaded files are NOT committed until lee
 * has checked each logo and its licensing; then set GUILD_LOGOS_COMMITTED = true in lib/guildSeed.ts (expects .png).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { GUILD_SEED } from "../lib/guildSeed.ts";

const outArg = process.argv.slice(2).find((a) => a.startsWith("--out="))?.slice(6);
const out = path.resolve(outArg || path.join(import.meta.dirname, "..", "public", "guilds"));
await mkdir(out, { recursive: true });
const API = "https://api.coingecko.com/api/v3/coins";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const only = process.argv.slice(2).find((a) => a.startsWith("--only="))?.slice(7).split(",");
/** CoinGecko's free tier answers 429 in bursts: back off and retry a few times. */
async function getRetry(url: string, init: RequestInit) {
  for (let i = 0; ; i++) {
    const r = await fetch(url, init);
    if (r.status !== 429 || i >= 4) return r;
    await sleep(15_000 * (i + 1));
  }
}

for (const g of GUILD_SEED) {
  if (only && !only.includes(g.id)) continue;
  if (!g.coingeckoId) { console.log(`skip ${g.id} (${g.tag}): no CoinGecko id`); continue; }
  try {
    const r = await getRetry(`${API}/${encodeURIComponent(g.coingeckoId)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`coin ${r.status}`);
    const j = (await r.json()) as { name?: string; symbol?: string; image?: { large?: string } };
    const src = j.image?.large;
    if (!src) throw new Error("no image");
    const img = await fetch(src);
    if (!img.ok) throw new Error(`image ${img.status}`);
    const type = (img.headers.get("content-type") || "").split(";")[0].trim();
    const ext = ({ "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/svg+xml": ".svg", "image/gif": ".gif" } as Record<string, string>)[type] ?? ".png";
    const file = path.join(out, `${g.id}${ext}`);
    await writeFile(file, Buffer.from(await img.arrayBuffer()));
    console.log(`ok   ${g.id} (${g.tag}) ← ${g.coingeckoId} "${j.name}" ${String(j.symbol).toUpperCase()} → ${file}${ext === ".png" ? "" : "  (not .png: convert before committing)"}`);
  } catch (e) {
    console.log(`fail ${g.id} (${g.tag}) ← ${g.coingeckoId}: ${(e as Error).message}`);
  }
  await sleep(6000); // public API rate limit
}
