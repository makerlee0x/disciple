/**
 * Known TEST coins, hidden from the app home (trending hero, Next trending, the feed). Nothing is deleted: the coins,
 * their trades and their KV entries stay as they are, and /coin/<address> still opens them by direct link.
 * All were launched on testnet by SITE / ops test accounts (smoke tests, graduation and trade-latency runs, Oct 2026).
 * Add an address (lower case) to hide another test coin; remove it to show it again.
 */
export const HIDDEN_TEST_COINS: ReadonlySet<string> = new Set([
  "0x4c0b30188f5ff953ac81499ec421c71074a2cb99", // SITE Grad (SGRAD): graduation test
  "0x43a79ff74d6b51da3ded0dd947b92bef266248fb", // Halo Saint Prime (HALO): ops test account 0x3267…6DeE
  "0x09dc93c4b79b0412b80978e435c137aaff3083f9", // Based Wolf (BASED): ops test account 0x3267…6DeE (anon launch)
  "0x5279e69506194833aaa8f85cb717f55f9e1a02a1", // Iron Wolf Prime (IRON): ops test account 0x3267…6DeE
  "0xd3768b0a30e18fa52682530b94680cd911bf26ce", // SITE Smoke (SMOKE)
  "0xfbaec8982830e99a46893840ac224384f16fae92", // SITE Smoke (SMOKE)
  "0x439479f56955307dc031a422229b5d7f38191ee7", // SITE Smoke (SMOKE)
  "0x187ff55b68264077842d6ee7d18571b150259f08", // SITE Smoke (SMOKE)
  "0xcbcfa78c098a037da641571fb91efa5c47bc4169", // SITE Smoke (SMOKE)
  "0x5d5d2d3a87488730c6803afca649108205b937d1", // SITE Smoke (SMOKE)
  "0xc7e64e22c58c16926f99d0c12a31187364b369f5", // Smoke 37922 (SMK): smoke test
  // Older-stack Easy test coins (curve.loginGate 0xaeb8…, still checked on-chain, so their buys revert
  // NotVerified). All Velvet Dragon (VELVET) launches by the maker test account.
  "0x758a61c27bdd1b18e5a31fc3cc04b400fc95d4a3", // Velvet Dragon (VELVET)
  "0xf48aa293d5c281fb3ede2598641a264f5f579315", // Velvet Dragon (VELVET)
  "0x56262d587fdca44f8ea1cd2eb807836cfc8f9b07", // Velvet Dragon (VELVET)
  "0x6efd87cf06fc304bc1011f9f5d3f744cf4767aff", // Velvet Dragon (VELVET)
  // GAME TEST NEAR (GTNEAR): older-stack trench coin; a gasless ascension buy reverts at the 900k gas cap. Lee: hide legacy coins we don't need.
  "0x443cbf068a02809cbcbd76d91a898e423a8eb1e9", // GAME TEST NEAR (GTNEAR)
]);

export const isHiddenCoin = (token: string | null | undefined): boolean => !!token && HIDDEN_TEST_COINS.has(token.toLowerCase());

/**
 * Addresses hidden from the TRADES feed and the Holders list (not deleted from the trade index or chart).
 * The gasless DiscipleRouter is recorded as Trade.trader on post-grad hook fills because the hook does not
 * trust it (isTrustedRouter=false), so hookData with the signer is ignored and trader=msg.sender=router.
 * That address hashes to "Maverick Skyrocket". Do not add the regular USDG router (0x6881…4ad2): the hook
 * trusts it, so Trade.trader is the end user.
 */
export const HIDDEN_TRADERS: ReadonlySet<string> = new Set([
  "0x0c21c3b9bb01a8245cd6b9659c727affacc46d7e", // gasless DiscipleRouter (Permit2), RH testnet 46630
]);
export const isHiddenTrader = (address: string | null | undefined): boolean => !!address && HIDDEN_TRADERS.has(address.toLowerCase());
