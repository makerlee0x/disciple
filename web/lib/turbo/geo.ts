/**
 * TURBO geoblock STUB. Always allows, from a mock — there is NO IP lookup and no network call.
 *
 * TODO(SITE, before any real money): replace checkTurboGeo() with a real server-side check (e.g. a Next route reading
 * the edge geo header / an IP-country service) that blocks restricted regions (nova's Terms ban the US and Ontario,
 * plus sanctioned places), and add terms gating. Needs lee's call + legal review. Keep the return shape.
 */
export type TurboGeo = {
  allowed: boolean;
  /** ISO country code when known (stub: null). */
  country: string | null;
  /** Plain reason to show when blocked. */
  reason?: string;
  source: "mock" | "server";
};

export async function checkTurboGeo(): Promise<TurboGeo> {
  return { allowed: true, country: null, source: "mock" };
}
