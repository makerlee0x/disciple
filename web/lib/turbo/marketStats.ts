/**
 * Timing info for the pre-launch pad (maker, Nov 13 2026: "right now you're just timing in blind"): 1h change, the 24h
 * range and a 1h sparkline, from Hyperliquid's public candles (info `candleSnapshot`, read-only, no key). Refreshed once a
 * minute; the live price fills in the end of the line between refreshes. Nothing is invented: null until the venue answers.
 */
import type { Market } from "./types";
import { HYPERLIQUID_INFO_URL } from "./priceFeed";

export interface MarketStats {
  /** Close prices of the last ~60 one-minute candles, oldest first. */
  spark: number[];
  /** Price one hour ago (open of the first 1m candle). */
  open1h: number;
  high24h: number;
  low24h: number;
  /** Median high-low range of the last 15 one-minute candles, as a fraction of price ("a typical minute"). */
  typMin: number;
  at: number;
}

type Candle = { t?: number; o?: string | number; h?: string | number; l?: string | number; c?: string | number };

export function parseCandles(json: unknown): { t: number; o: number; h: number; l: number; c: number }[] {
  if (!Array.isArray(json)) return [];
  return (json as Candle[]).map((k) => ({ t: Number(k.t), o: Number(k.o), h: Number(k.h), l: Number(k.l), c: Number(k.c) }))
    .filter((k) => k.o > 0 && k.h > 0 && k.l > 0 && k.c > 0).sort((a, b) => a.t - b.t);
}

/** Pure: build the stats from 1m candles (last hour) and 1h candles (last day). */
export function statsFrom(m1: ReturnType<typeof parseCandles>, h1: ReturnType<typeof parseCandles>, now = Date.now()): MarketStats | null {
  if (!m1.length) return null;
  const day = h1.length ? h1 : m1;
  return {
    spark: m1.slice(-60).map((k) => k.c),
    open1h: m1.slice(-60)[0].o,
    high24h: Math.max(...day.map((k) => k.h), ...m1.map((k) => k.h)),
    low24h: Math.min(...day.map((k) => k.l), ...m1.map((k) => k.l)),
    typMin: (() => { const r = m1.slice(-15).map((k) => (k.h - k.l) / k.c).sort((a, b) => a - b); return r.length ? r[Math.floor(r.length / 2)] : 0; })(),
    at: now,
  };
}

export async function fetchMarketStats(market: Market, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<MarketStats | null> {
  const get = async (interval: string, ms: number) => {
    const r = await fetchImpl(HYPERLIQUID_INFO_URL, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin: market, interval, startTime: now - ms, endTime: now } }) });
    return r.ok ? parseCandles(await r.json()) : [];
  };
  try {
    const [m1, h1] = await Promise.all([get("1m", 61 * 60_000), get("1h", 24 * 3600_000)]);
    return statsFrom(m1, h1, now);
  } catch { return null; }
}

/** Signed % change label: "+0.42%", "−1.3%". */
export function pctChange(from: number, to: number): string {
  if (!(from > 0) || !(to > 0)) return "—";
  const v = (to / from - 1) * 100, a = Math.abs(v);
  return `${v >= 0 ? "+" : "−"}${a.toFixed(a < 1 ? 2 : 1)}%`;
}
