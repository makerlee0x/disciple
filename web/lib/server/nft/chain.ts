import "server-only";
/**
 * Reads for Disciple NFTs.
 *  - Solana: Helius (HELIUS_API_KEY) RPC + DAS. Without the key every read answers "unknown" (null), never "doesn't own".
 *  - Ethereum founder passes: OpenSea API v2 (OPENSEA_API_KEY), by collection slug, so it works for ERC-721 or ERC-1155.
 * Short in-memory caches; callers cache longer in KV where it matters.
 */
import { DISCIPLE_COLLECTION, FOUNDER_SLUG, FOUNDER_URL, itemIndex, type OwnedNft } from "@/lib/nft/config";

export const heliusUrl = () => {
  const k = process.env.HELIUS_API_KEY?.trim();
  return process.env.HELIUS_RPC_URL?.trim() || (k ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(k)}` : "");
};
export const solanaConfigured = () => !!heliusUrl();
export const foundersConfigured = () => !!process.env.OPENSEA_API_KEY?.trim();

export async function solRpc<T>(method: string, params: unknown, timeoutMs = 8000): Promise<T> {
  const url = heliusUrl();
  if (!url) throw new Error("solana rpc not configured");
  const r = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
    body: JSON.stringify({ jsonrpc: "2.0", id: "disciple", method, params }), signal: AbortSignal.timeout(timeoutMs),
  });
  const j = (await r.json().catch(() => null)) as { result?: T; error?: { message?: string } } | null;
  if (!r.ok || !j || j.error || j.result === undefined) throw new Error(`rpc ${method}: ${j?.error?.message || r.status}`);
  return j.result;
}

type DasAsset = {
  id: string; burnt?: boolean;
  content?: { json_uri?: string; metadata?: { name?: string }; links?: { image?: string }; files?: { uri?: string; cdn_uri?: string }[] };
  grouping?: { group_key: string; group_value: string; verified?: boolean }[];
  ownership?: { owner?: string };
};
type DasPage = { total: number; limit: number; page: number; items: DasAsset[] };

const inCollection = (a: DasAsset) =>
  !a.burnt && !!a.grouping?.some((g) => g.group_key === "collection" && g.group_value === DISCIPLE_COLLECTION && g.verified !== false);
const imageOf = (a: DasAsset) => a.content?.links?.image || a.content?.files?.[0]?.uri || "";
const toOwned = (a: DasAsset): OwnedNft => ({ chain: "sol", id: a.id, name: a.content?.metadata?.name || "Disciple", image: imageOf(a), thumb: a.content?.files?.[0]?.cdn_uri || undefined });

/** Disciples a Solana wallet holds (verified collection only). null = couldn't check. */
export async function disciplesOf(owner: string): Promise<OwnedNft[] | null> {
  if (!solanaConfigured()) return null;
  try {
    const p = await solRpc<DasPage>("searchAssets", { ownerAddress: owner, grouping: ["collection", DISCIPLE_COLLECTION], page: 1, limit: 1000 });
    return p.items.filter(inCollection).map(toOwned);
  } catch (e) { console.warn("[disciple] nft: disciplesOf failed", String(e)); return null; }
}

/** One disciple by mint, with its current owner. null = not ours / couldn't check. */
export async function discipleById(mint: string): Promise<(OwnedNft & { owner: string }) | null> {
  if (!solanaConfigured()) return null;
  try {
    const a = await solRpc<DasAsset>("getAsset", { id: mint });
    if (!a || !inCollection(a) || !a.ownership?.owner) return null;
    return { ...toOwned(a), owner: a.ownership.owner };
  } catch (e) { console.warn("[disciple] nft: discipleById failed", String(e)); return null; }
}

/** Every minted disciple's drop item index (0..776), from its metadata uri. Also the minted count. */
export async function mintedItems(): Promise<{ count: number; items: number[]; unknown: number } | null> {
  if (!solanaConfigured()) return null;
  try {
    const all: DasAsset[] = [];
    for (let page = 1; page <= 5; page++) {
      const p = await solRpc<DasPage>("getAssetsByGroup", { groupKey: "collection", groupValue: DISCIPLE_COLLECTION, page, limit: 1000 }, 15000);
      all.push(...p.items);
      if (p.items.length < 1000) break;
    }
    // burnt ones still used their item: count them as minted (their metadata uri is gone from the drop)
    const items = new Set<number>(); let unknown = 0;
    for (const a of all) {
      const i = itemIndex(a.content?.json_uri || "");
      if (i === null) unknown++; else items.add(i);
    }
    return { count: all.length, items: [...items].sort((x, y) => x - y), unknown };
  } catch (e) { lastReadError = String(e).replace(/api-key=[^&\s]+/g, "api-key=…").slice(0, 200); console.warn("[disciple] nft: mintedItems failed", lastReadError); return null; }
}
/** Last Solana read error (key redacted), for /api/nft/mint's `reads` field. */
export let lastReadError = "";

/* ------------------------------------------------ Ethereum founder passes (OpenSea) ------------------------------------------------ */

type OsNft = { identifier: string; contract: string; name?: string | null; image_url?: string | null; display_image_url?: string | null; opensea_url?: string | null };
async function opensea<T>(path: string): Promise<T> {
  const key = process.env.OPENSEA_API_KEY?.trim();
  if (!key) throw new Error("opensea not configured");
  const r = await fetch(`https://api.opensea.io/api/v2${path}`, { headers: { "x-api-key": key, accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`opensea ${path}: ${r.status}`);
  return (await r.json()) as T;
}
export type FounderPass = { id: string; contract: string; name: string; image: string; url: string };
const toPass = (n: OsNft): FounderPass => ({
  id: n.identifier, contract: n.contract, name: n.name || `Founder #${n.identifier}`,
  image: n.display_image_url || n.image_url || "", url: n.opensea_url || FOUNDER_URL,
});

/** All passes in the collection. null = couldn't check. */
export async function founderPasses(): Promise<FounderPass[] | null> {
  if (!foundersConfigured()) return null;
  try { return (await opensea<{ nfts: OsNft[] }>(`/collection/${FOUNDER_SLUG}/nfts?limit=50`)).nfts.map(toPass); }
  catch (e) { console.warn("[disciple] nft: founderPasses failed", String(e)); return null; }
}
/** Passes an Ethereum wallet holds. null = couldn't check. */
export async function foundersOf(owner: string): Promise<OwnedNft[] | null> {
  if (!foundersConfigured()) return null;
  try {
    const j = await opensea<{ nfts: OsNft[] }>(`/chain/ethereum/account/${owner.toLowerCase()}/nfts?collection=${FOUNDER_SLUG}&limit=50`);
    return j.nfts.map((n) => ({ chain: "eth" as const, id: `${n.contract.toLowerCase()}:${n.identifier}`, name: n.name || `Founder #${n.identifier}`, image: n.display_image_url || n.image_url || "" }));
  } catch (e) { console.warn("[disciple] nft: foundersOf failed", String(e)); return null; }
}
