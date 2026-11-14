/**
 * Keeper rules for CreatorFeeHarvest.route (app/api/cron/route-creator-fees). Pure, unit-tested by
 * scripts/test-fee-route-keeper.mts.
 *
 * A coin launched with creator fees sent to the locked pool (1) or to buy-and-burn (2) keeps paying its creator
 * share to FeeRouter / CurveFeeVault, where the creator can no longer claim it. `route(token)` (anyone may call it,
 * the caller is paid nothing) moves it to the pool or the burn. This keeper calls it for every such coin.
 */

/** Tokens whose CreatorFeeDestinationSet event picked 1 or 2 (lowercase, unique, in log order). */
export function routedTokensFromLogs(logs: { args: { token?: string; destination?: number | bigint } }[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of logs) {
    const d = Number(l.args.destination ?? 0);
    const t = String(l.args.token ?? "").toLowerCase();
    if ((d === 1 || d === 2) && /^0x[0-9a-f]{40}$/.test(t) && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

/**
 * Expected reasons a simulated route() reverts, which mean "nothing to do yet" rather than a fault:
 * NothingToRoute (no fees since last time), AwaitingOrbit (burn coin: only rocket-token fees, still on the curve),
 * PriceGuard (burn coin after orbit: the pool moved too much this block to sell safely, try later).
 */
export const QUIET_ROUTE_ERRORS = ["NothingToRoute", "AwaitingOrbit", "PriceGuard"] as const;
export function isQuietRouteError(message: string): boolean {
  return QUIET_ROUTE_ERRORS.some((e) => message.includes(e));
}

/** Most coins one run sends (each send waits for its receipt). The rest go first next run (rotating start). */
export const MAX_ROUTES_PER_RUN = 25;

/** Rotate the list so every coin gets a turn even when there are more than MAX_ROUTES_PER_RUN. */
export function rotate<T>(xs: T[], start: number): T[] {
  if (!xs.length) return xs;
  const k = ((start % xs.length) + xs.length) % xs.length;
  return [...xs.slice(k), ...xs.slice(0, k)];
}
