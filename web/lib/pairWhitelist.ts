/**
 * Launch pair whitelist (lee 2026-10-29): a rocket pairs only with one of these existing community coins: no ETH, no
 * USDG, no pasted ERC-20. STRATEGY is the default (quote = address(0) ⇒ Launchpad.defaultQuote = STRATEGY).
 * Mainnet (4663) addresses; on the testnet the mainnet coins don't exist, so the list is the deployment's mock STRATEGY.
 * One list for the /create picker (lib/pairs) and the relay's launch check (lib/aa/launchQuote).
 * tk = the pair-art key (lib/pairArt BASE_PAIRS, /public/pairs/<tk>.png). Names as listed on DexScreener (Robinhood).
 */
import { DEPLOYMENTS, ZERO } from "./chains";
import type { Address } from "./protocol";

export type WhitelistPair = { symbol: string; name: string; address: Address; tk: string };

const P = (symbol: string, name: string, address: string): WhitelistPair => ({ symbol, name, address: address as Address, tk: symbol.toLowerCase() });

/** Robinhood Chain mainnet. First entry = the default pair. */
export const MAINNET_PAIRS: readonly WhitelistPair[] = [
  P("STRATEGY", "Strategy Coin", "0x168661C52E5922288dFb2b3f323b6Cf90eb21e18"),
  P("AI", "Artificial Inu", "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18"),
  P("BONER", "Boner Coin", "0x98096d17e191B3dA1d5f99a6D7b3584351b11E18"),
  P("MEME", "A Meme Coin", "0x385F4f8ae47651ce5F58F5265395a669f8281e18"),
  P("SCHIFFY", "SCHIFFY", "0x42aFA2124ca5a2B83898E46B2dA9a190995b1E18"),
  P("MOO", "Memory cow Moo", "0xD9dB30BB0D2b8d2eae3826A1372117E058791e18"),
  P("INU", "iNu", "0x63Ee32Ac3077d1fbd8a77eBBA2a6ed4b8e9c1e18"),
  P("MONITOR", "The Situation", "0x1a911bb954dAA9CB38513423075bE74450351e18"),
  P("SPACEHOOD", "SPACEHOOD", "0xFe7E19CbCe2f896C6C528BC355bAF5a768291E18"),
  P("PONS", "Pons", "0x39dBED3a2bd333467115dE45665cC57F813C4571"),
  P("HOOKR", "Hookr.fun", "0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c"),
  P("DELTA", "Delta", "0xe8ffd7e24187F72afB08d75B1bb13088A989a791"),
  P("PRIORS", "Priors Agents", "0xeDBf91223639800BCd5756815CAf908Df3b890bE"),
  P("ABYSS", "Abyss", "0x15f3385625D7e364C5a6216FBbceadf10fa90e7d"),
  P("TORCH", "Torch", "0x000050E18ffa3F8F7aD170Eb9CeF160eb3Ed1111"),
  P("BOW", "Longbow", "0x451b42A15100C340CA12F7c66DE06fac5EA2D751"),
  P("ORBIO", "Orbio.so", "0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3"),
  P("NET", "NetNet", "0xCA9c78Dd337A67F6e0077F65F5E9218719d30eDf"),
  P("CASHCAT", "Cash Cat", "0x020bfC650A365f8BB26819deAAbF3E21291018b4"),
  P("ZZZ", "ZZZ", "0x7dbf38976f6D3b9c529e7D9484A71898B409eE6a"),
  P("HMM", "Thinking Cat", "0x7FE995a80075dF3Dc8Ae11A9b82c7FE4202CD87f"),
  P("SHROOM", "MUSHROOM", "0xab093dEF657F15dF31b33922A95e047aDd645B29"),
];

/** The whitelist for a chain: mainnet's list, else that deployment's (mock) STRATEGY only. */
export function pairWhitelist(chainId: number): readonly WhitelistPair[] {
  if (chainId === 4663) return MAINNET_PAIRS;
  const q = DEPLOYMENTS[chainId]?.defaultQuote;
  return q && q !== ZERO ? [{ ...MAINNET_PAIRS[0], address: q }] : [];
}

/** May a launch on `chainId` pair with `quote`? address(0) = the Launchpad's default (STRATEGY): always allowed. */
export function isWhitelistedQuote(quote: string | null | undefined, chainId: number): boolean {
  const q = (quote || ZERO).toLowerCase();
  if (q === ZERO.toLowerCase()) return true;
  return pairWhitelist(chainId).some((p) => p.address.toLowerCase() === q);
}
