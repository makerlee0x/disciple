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
/** The burn sell is chunked (PR #371: at most ~3% impact per route), so a coin may need several runs to clear. */
export function isQuietRouteError(message: string): boolean {
  return QUIET_ROUTE_ERRORS.some((e) => message.includes(e));
}

/** Rotate the list so every job gets a turn even when there are more than fit in one run. */
export function rotate<T>(xs: T[], start: number): T[] {
  if (!xs.length) return xs;
  const k = ((start % xs.length) + xs.length) % xs.length;
  return [...xs.slice(k), ...xs.slice(0, k)];
}

/**
 * Past creators of routed coins, from Launchpad CreatorTransferred(token, previousCreator, newCreator), as
 * "token:creator" keys (lowercase). `route` pulls only the current creator and the launcher recorded at launch, so
 * fees that accrued to anyone in between need `routeWith(token, pastCreator)` (audit CH-04, PR #371).
 */
export function pastCreatorKeys(
  logs: { args: { token?: string; previousCreator?: string } }[],
  routed: ReadonlySet<string>,
): string[] {
  const out = new Set<string>();
  for (const l of logs) {
    const t = String(l.args.token ?? "").toLowerCase(), c = String(l.args.previousCreator ?? "").toLowerCase();
    if (routed.has(t) && /^0x[0-9a-f]{40}$/.test(c) && !/^0x0{40}$/.test(c)) out.add(`${t}:${c}`);
  }
  return Array.from(out);
}
export const splitPastKey = (k: string) => { const [token, creator] = k.split(":"); return { token, creator }; };

/**
 * Spend limits for one keeper run (Vercel security review on #368). The relayer EOA is shared, so a launcher must not
 * be able to make it spend without bound:
 *  - every tx is gas-estimated first and skipped above GAS_PER_TX (a pair coin whose transfer burns gas can't pass),
 *    and sent with a gas limit capped at GAS_PER_TX;
 *  - a run stops once GAS_PER_RUN is used, after MAX_JOBS_PER_RUN jobs, or at DEADLINE_MS;
 *  - only coins paired with a launch-list coin are routed (lib/launchWhitelist), so a launcher's own ERC-20 is never
 *    touched by the relayer;
 *  - past creators per coin are capped (MAX_PAST_PER_COIN) and count toward MAX_JOBS_PER_RUN, so repeated
 *    transferCreator calls can't crowd out other coins.
 */
export const KEEPER_LIMITS = {
  MAX_JOBS_PER_RUN: 25,
  MAX_PAST_PER_COIN: 3,
  GAS_PER_TX: BigInt(1_500_000),
  GAS_PER_RUN: BigInt(12_000_000),
  DEADLINE_MS: 40_000,
} as const;

export type RouteJob = { label: string; token: string; fn: "route" | "routeWith"; pastCreator?: string };

/**
 * One fair, bounded job list: each coin's route plus up to MAX_PAST_PER_COIN routeWith jobs (only when the harvest has
 * routeWith), flattened, rotated by `start`, cut to `max`. `next` is the start for the following run.
 */
export function planJobs(
  tokens: string[],
  past: ReadonlyMap<string, string[]>,
  o: { withPast: boolean; start: number; max?: number; maxPastPerCoin?: number },
): { jobs: RouteJob[]; next: number; total: number } {
  const max = o.max ?? KEEPER_LIMITS.MAX_JOBS_PER_RUN, perCoin = o.maxPastPerCoin ?? KEEPER_LIMITS.MAX_PAST_PER_COIN;
  const all: RouteJob[] = [];
  for (const token of Array.from(new Set(tokens)).sort()) {
    all.push({ label: token, token, fn: "route" });
    if (!o.withPast) continue;
    for (const c of Array.from(new Set(past.get(token) ?? [])).sort().slice(0, perCoin)) {
      all.push({ label: `${token}:${c}`, token, fn: "routeWith", pastCreator: c });
    }
  }
  const jobs = rotate(all, o.start).slice(0, max);
  return { jobs, next: all.length ? (o.start + jobs.length) % all.length : 0, total: all.length };
}

/** Send gas limit for an estimate: +20% headroom, never above the per-tx cap. null = too expensive, skip it. */
export function gasLimitFor(estimate: bigint, cap: bigint = KEEPER_LIMITS.GAS_PER_TX): bigint | null {
  if (estimate > cap) return null;
  const padded = (estimate * BigInt(12)) / BigInt(10);
  return padded > cap ? cap : padded;
}

/** Does deployed bytecode contain this 4-byte selector (a PUSH4 in the dispatcher)? Cheap "has routeWith" check. */
export function codeHasSelector(code: string | undefined | null, selector: string): boolean {
  return !!code && code.toLowerCase().includes(selector.toLowerCase().replace(/^0x/, ""));
}
