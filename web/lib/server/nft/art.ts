import "server-only";
/**
 * Revealed Disciple art (maker 2026-11-17): the original 777 files (hashlips json/ + FINAL NFTS/ PNGs) sit in maker's
 * public Google Drive folder "DISCIPLE NFTS". /admin/mint copies them into Vercel Blob (maker picked Blob):
 *   nft/disciples/<n>.png   the original PNG, byte for byte (checked: #505 matches the on-chain copy)
 *   nft/disciples/<n>.json  metadata in the same shape as the revealed LaunchMyNFT ones, image → the Blob PNG
 * New mints point at REVEALED_BASE<n>.json (our domain, app/nft/d/[file]), which serves the Blob JSON.
 * Trait values: hashlips wrote "StudytheBible"; the revealed on-chain ones read "Study the Bible". The spelling is
 * learned from the revealed NFTs (Helius) so marketplace trait filters don't split; unseen values get spaced by rule.
 */
import { list, put } from "@vercel/blob";
import { kv } from "../kv";
import { solRpc, solanaConfigured } from "./chain";
import { DISCIPLE_COLLECTION, DISCIPLE_ROYALTY_BPS, DISCIPLE_SUPPLY, DISCIPLE_SYMBOL, DISCIPLE_TREASURY, NAME_PREFIX } from "@/lib/nft/config";
import drive from "@/lib/nft/driveArt.json";

export const ART_PREFIX = "nft/disciples/";
const BASE_KEY = "nft:artbase", MAP_KEY = "nft:traitmap";
const DESC = "777 disciples of $JESUS spreading the gospel on the blockchain. 🙏 ";

export const blobConfigured = () => !!process.env.BLOB_READ_WRITE_TOKEN;
const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** "BreastplateofRighteousness" → "Breastplate of Righteousness" (fallback for values no revealed NFT shows yet) */
const spaced = (s: string) => s.replace(/\s+/g, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([a-z])(of|the|and|in|to|for) (?=[A-Z])/g, "$1 $2 ").replace(/\s+/g, " ").trim();

type DasAsset = { burnt?: boolean; content?: { metadata?: { attributes?: { trait_type?: string; value?: unknown }[] } } };

/** compact(value) → on-chain spelling, from every revealed disciple. Cached in KV; `fresh` re-reads the chain. */
export async function traitMap(fresh = false): Promise<Record<string, string>> {
  if (!fresh) { const c = await kv().get(MAP_KEY).catch(() => null); if (c) try { return JSON.parse(c) as Record<string, string>; } catch { /* rebuild */ } }
  const map: Record<string, string> = {};
  if (!solanaConfigured()) return map;
  for (let page = 1; page <= 5; page++) {
    const p = await solRpc<{ items: DasAsset[] }>("getAssetsByGroup", { groupKey: "collection", groupValue: DISCIPLE_COLLECTION, page, limit: 1000 }, 15000);
    for (const a of p.items) for (const t of a.content?.metadata?.attributes ?? []) {
      if (t.trait_type && typeof t.value === "string" && t.value.trim()) map[`${compact(t.trait_type)}:${compact(t.value)}`] = t.value.trim();
    }
    if (p.items.length < 1000) break;
  }
  await kv().set(MAP_KEY, JSON.stringify(map)).catch(() => {});
  return map;
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

type Hashlips = { name?: string; edition?: number; attributes?: { trait_type?: string; value?: string }[] };

/** Copy disciple #n to Blob. Returns the trait values that had no on-chain spelling yet. */
export async function importOne(n: number, map: Record<string, string>): Promise<{ unmapped: string[]; base: string }> {
  const jsonId = (drive.json as string[])[n], pngId = (drive.png as string[])[n];
  if (!jsonId || !pngId) throw new Error(`#${n}: not in the Drive list`);
  const src = JSON.parse((await driveFetch(jsonId, `${n}.json`)).toString("utf8")) as Hashlips;
  if (src.edition !== n || !src.name?.endsWith(`#${n}`)) throw new Error(`#${n}: Drive file says ${src.name ?? "?"}`);
  const png = await driveFetch(pngId, `${n}.png`);
  if (png.subarray(0, 4).toString("hex") !== "89504e47") throw new Error(`#${n}: Drive image isn't a PNG`);
  const img = await put(`${ART_PREFIX}${n}.png`, png, { access: "public", contentType: "image/png", addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 31_536_000 });
  const unmapped: string[] = [];
  const attributes = (src.attributes ?? []).map((t) => {
    const type = String(t.trait_type ?? ""), raw = String(t.value ?? "");
    const hit = map[`${compact(type)}:${compact(raw)}`];
    if (!hit) unmapped.push(`${type}: ${raw}`);
    return { trait_type: type, value: hit ?? spaced(raw) };
  });
  const name = `${NAME_PREFIX}${n}`;
  const meta = {
    name, symbol: DISCIPLE_SYMBOL, description: `${name} - ${DESC}`, seller_fee_basis_points: DISCIPLE_ROYALTY_BPS,
    image: img.url, external_url: "", attributes,
    properties: { files: [{ uri: img.url, type: "image/png" }], category: "image", creators: [{ address: DISCIPLE_TREASURY, share: 100 }] },
  };
  const js = await put(`${ART_PREFIX}${n}.json`, JSON.stringify(meta), { access: "public", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 300 });
  const base = js.url.slice(0, js.url.length - `${n}.json`.length);
  await kv().set(BASE_KEY, base).catch(() => {});
  return { unmapped, base };
}

/** Blob folder URL ("https://<store>.public.blob.vercel-storage.com/nft/disciples/") once anything was imported. */
export const artBase = async () => (await kv().get(BASE_KEY).catch(() => null)) || null;

/** Which numbers have both files in Blob. */
export async function importedNumbers(): Promise<number[]> {
  const json = new Set<number>(), png = new Set<number>();
  let cursor: string | undefined;
  do {
    const r = await list({ prefix: ART_PREFIX, limit: 1000, cursor });
    for (const b of r.blobs) {
      const m = b.pathname.slice(ART_PREFIX.length).match(/^(\d{1,3})\.(json|png)$/);
      if (m) (m[2] === "json" ? json : png).add(Number(m[1]));
    }
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return Array.from({ length: DISCIPLE_SUPPLY }, (_, i) => i).filter((i) => json.has(i) && png.has(i));
}
