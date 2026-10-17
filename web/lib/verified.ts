/**
 * Rocket verification: a manual yes/no flag, set by hand by the team.
 * There are no automatic tiers or metric thresholds. A rocket is either Verified or it isn't.
 *
 * A rocket is verified when EITHER:
 *   1. its coin address is in VERIFIED_COINS below (hand-maintained), OR
 *   2. its metadata carries `verified: true` (Rocket.verified / CoinMetadata.verified),
 *      e.g. set by a future admin API (SITE's area).
 */

/**
 * Hand-maintained list of verified coin addresses.
 * To verify a rocket, the team adds its coin address here by hand (lowercase 0x… string), then ships.
 * To un-verify, remove it. Nothing is added automatically.
 */
export const VERIFIED_COINS: ReadonlySet<string> = new Set<string>([
  // "0x0000000000000000000000000000000000000000", // example: <TICKER> (verified by <who>, <date>)
]);

/** True if the coin address is hand-verified, or its metadata flag says `verified: true`. */
export function isVerified(coinAddress: string | null | undefined, flag?: boolean | null): boolean {
  if (flag === true) return true;
  if (!coinAddress) return false;
  return VERIFIED_COINS.has(coinAddress.toLowerCase());
}

/** Convenience for objects carrying an address + optional flag (Rocket: `id`, CoinMetadata: `token`). */
export function isRocketVerified(r: { id?: string; token?: string; verified?: boolean }): boolean {
  return isVerified(r.token ?? r.id, r.verified);
}
