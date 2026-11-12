/**
 * DEX-style market-cap candles (lee, Oct 30: "make the coin chart work like DEX Screener"). Pure — tested by
 * scripts/test-dex-candles.mts. The coin page chart (components/flight/DexChart.tsx) builds every timeframe from the
 * indexed on-chain fills (/api/trades: curve Trades pre-ascension, DiscipleHook Trades after — both carry mcapUsd on the same
 * basis, lib/mcap) and then folds live ticks (window "disciple:event" Trade / State) into the last candle.
 *
 * Rules:
 *  - a candle = one wall-clock bucket of `tf` seconds (UTC-aligned, like DEX Screener / TradingView), time = bucket start (s)
 *  - O = the previous candle's close (candles connect, no gaps between bodies); the very first candle opens at `openMcap`
 *    when known (the launch mcap), else at its first trade
 *  - H / L = the extremes of O and every trade's mcap in the bucket; C = the last trade's mcap
 *  - volume = Σ trade $ (buy + sell split kept for the bar colour: green when buys ≥ sells)
 *  - empty buckets are SKIPPED (no flat filler bars; the next candle still opens at the previous close)
 */
export type Tf = 60 | 300 | 3600 | 14400 | 86400;
export const TFS: { s: Tf; l: string }[] = [{ s: 60, l: "1m" }, { s: 300, l: "5m" }, { s: 3600, l: "1h" }, { s: 14400, l: "4h" }, { s: 86400, l: "D" }];
export const isTf = (v: unknown): v is Tf => TFS.some((t) => t.s === v);

/** a trade as the chart needs it (an /api/trades Fill fits: ts ms, mcapUsd, usd, side, id) */
export type Tick = { id?: string; ts: number; mcapUsd: number; usd?: number; side?: "buy" | "sell"; block?: number; logIndex?: number };
export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number; buyVol: number; sellVol: number; n: number };

const ok = (t: Tick) => Number.isFinite(t.ts) && t.ts > 0 && Number.isFinite(t.mcapUsd) && t.mcapUsd > 0;
/** chain order: block / logIndex when both have them, else time */
export const tickOrder = (a: Tick, b: Tick) =>
  a.block != null && b.block != null && a.block !== b.block ? a.block - b.block
    : a.block != null && b.block != null && a.block === b.block && a.logIndex != null && b.logIndex != null ? a.logIndex - b.logIndex
      : a.ts - b.ts;

/** valid, de-duplicated (by id), chain-ordered ticks */
export function cleanTicks(ticks: Tick[]): Tick[] {
  const seen = new Set<string>(), out: Tick[] = [];
  for (const t of ticks) { if (!t || !ok(t)) continue; if (t.id) { if (seen.has(t.id)) continue; seen.add(t.id); } out.push(t); }
  return out.sort(tickOrder);
}

export const bucketOf = (tsMs: number, tf: number) => Math.floor(tsMs / 1000 / tf) * tf;

/** Fold one tick into a candle list (mutates + returns it). A tick older than the last candle's bucket only widens /
 *  adds volume to its own bucket if that candle exists (live ticks can arrive a little out of order); never reorders. */
export function addTick(cs: Candle[], t: Tick, tf: number, openMcap?: number): Candle[] {
  if (!ok(t)) return cs;
  const b = bucketOf(t.ts, tf), m = t.mcapUsd, usd = t.usd && t.usd > 0 ? t.usd : 0, buy = t.side !== "sell";
  const last = cs[cs.length - 1];
  if (last && b < last.time) {
    const c = cs.find((x) => x.time === b);
    if (c) { c.high = Math.max(c.high, m); c.low = Math.min(c.low, m); c.volume += usd; if (buy) c.buyVol += usd; else c.sellVol += usd; c.n++; }
    return cs;
  }
  if (last && last.time === b) {
    last.high = Math.max(last.high, m); last.low = Math.min(last.low, m); last.close = m;
    last.volume += usd; if (buy) last.buyVol += usd; else last.sellVol += usd; last.n++;
    return cs;
  }
  const o = last ? last.close : openMcap && openMcap > 0 ? openMcap : m;
  cs.push({ time: b, open: o, high: Math.max(o, m), low: Math.min(o, m), close: m, volume: usd, buyVol: buy ? usd : 0, sellVol: buy ? 0 : usd, n: 1 });
  return cs;
}

/** every candle of one timeframe from the full history */
export function buildCandles(ticks: Tick[], tf: number, openMcap?: number): Candle[] {
  const cs: Candle[] = [];
  for (const t of cleanTicks(ticks)) addTick(cs, t, tf, openMcap);
  return cs;
}

/** A price-only update (State read / engine mark, no trade): moves the LAST candle's close (and H/L) when it is still the
 *  current bucket; a new bucket with no trade is not created (DEX Screener draws candles from trades only). */
export function markLast(cs: Candle[], mcap: number, nowMs: number, tf: number): boolean {
  const last = cs[cs.length - 1];
  if (!last || !(mcap > 0) || bucketOf(nowMs, tf) !== last.time || last.close === mcap) return false;
  last.close = mcap; last.high = Math.max(last.high, mcap); last.low = Math.min(last.low, mcap);
  return true;
}

/** Default timeframe from the trading span (first → last trade): aim for roughly 20–300 candles. */
export function defaultTf(ticks: Tick[]): Tf {
  const cs = cleanTicks(ticks);
  if (cs.length < 2) return 300;
  const span = (cs[cs.length - 1].ts - cs[0].ts) / 1000;
  if (span <= 6 * 3600) return 60;
  if (span <= 2 * 86400) return 300;
  if (span <= 14 * 86400) return 3600;
  if (span <= 60 * 86400) return 14400;
  return 86400;
}

/** "$7.2K", "$1.3M", "$812", "$2.45B", "$33.4K" — the chart's mcap labels */
export function fmtMcap(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v), s = v < 0 ? "-" : "";
  // 3 significant digits, trailing zeros dropped ("$7.2K" not "$7.20K"; "$7.23K" keeps its precision for tight axis ranges)
  const trim = (t: string) => (t.includes(".") ? t.replace(/\.?0+$/, "") : t);
  const f = (x: number, u: string) => s + "$" + trim(x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)) + u;
  if (a >= 1e9) return f(a / 1e9, "B");
  if (a >= 1e6) return f(a / 1e6, "M");
  if (a >= 1e3) return f(a / 1e3, "K");
  if (a >= 1) return s + "$" + a.toFixed(a >= 100 ? 0 : 2);
  return s + "$" + a.toPrecision(3);
}
/** volume / readout $ (no decimals above $100) */
export const fmtVol = (v: number) => (v >= 1000 ? fmtMcap(v) : "$" + (v >= 100 ? v.toFixed(0) : v.toFixed(2)));

/** chart title ticker: bare, upper-case, ≤10 chars — every leading "$" / space stripped (tickers may arrive as "$SGRAD",
 *  "$$SGRAD" or "SGRAD"); the chart adds exactly one "$". Empty ⇒ "" (title falls back to PRICE). */
export function chartTicker(t?: string | null): string { return String(t ?? "").replace(/^[\s$]+/, "").trim().slice(0, 10).toUpperCase(); }
export function chartTitle(t?: string | null): string { const k = chartTicker(t); return k ? `$${k}` : "PRICE"; }
