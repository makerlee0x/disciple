/**
 * AUDIT: the flight decal (`?icon=` on the coin/flight page) renders ONLY from the moderated store, same rule as
 * CoinIdentity (lib/coinImages isStoreSrc: /api/image/<64-hex sha>, base-path aware). Anything else (external https,
 * data:/blob: URLs, other relative paths) → null, so brandedRocket() uses its existing plain-rocket fallback.
 */
import { isStoreSrc } from "../coinImages";

export const gateFlightIcon = (s: string | null | undefined): string | null => (isStoreSrc(s) ? (s as string) : null);
