/**
 * Funnel analytics (funnel-analytics plan, v1 = free KV counter). Six steps, counts only:
 *   land → signin → fund → first_trade → first_launch → return_d1
 * Dedupe is in the browser (each step is sent at most once per browser, lib/funnelClient.ts); the server only keeps
 * counters per network and per UTC day. No user ids, emails, wallet addresses or IPs are stored by the funnel.
 * Pure (no server-only, no DOM): used by the API route, the client and scripts/test-funnel.mts.
 * Later: PostHog (free tier) can replace the counter with the same step names.
 */
export const FUNNEL_STEPS = ["land", "signin", "fund", "first_trade", "first_launch", "return_d1"] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];
export const isFunnelStep = (s: unknown): s is FunnelStep => typeof s === "string" && (FUNNEL_STEPS as readonly string[]).includes(s);

/** Day counters live ~13 months; the all-time counter ~5 years (the KV client's INCR sets the TTL on first write). */
export const DAY_TTL_SEC = 400 * 86400;
export const TOTAL_TTL_SEC = 5 * 365 * 86400;

/** UTC calendar day, "YYYY-MM-DD". */
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The UTC day after `day` ("YYYY-MM-DD"). */
export const nextUtcDay = (day: string) => utcDay(Date.parse(`${day}T00:00:00Z`) + 86400_000);

export const dayKey = (net: string, step: FunnelStep, day: string) => `fun:${net}:${step}:d:${day}`;
export const totalKey = (net: string, step: FunnelStep) => `fun:${net}:${step}:all`;

/** Network bucket: preview deployments never mix with prod; otherwise the chain id (46630 testnet, mainnet later). */
export function funnelNet(chainId: number, vercelEnv: string | undefined): string {
  return vercelEnv === "preview" ? "preview" : String(chainId);
}

/** The last `days` UTC days ending today, oldest first. */
export function lastDays(nowMs: number, days: number): string[] {
  const n = Math.max(1, Math.min(90, Math.floor(days) || 1));
  return Array.from({ length: n }, (_, i) => utcDay(nowMs - (n - 1 - i) * 86400_000));
}
