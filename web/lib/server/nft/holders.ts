import "server-only";
/**
 * Holder wallets + NFT profile pictures, keyed by the profile (EVM) wallet like the rest of profile meta.
 *   nft:link:<profile>          → { sol?, eth? }  linked holder wallets (each proven by both signatures, /api/nft/link)
 *   nft:linkby:<chain>:<wallet> → <profile>       one holder wallet belongs to one profile; linking elsewhere moves it
 *   nft:hold:<profile>          → { disciples, founders, at }  cached counts (HOLD_TTL)
 *   nft:pfp:<profile>:<imageId> → { chain, id, name, imageId, at }  the NFT behind a picked picture (one per picked image, so a
 *                                 pick that's never saved can't break the picture in use)
 *   nft:img:<imageId>           → "1"  this stored image is NFT art: only its owner's profile may use it as a picture
 * Ownership is re-checked at most every PFP_RECHECK_MS when the profile is read; a sold NFT drops the picture.
 */
import { kv } from "../kv";
import { metaOf, setMeta } from "../profileMeta";
import { disciplesOf, discipleById, foundersOf } from "./chain";
import type { HolderChain, HolderStatus, NftPfp } from "@/lib/nft/config";

const HOLD_TTL_MS = 30 * 60_000;
export const PFP_RECHECK_MS = 6 * 60 * 60_000;
type Links = { sol?: string; eth?: string };
type PfpRec = NftPfp & { imageId: string; at: number };

const norm = (chain: HolderChain, w: string) => (chain === "eth" ? w.toLowerCase() : w);
const parse = <T>(s: string | null): T | null => { if (!s) return null; try { return JSON.parse(s) as T; } catch { return null; } };

export async function linksOf(profile: string): Promise<Links> {
  return parse<Links>(await kv().get(`nft:link:${profile.toLowerCase()}`)) ?? {};
}

export async function linkWallet(profile: string, chain: HolderChain, wallet: string): Promise<void> {
  const p = profile.toLowerCase(), w = norm(chain, wallet);
  const prevOwner = await kv().get(`nft:linkby:${chain}:${w}`);
  if (prevOwner && prevOwner !== p) {
    const pl = await linksOf(prevOwner);
    delete pl[chain];
    await kv().set(`nft:link:${prevOwner}`, JSON.stringify(pl));
    await kv().del(`nft:hold:${prevOwner}`);
  }
  const l = await linksOf(p);
  if (l[chain] && l[chain] !== w) await kv().del(`nft:linkby:${chain}:${l[chain]}`);
  l[chain] = w;
  await kv().set(`nft:link:${p}`, JSON.stringify(l));
  await kv().set(`nft:linkby:${chain}:${w}`, p);
  await kv().del(`nft:hold:${p}`);
}

export async function unlinkWallet(profile: string, chain: HolderChain): Promise<void> {
  const p = profile.toLowerCase(), l = await linksOf(p);
  if (l[chain]) await kv().del(`nft:linkby:${chain}:${l[chain]}`);
  delete l[chain];
  await kv().set(`nft:link:${p}`, JSON.stringify(l));
  await kv().del(`nft:hold:${p}`);
}

/** Linked wallets + how many disciples / founder passes they hold (cached). Unknown counts read as 0. */
export async function holderStatus(profile: string, fresh = false): Promise<HolderStatus> {
  const p = profile.toLowerCase(), l = await linksOf(p);
  const base = { sol: l.sol ?? null, eth: l.eth ?? null };
  if (!l.sol && !l.eth) return { ...base, disciples: 0, founders: 0 };
  const c = parse<{ disciples: number; founders: number; at: number }>(await kv().get(`nft:hold:${p}`));
  if (c && !fresh && Date.now() - c.at < HOLD_TTL_MS) return { ...base, disciples: c.disciples, founders: c.founders };
  const [d, f] = await Promise.all([l.sol ? disciplesOf(l.sol) : Promise.resolve([]), l.eth ? foundersOf(l.eth) : Promise.resolve(0)]);
  const out = { disciples: d?.length ?? c?.disciples ?? 0, founders: f ?? c?.founders ?? 0 };
  if (d !== null && f !== null) await kv().set(`nft:hold:${p}`, JSON.stringify({ ...out, at: Date.now() }));
  return { ...base, ...out };
}

export async function setNftPfp(profile: string, rec: NftPfp & { imageId: string }): Promise<void> {
  await kv().set(`nft:img:${rec.imageId}`, "1");
  await kv().set(`nft:pfp:${profile.toLowerCase()}:${rec.imageId}`, JSON.stringify({ ...rec, at: Date.now() }));
}
export const isNftImage = async (imageId: string) => !!imageId && (await kv().get(`nft:img:${imageId}`)) === "1";
/** May this profile use stored image `imageId` as its picture? Plain uploads: yes. NFT art: only the profile it was picked for. */
export async function mayUseImage(profile: string, imageId: string): Promise<boolean> {
  if (!(await isNftImage(imageId))) return true;
  const r = parse<PfpRec>(await kv().get(`nft:pfp:${profile.toLowerCase()}:${imageId}`));
  return !!r && r.imageId === imageId;
}

/** Still owned by this profile's linked wallet? null = couldn't check (keep it). */
async function stillOwned(profile: string, r: PfpRec): Promise<boolean | null> {
  if (r.chain !== "sol") return null;
  const l = await linksOf(profile);
  if (!l.sol) return false;
  const a = await discipleById(r.id);
  if (!a) return null;
  return a.owner === l.sol;
}

/**
 * The NFT behind this profile's picture, or null. Re-checks ownership every PFP_RECHECK_MS: once it's gone, the picture is
 * cleared (back to the default sigil) and the record dropped.
 */
export async function nftPfpOf(profile: string, currentPfp: string): Promise<NftPfp | null> {
  const p = profile.toLowerCase();
  if (!currentPfp) return null;
  const key = `nft:pfp:${p}:${currentPfp}`;
  const r = parse<PfpRec>(await kv().get(key));
  if (!r || r.imageId !== currentPfp) return null;
  if (Date.now() - r.at > PFP_RECHECK_MS) {
    const own = await stillOwned(p, r).catch(() => null);
    if (own === false) {
      await kv().del(key);
      const m = await metaOf(p);
      if (m.pfp === r.imageId) await setMeta(p, { ...m, pfp: "" });
      return null;
    }
    if (own) await kv().set(key, JSON.stringify({ ...r, at: Date.now() }));
  }
  return { chain: r.chain, id: r.id, name: r.name };
}
