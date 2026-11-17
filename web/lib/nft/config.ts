/**
 * Disciple NFTs (maker 2026-11-17). Shared client + server constants.
 *
 * Solana: "disciples of $JESUS", 777 Legacy pNFTs (Token Metadata), first 175 minted on LaunchMyNFT
 * (launchmynft.io/sol/10942, their own program, not Metaplex). The rest mint from our own Metaplex Candy Machine v3
 * into the SAME verified collection: maker's wallet DISCIPLE_TREASURY is the collection's update authority.
 * Item i of the drop is METADATA_BASE + `${i}.json` (i = 0..776); each file names its disciple ("disciple #700").
 *
 * Ethereum: "The Twelve" founder passes, 12 on OpenSea (collection slug FOUNDER_SLUG).
 */
export const DISCIPLE_COLLECTION = "CVziNj1WpFYQAJeD5ufvyzDzTQP6eHv8bcLcMC8iAsTw";
/** maker's wallet: collection update authority, creator (100%), and where mint SOL goes. */
export const DISCIPLE_TREASURY = "DfKfLZiTBzScaJRHJ4ZjjkhWAeVA8TV6eX9UuYqZakq1";
/** Metaplex default pNFT rule set, the one the first 175 use. */
export const DISCIPLE_RULE_SET = "eBJLFYPxJmMGKuFwpDWkzxZeUrad92kZRC5BJLpzyT9";
export const DISCIPLE_SUPPLY = 777;
export const DISCIPLE_SYMBOL = "DSCPL";
export const DISCIPLE_ROYALTY_BPS = 700;
export const METADATA_BASE = "https://gateway.pinit.io/ipfs/QmRhv7orAQhRuuyGp9BKRUoGbzU9Hc9LQqJG5hmbyrLPAZ/";
export const IMAGE_BASE = "https://gateway.pinit.io/ipfs/QmPPfPVLRSpwGuPEBsQhfeFSJpSx8AT6LtJSSk3Aow9fNH/";
export const NAME_PREFIX = "disciple #";

/** Mint (maker 2026-11-17): 0.777 SOL, 7 per wallet. */
export const MINT_PRICE_SOL = 0.777;
export const MINT_LIMIT = 7;
/** Candy Guard mintLimit id (any 1-255; fixed so the counter PDA stays the same). */
export const MINT_LIMIT_ID = 1;

export const FOUNDER_SLUG = "the-twelve-by-jesus";
export const FOUNDER_URL = `https://opensea.io/collection/${FOUNDER_SLUG}`;
export const FOUNDER_COUNT = 12;

export const isSolAddress = (s: unknown): s is string => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
export const isEvmAddress = (s: unknown): s is string => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);

/** Item index from a metadata uri of this drop ("…/181.json" → 181), else null. */
export function itemIndex(uri: string): number | null {
  if (!uri.startsWith(METADATA_BASE)) return null;
  const m = uri.slice(METADATA_BASE.length).match(/^(\d{1,3})\.json$/);
  if (!m) return null;
  const i = Number(m[1]);
  return i >= 0 && i < DISCIPLE_SUPPLY ? i : null;
}

export type HolderChain = "sol" | "eth";
/** Signed by the linked wallet AND by the profile wallet, so neither side can be claimed alone. */
export const holderLinkMessage = (profile: string, chain: HolderChain, wallet: string, nonce: string) =>
  `DISCIPLE holder wallet\n\nProfile: ${profile.toLowerCase()}\n${chain === "sol" ? "Solana" : "Ethereum"} wallet: ${chain === "eth" ? wallet.toLowerCase() : wallet}\nNonce: ${nonce}\n\nSigning costs nothing and sends no transaction.`;
export const holderUnlinkMessage = (profile: string, chain: HolderChain, nonce: string) =>
  `DISCIPLE holder wallet\n\nProfile: ${profile.toLowerCase()}\nRemove ${chain === "sol" ? "Solana" : "Ethereum"} wallet\nNonce: ${nonce}\n\nSigning costs nothing and sends no transaction.`;

export type OwnedNft = { chain: HolderChain; id: string; name: string; image: string; /** small CDN copy for grids */ thumb?: string };
export type HolderStatus = { sol: string | null; eth: string | null; disciples: number; founders: number };
export type NftPfp = { chain: HolderChain; id: string; name: string };
