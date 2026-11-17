import "server-only";
/**
 * Reads for Disciple NFTs.
 *  - Solana: Helius (HELIUS_API_KEY) RPC + DAS. Without the key every read answers "unknown" (null), never "doesn't own".
 *  - Ethereum founder passes (The Twelve, ERC-721): balanceOf on mainnet (ETH_RPC_URL or a public RPC). No API key.
 * Short in-memory caches; callers cache longer in KV where it matters.
 */
import { createPublicClient, http, parseAbi } from "viem";
import { mainnet } from "viem/chains";
import { DISCIPLE_COLLECTION, FOUNDER_CONTRACT, itemIndex, type OwnedNft } from "@/lib/nft/config";

const clean = (v?: string) => (v ?? "").trim().replace(/^["']|["']$/g, "").trim();
/** Accepts the bare key, or a whole Helius RPC URL pasted into either variable. */
export const heliusUrl = () => {
  const u = clean(process.env.HELIUS_RPC_URL), k = clean(process.env.HELIUS_API_KEY);
  if (u) return u;
  if (/^https?:\/\//.test(k)) return k;
  const key = k.match(/api-key=([^&\s]+)/)?.[1] ?? k;
  return key ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}` : "";
};
export const solanaConfigured = () => !!heliusUrl();
/** Shape of the configured key, never the key: "uuid" (Helius keys are 36-char UUIDs), "url", or "other, N chars". */
export const heliusKeyShape = () => {
  const u = heliusUrl(); if (!u) return "none";
  const k = u.match(/api-key=([^&]+)/)?.[1];
  if (!k) return "url";
  const d = decodeURIComponent(k);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(d) ? "uuid" : `other, ${d.length} chars`;
};

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

/* ------------------------------------------------ Ethereum founder passes (The Twelve) ------------------------------------------------ */

const erc721 = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);
let eth: ReturnType<typeof createPublicClient> | null = null;
/** Ethereum mainnet reads: ETH_RPC_URL, else a public endpoint (one balanceOf per linked wallet, cached 30 min upstream). */
const ethClient = () => (eth ??= createPublicClient({ chain: mainnet, transport: http(process.env.ETH_RPC_URL?.trim() || "https://ethereum-rpc.publicnode.com", { timeout: 8000 }) }));

/** How many founder passes an Ethereum wallet holds (ERC-721 balanceOf). null = couldn't check. */
export async function foundersOf(owner: string): Promise<number | null> {
  try { return Number(await ethClient().readContract({ address: FOUNDER_CONTRACT, abi: erc721, functionName: "balanceOf", args: [owner as `0x${string}`] })); }
  catch (e) { console.warn("[disciple] nft: foundersOf failed", String(e)); return null; }
}
