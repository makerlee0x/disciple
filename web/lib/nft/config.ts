/**
 * Disciple NFTs (maker 2026-11-17). Shared client + server constants.
 *
 * Solana: "disciples of $JESUS", 777 Legacy pNFTs (Token Metadata), first 175 minted on LaunchMyNFT
 * (launchmynft.io/sol/10942, their own program, not Metaplex). The rest mint from our own Metaplex Candy Machine v3
 * into the SAME verified collection. The collection's update authority is DISCIPLE_TREASURY (a dev holds it, 2026-11-17);
 * the plan is for it to move to maker's wallet DISCIPLE_PAYOUT, so setup accepts either (DISCIPLE_AUTHORITIES).
 * LaunchMyNFT's unrevealed mints point at METADATA_BASE + `${i}.json` (placeholder art, each file names its disciple).
 * Our machine mints revealed: REVEALED_BASE + `${n}.json` = disciple #n (n = 0..776), copied from maker's originals
 * into Vercel Blob by /admin/mint (lib/server/nft/art) and served on our domain by app/nft/d/[file].
 *
 * Ethereum: "The Twelve" founder passes (ERC-721 FOUNDER_CONTRACT), traded on OpenSea (collection slug FOUNDER_SLUG).
 */
export const DISCIPLE_COLLECTION = "CVziNj1WpFYQAJeD5ufvyzDzTQP6eHv8bcLcMC8iAsTw";
/** The drop's deployer wallet: collection update authority today (held by a dev, not maker). */
export const DISCIPLE_TREASURY = "DfKfLZiTBzScaJRHJ4ZjjkhWAeVA8TV6eX9UuYqZakq1";
/** maker's wallet (2026-11-17): where mint SOL goes, and the 100% royalty creator (same as on the LaunchMyNFT disciples). */
export const DISCIPLE_PAYOUT = "EAqvjRcS72ApaPf8JBnS5og5Pwwae2EwEHVKyvBFgyiw";
/** Wallets that may sign /admin/mint setup: whichever holds the collection's update authority. */
export const DISCIPLE_AUTHORITIES = [DISCIPLE_TREASURY, DISCIPLE_PAYOUT] as const;
export const isDiscipleAuthority = (a: string | null | undefined) => !!a && (DISCIPLE_AUTHORITIES as readonly string[]).includes(a);
/** Metaplex default pNFT rule set, the one the first 175 use. */
export const DISCIPLE_RULE_SET = "eBJLFYPxJmMGKuFwpDWkzxZeUrad92kZRC5BJLpzyT9";
export const DISCIPLE_SUPPLY = 777;
/** Solana Disciples on the site (market tile, Solana holder wallet, Connect NFT). Off until the collection hand-over (maker 2026-11-18). */
export const DISCIPLES_LIVE = false;
export const DISCIPLE_SYMBOL = "DSCPL";
export const DISCIPLE_ROYALTY_BPS = 700;
export const METADATA_BASE = "https://gateway.pinit.io/ipfs/QmRhv7orAQhRuuyGp9BKRUoGbzU9Hc9LQqJG5hmbyrLPAZ/";
export const IMAGE_BASE = "https://gateway.pinit.io/ipfs/QmPPfPVLRSpwGuPEBsQhfeFSJpSx8AT6LtJSSk3Aow9fNH/";
export const NAME_PREFIX = "disciple #";
/** Metadata prefix our Candy Machine writes on-chain (fixed once the machine exists). */
export const REVEALED_BASE = "https://www.disciple.vip/nft/d/";

/** Mint (maker 2026-11-17): 0.777 SOL, 7 per wallet. */
export const MINT_PRICE_SOL = 0.777;
export const MINT_LIMIT = 7;
/** Candy Guard mintLimit id (any 1-255; fixed so the counter PDA stays the same). */
export const MINT_LIMIT_ID = 1;

export const FOUNDER_SLUG = "the-twelve-by-jesus";
export const FOUNDER_URL = `https://opensea.io/collection/${FOUNDER_SLUG}`;
export const FOUNDER_COUNT = 12;
/** "The Twelve by $Jesus", ERC-721 on Ethereum (maker 2026-11-17). Every pass is the same art. */
export const FOUNDER_CONTRACT = "0xae702cfedea4b92c4d8a4f4d268b12efbf9b562c" as const;
/** The pass art, from token #1's own metadata (ipfs://QmRdSr…/1.jpg). */
export const FOUNDER_IMAGE = "https://gateway.pinit.io/ipfs/QmRdSrHiuyjV6EE3VgaPQK6ouqDisdcuukdhXLUSAqLvmY/1.jpg";

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

/** Disciple number from one of our revealed uris ("…/nft/d/505.json" → 505), else null. */
export function revealedNumber(uri: string): number | null {
  if (!uri.startsWith(REVEALED_BASE)) return null;
  const m = uri.slice(REVEALED_BASE.length).match(/^(\d{1,3})\.json$/);
  const n = m ? Number(m[1]) : -1;
  return n >= 0 && n < DISCIPLE_SUPPLY ? n : null;
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
