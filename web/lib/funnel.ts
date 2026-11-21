/**
 * Funnel analytics (funnel-analytics plan, v1 = free KV counter). Counts only:
 *   land → signin → fund → first_trade → first_launch → return_d1, plus the Turbo moments (TURBO_STEPS) and the
 *   install-to-trade / referral moments (GROWTH_STEPS), each also split by source (app, X in-app browser, web)
 * Dedupe is in the browser (each step is sent at most once per browser, lib/funnelClient.ts); the server only keeps
 * counters per network and per UTC day. No user ids, emails, wallet addresses or IPs are stored by the funnel.
 * Pure (no server-only, no DOM): used by the API route, the client and scripts/test-funnel.mts.
 * Later: PostHog (free tier) can replace the counter with the same step names.
 */
/** Turbo moments (maker, 2026-11-16: "we need funnel counts for turbo moments"), same once-per-browser rule:
 *  duel_start (first duel reaches GO), duel_finish (first result screen), duel_share (first share or challenge link),
 *  duel_join (first time joining someone's link), duel_rematch (first rematch), duel_request (first /vs rematch request),
 *  royale_join (first Turbo Royale round). */
export const TURBO_STEPS = ["duel_start", "duel_finish", "duel_share", "duel_join", "duel_rematch", "duel_request", "royale_join"] as const;
/** Install-to-trade moments (maker 2026-11-21, "analytics and funnel ... see where people drop off"), same rule:
 *  first_play (first game of any kind: practice or daily flight, duel GO, royale round), first_share (first share sheet,
 *  X post or copied DISCIPLE link), ref_land (first visit that carries a referral), ref_signin / ref_trade (that referred
 *  browser later signs in / trades). "Install" is land counted under the app source (FUNNEL_SOURCES). */
export const GROWTH_STEPS = ["first_play", "first_share", "ref_land", "ref_signin", "ref_trade"] as const;
export const FUNNEL_STEPS = ["land", "signin", "fund", "first_trade", "first_launch", "return_d1", ...TURBO_STEPS, ...GROWTH_STEPS] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];
export const isFunnelStep = (s: unknown): s is FunnelStep => typeof s === "string" && (FUNNEL_STEPS as readonly string[]).includes(s);

/** The ordered install-to-trade funnel the admin view draws (free play comes before sign-in: no wall before a match). */
export const INSTALL_FUNNEL = ["land", "first_play", "signin", "fund", "first_trade", "first_share"] as const satisfies readonly FunnelStep[];
/** The referral funnel, drawn under it. */
export const REF_FUNNEL = ["ref_land", "ref_signin", "ref_trade"] as const satisfies readonly FunnelStep[];

/** A step that also counts another once-per-browser step (a duel GO is also the first play, and so on). */
export const IMPLIES: Partial<Record<FunnelStep, FunnelStep>> = { duel_start: "first_play", royale_join: "first_play", duel_share: "first_share" };
/** Steps that, for a browser that arrived on a referral link, also count the referral version. */
export const REF_TWIN: Partial<Record<FunnelStep, FunnelStep>> = { signin: "ref_signin", first_trade: "ref_trade" };

/** Where the browser is: the DISCIPLE phone app, X's in-app browser (crypto Twitter), or any other browser. */
export const FUNNEL_SOURCES = ["app", "x", "web"] as const;
export type FunnelSource = (typeof FUNNEL_SOURCES)[number];
export const isFunnelSource = (s: unknown): s is FunnelSource => typeof s === "string" && (FUNNEL_SOURCES as readonly string[]).includes(s);
/** Pure: the app shell adds "DiscipleApp/" to its user agent (lib/native); X's browser says "Twitter" (lib/inAppBrowser). */
export function funnelSource(ua: string, nativeApp = false): FunnelSource {
  if (nativeApp || ua.includes("DiscipleApp/")) return "app";
  return /\bTwitter(?:Android)?\b|Twitter for iP(?:hone|ad)/i.test(ua) ? "x" : "web";
}

/** Day counters live ~13 months; the all-time counter ~5 years (the KV client's INCR sets the TTL on first write). */
export const DAY_TTL_SEC = 400 * 86400;
export const TOTAL_TTL_SEC = 5 * 365 * 86400;

/** UTC calendar day, "YYYY-MM-DD". */
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The UTC day after `day` ("YYYY-MM-DD"). */
export const nextUtcDay = (day: string) => utcDay(Date.parse(`${day}T00:00:00Z`) + 86400_000);

export const dayKey = (net: string, step: FunnelStep, day: string) => `fun:${net}:${step}:d:${day}`;
export const totalKey = (net: string, step: FunnelStep) => `fun:${net}:${step}:all`;
/** The same counters split by source (an extra pair of INCRs; the unsplit keys above stay the totals). */
export const srcDayKey = (net: string, step: FunnelStep, src: FunnelSource, day: string) => `fun:${net}:${step}:s:${src}:d:${day}`;
export const srcTotalKey = (net: string, step: FunnelStep, src: FunnelSource) => `fun:${net}:${step}:s:${src}:all`;

/** Network bucket: preview deployments never mix with prod; otherwise the chain id (46630 testnet, mainnet later). */
export function funnelNet(chainId: number, vercelEnv: string | undefined): string {
  return vercelEnv === "preview" ? "preview" : String(chainId);
}

/** The last `days` UTC days ending today, oldest first. */
export function lastDays(nowMs: number, days: number): string[] {
  const n = Math.max(1, Math.min(90, Math.floor(days) || 1));
  return Array.from({ length: n }, (_, i) => utcDay(nowMs - (n - 1 - i) * 86400_000));
}

export type FunnelRow = { step: FunnelStep; n: number; ofTop: number | null; ofPrev: number | null };
/** Ordered funnel: each step's count with its share of the first step and of the step before (null when that is 0).
 *  These are step counters, not cohorts: a week's numbers mix people who started in different weeks. */
export function funnelRows(steps: readonly FunnelStep[], counts: Partial<Record<FunnelStep, number>>): FunnelRow[] {
  const top = counts[steps[0]] ?? 0;
  return steps.map((step, i) => {
    const n = counts[step] ?? 0, prev = i ? counts[steps[i - 1]] ?? 0 : top;
    return { step, n, ofTop: top > 0 ? n / top : null, ofPrev: i === 0 ? null : prev > 0 ? n / prev : null };
  });
}
