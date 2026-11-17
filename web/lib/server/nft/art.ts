import "server-only";
/**
 * Revealed Disciple art (maker 2026-11-17). The originals (hashlips, 1024px PNGs ~2 MB) sit in maker's public Google Drive
 * folder "DISCIPLE NFTS". maker picked Vercel Blob on the Hobby tier for now (maybe Arweave later), so the set is lighter:
 *   - /admin/mint copies each PNG from Drive into Blob as nft/disciples/<n>.webp (full 1024px, WebP q95, ~360 KB, ~280 MB
 *     in all; 777 writes, inside Hobby's 1 GB / 2,000 writes).
 *   - Traits are in the repo (lib/nft/discipleTraits.json, from the drop's _metadata.json; checked against the files).
 *   - app/nft/d/[file] serves <n>.json (built here) and <n>.webp (→ Blob) on our domain. Our Candy Machine writes
 *     REVEALED_BASE<n>.json on-chain, so moving the art later only changes that route, never an NFT.
 * Trait values: hashlips wrote "StudytheBible"; the revealed on-chain ones read "Study the Bible". The spelling is learned
 * from the revealed NFTs (Helius) so marketplace trait filters don't split; values no NFT shows yet are spaced by rule.
 */
import sharp from "sharp";
import { list, put } from "@vercel/blob";
import { kv } from "../kv";
import { solRpc, solanaConfigured } from "./chain";
import { DISCIPLE_COLLECTION, DISCIPLE_ROYALTY_BPS, DISCIPLE_SUPPLY, DISCIPLE_SYMBOL, DISCIPLE_TREASURY, NAME_PREFIX, REVEALED_BASE } from "@/lib/nft/config";
import drive from "@/lib/nft/driveArt.json";
import traits from "@/lib/nft/discipleTraits.json";

export const ART_PREFIX = "nft/disciples/";
const BASE_KEY = "nft:artbase", MAP_KEY = "nft:traitmap";
const DESC = "777 disciples of $JESUS spreading the gospel on the blockchain. 🙏 ";

export const blobConfigured = () => !!process.env.BLOB_READ_WRITE_TOKEN;
const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** "BreastplateofRighteousness" → "Breastplate of Righteousness" (fallback for values no revealed NFT shows yet) */
export const spaced = (s: string) => s.replace(/\s+/g, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([a-z])(of|the|and|in|to|for) (?=[A-Z])/g, "$1 $2 ").replace(/\s+/g, " ").trim();

type DasAsset = { content?: { metadata?: { attributes?: { trait_type?: string; value?: unknown }[] } } };

/** compact(type):compact(value) → on-chain spelling, from every revealed disciple. Cached in KV; `fresh` re-reads the chain. */
export async function traitMap(fresh = false): Promise<Record<string, string>> {
  if (!fresh) { const c = await kv().get(MAP_KEY).catch(() => null); if (c) try { return JSON.parse(c) as Record<string, string>; } catch { /* rebuild */ } }
  const map: Record<string, string> = {};
  if (!solanaConfigured()) return map;
  try {
    for (let page = 1; page <= 5; page++) {
      const p = await solRpc<{ items: DasAsset[] }>("getAssetsByGroup", { groupKey: "collection", groupValue: DISCIPLE_COLLECTION, page, limit: 1000 }, 15000);
      for (const a of p.items) for (const t of a.content?.metadata?.attributes ?? []) {
        if (t.trait_type && typeof t.value === "string" && t.value.trim()) map[`${compact(t.trait_type)}:${compact(t.value)}`] = t.value.trim();
      }
      if (p.items.length < 1000) break;
    }
  } catch (e) { console.warn("[disciple] nft: traitMap read failed", String(e).replace(/api-key=[^&\s]+/g, "api-key=…")); return map; }
  if (Object.keys(map).length) await kv().set(MAP_KEY, JSON.stringify(map)).catch(() => {});
  return map;
}

/** Attributes of disciple #n with on-chain spelling, plus the values that fell back to the rule. */
export function attributesOf(n: number, map: Record<string, string>): { attributes: { trait_type: string; value: string }[]; unmapped: string[] } {
  const row = (traits.rows as string[][])[n] ?? [], unmapped: string[] = [];
  const attributes = traits.order.map((type, i) => {
    const raw = row[i] ?? "", hit = map[`${compact(type)}:${compact(raw)}`];
    if (!hit) unmapped.push(`${type}: ${raw}`);
    return { trait_type: type, value: hit ?? spaced(raw) };
  });
  return { attributes, unmapped };
}

/** The metadata JSON our machine's NFTs point at (same shape as the revealed LaunchMyNFT disciples). */
export function metadataOf(n: number, map: Record<string, string>) {
  const name = `${NAME_PREFIX}${n}`, image = `${REVEALED_BASE}${n}.webp`;
  return {
    name, symbol: DISCIPLE_SYMBOL, description: `${name} - ${DESC}`, seller_fee_basis_points: DISCIPLE_ROYALTY_BPS,
    image, external_url: "", attributes: attributesOf(n, map).attributes,
    properties: { files: [{ uri: image, type: "image/webp" }], category: "image", creators: [{ address: DISCIPLE_TREASURY, share: 100 }] },
  };
}

const driveUrl = (id: string) => `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
async function driveFetch(id: string, what: string): Promise<Buffer> {
  let last = "";
  for (let tries = 0; tries < 3; tries++) {
    try {
      const r = await fetch(driveUrl(id), { cache: "no-store", signal: AbortSignal.timeout(20_000) });
      const b = Buffer.from(await r.arrayBuffer());
      if (r.ok && !(r.headers.get("content-type") ?? "").includes("text/html")) return b;
      last = `${r.status} ${r.headers.get("content-type") ?? ""}`;
    } catch (e) { last = String(e); }
    await new Promise((res) => setTimeout(res, 800 * (tries + 1)));
  }
  throw new Error(`Drive ${what}: ${last}`);
}

/** Blob folder URL ("https://<store>.public.blob.vercel-storage.com/nft/disciples/") once anything was imported. */
export const artBase = async () => (await kv().get(BASE_KEY).catch(() => null)) || null;

/** Copy disciple #n's art to Blob (one write). */
export async function importOne(n: number): Promise<void> {
  const pngId = (drive.png as string[])[n];
  if (!pngId) throw new Error(`#${n}: not in the Drive list`);
  const png = await driveFetch(pngId, `${n}.png`);
  if (png.subarray(0, 4).toString("hex") !== "89504e47") throw new Error(`#${n}: Drive file isn't a PNG`);
  const webp = await sharp(png).webp({ quality: 95, effort: 5 }).toBuffer();
  const b = await put(`${ART_PREFIX}${n}.webp`, webp, { access: "public", contentType: "image/webp", addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 31_536_000 });
  const base = b.url.slice(0, b.url.length - `${n}.webp`.length);
  if (base !== (await artBase())) await kv().set(BASE_KEY, base).catch(() => {});
}

/** Which numbers have their art in Blob (one list call per 1000). */
export async function importedNumbers(): Promise<number[]> {
  const have = new Set<number>();
  let cursor: string | undefined;
  do {
    const r = await list({ prefix: ART_PREFIX, limit: 1000, cursor });
    for (const b of r.blobs) { const m = b.pathname.slice(ART_PREFIX.length).match(/^(\d{1,3})\.webp$/); if (m) have.add(Number(m[1])); }
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return Array.from({ length: DISCIPLE_SUPPLY }, (_, i) => i).filter((i) => have.has(i));
}
