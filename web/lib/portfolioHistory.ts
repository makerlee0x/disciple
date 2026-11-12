/**
 * Profile portfolio block (profile r5): the total, its change over a range, and the chart line.
 * There is no stored portfolio history (lib/portfolio.ts), so — the same method as the header's 24h change — the line is
 * the account's CURRENT holdings priced at each moment (each coin's last indexed fill at/before that time; a moment
 * before a coin's first fill uses its launch price), plus today's cash held flat. Deposits, withdrawals and trades
 * inside the range are not replayed. Pure (unit-tested by scripts/test-portfolio-history.mts).
 */
export type PfRange = "24H" | "7D" | "30D" | "ALL";
export const PF_RANGES: PfRange[] = ["24H", "7D", "30D", "ALL"];
const DAY = 24 * 60 * 60 * 1000;
export const RANGE_MS: Record<Exclude<PfRange, "ALL">, number> = { "24H": DAY, "7D": 7 * DAY, "30D": 30 * DAY };

export type PricePoint = { ts: number; priceUsd: number };
export type HeldCoin = { tokens: number; priceNow: number; fills: PricePoint[] };
export type SeriesPoint = { t: number; v: number };

/** Price of a coin at time t: last positive fill at/before t, else `launch` (coin not traded yet at t). `asc` = fills sorted by ts. */
export function priceAt(asc: PricePoint[], t: number, launch: number): number {
  let lo = 0, hi = asc.length - 1, best = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (asc[mid].ts <= t) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  for (let i = best; i >= 0; i--) if (asc[i].priceUsd > 0) return asc[i].priceUsd;
  return launch;
}

/** Start of a range. ALL = the earliest fill of any coin held (or 24h back when there are none). */
export function rangeStart(range: PfRange, coins: HeldCoin[], now: number): number {
  if (range !== "ALL") return now - RANGE_MS[range];
  let first = Infinity;
  for (const c of coins) for (const f of c.fills) if (f.ts < first) first = f.ts;
  return Number.isFinite(first) ? Math.min(first, now - 60_000) : now - DAY;
}

/** n points from the range start to now; the last point is priced at each coin's current price (= the shown total). */
export function portfolioSeries(cashUsd: number, coins: HeldCoin[], range: PfRange, now: number, launch: number, n = 64): SeriesPoint[] {
  const asc = coins.map((c) => ({ ...c, fills: [...c.fills].filter((f) => f.priceUsd > 0).sort((a, b) => a.ts - b.ts) }));
  const start = rangeStart(range, asc, now);
  const out: SeriesPoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = i === n - 1 ? now : start + ((now - start) * i) / (n - 1);
    let v = cashUsd;
    for (const c of asc) v += c.tokens * (i === n - 1 ? c.priceNow : priceAt(c.fills, t, launch));
    out.push({ t, v });
  }
  return out;
}

/** Change over the series (last − first). */
export const seriesChange = (s: SeriesPoint[]) => (s.length > 1 ? s[s.length - 1].v - s[0].v : 0);

/**
 * Token count for a holdings row: `{grouped count} ${TICKER}` (profile r5). Whole tokens grouped; under one token,
 * up to 4 significant digits. Short form (1.24M) only when the full count would not fit the row (`maxChars`).
 */
export function tokenAmountLabel(tokens: number, ticker: string, maxChars = 24): string {
  const t = ticker ? ` $${ticker}` : "";
  if (!(tokens > 0) || !Number.isFinite(tokens)) return `0${t}`;
  const full = tokens >= 1 ? Math.floor(tokens).toLocaleString("en-US") : tokens.toLocaleString("en-US", { maximumSignificantDigits: 4 });
  if ((full + t).length <= maxChars) return full + t;
  const short = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(tokens);
  return short + t;
}
