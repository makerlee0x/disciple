/**
 * Test coins hidden from indexer list endpoints (GET /coins, GET /users/:addr/coins).
 * Keep in sync with web/lib/home/hiddenCoins.ts. Nothing is deleted: GET /coins/:address
 * and trades/candles still resolve (same rule as the app: /coin/<address> stays open).
 */
export const HIDDEN_TEST_COINS: ReadonlySet<string> = new Set([
  "0x4c0b30188f5ff953ac81499ec421c71074a2cb99", // SITE Grad (SGRAD)
  "0x43a79ff74d6b51da3ded0dd947b92bef266248fb", // Halo Saint Prime (HALO)
  "0x09dc93c4b79b0412b80978e435c137aaff3083f9", // Based Wolf (BASED)
  "0x5279e69506194833aaa8f85cb717f55f9e1a02a1", // Iron Wolf Prime (IRON)
  "0xd3768b0a30e18fa52682530b94680cd911bf26ce", // SITE Smoke (SMOKE)
  "0xfbaec8982830e99a46893840ac224384f16fae92", // SITE Smoke (SMOKE)
  "0x439479f56955307dc031a422229b5d7f38191ee7", // SITE Smoke (SMOKE)
  "0x187ff55b68264077842d6ee7d18571b150259f08", // SITE Smoke (SMOKE)
  "0xcbcfa78c098a037da641571fb91efa5c47bc4169", // SITE Smoke (SMOKE)
  "0x5d5d2d3a87488730c6803afca649108205b937d1", // SITE Smoke (SMOKE)
  "0xc7e64e22c58c16926f99d0c12a31187364b369f5", // Smoke 37922 (SMK)
  "0x758a61c27bdd1b18e5a31fc3cc04b400fc95d4a3", // Velvet Dragon (VELVET) — LegacyLoginGate
  "0xf48aa293d5c281fb3ede2598641a264f5f579315", // Velvet Dragon (VELVET) — LegacyLoginGate
  "0x56262d587fdca44f8ea1cd2eb807836cfc8f9b07", // Velvet Dragon (VELVET) — LegacyLoginGate
  "0x6efd87cf06fc304bc1011f9f5d3f744cf4767aff", // Velvet Dragon (VELVET) — LegacyLoginGate
  "0x443cbf068a02809cbcbd76d91a898e423a8eb1e9", // GAME TEST NEAR (GTNEAR)
]);

export const isHiddenCoin = (token: string | null | undefined): boolean => !!token && HIDDEN_TEST_COINS.has(token.toLowerCase());

/** Same set as web/lib/home/hiddenCoins.ts. Indexer ingest is unchanged (trades stay recorded). */
export const HIDDEN_TRADERS: ReadonlySet<string> = new Set([
  "0x0c21c3b9bb01a8245cd6b9659c727affacc46d7e", // gasless DiscipleRouter (Permit2), RH testnet 46630
]);
export const isHiddenTrader = (address: string | null | undefined): boolean => !!address && HIDDEN_TRADERS.has(address.toLowerCase());
