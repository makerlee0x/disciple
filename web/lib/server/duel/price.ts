import "server-only";
/**
 * The duel's price, server side. Every duel trade fills at THIS price, never at a price the client sends, so a
 * pilot can't pick their own fills. Source: Hyperliquid public allMids (the same stand-in feed Turbo's screens use)
 * until Nova gives us a server-side price/fill stream; swap `fetchMid` then. Cached ~400 ms per instance.
 */
const HL_INFO = process.env.DUEL_PRICE_URL || "https://api.hyperliquid.xyz/info";
let cache: { p: number; at: number } | null = null;
let inflight: Promise<number | null> | null = null;
type MidSource = () => Promise<number | null>;
let override: MidSource | null = null;
/** tests: inject a price source (null = back to Hyperliquid) */
export function setDuelPriceSource(f: MidSource | null) { override = f; cache = null; }

async function fetchMid(): Promise<number | null> {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 1500);
  try {
    const r = await fetch(HL_INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allMids" }), signal: ctl.signal, cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as Record<string, string>;
    const p = Number(j?.BTC); return p > 0 ? p : null;
  } catch { return null; } finally { clearTimeout(t); }
}
/** latest BTC mid, or null if the feed is down (callers refuse the trade rather than guess) */
export async function duelPrice(now = Date.now()): Promise<number | null> {
  if (override) return override();
  if (cache && now - cache.at < 400) return cache.p;
  inflight ??= fetchMid().finally(() => { inflight = null; });
  const p = await inflight;
  if (p) cache = { p, at: Date.now() };
  else if (cache && now - cache.at < 3000) return cache.p;
  return p;
}

/* ---------- the tape: 1-minute candles, for gaps nobody was watching ---------- */
/**
 * When no request or stream ticked a live duel for a while (both pilots closed their tabs), the server must not
 * judge that gap by whatever the price is when someone finally comes back. Candles let it check H-BOMBs against the
 * gap's highs/lows and price the buzzer at the buzzer's own minute. Source: Hyperliquid candleSnapshot (1m).
 */
export interface Candle { t: number; T: number; o: number; c: number; h: number; l: number }
type CandleSource = (from: number, to: number) => Promise<Candle[] | null>;
let candleOverride: CandleSource | null = null;
/** tests: inject a candle source (null = back to Hyperliquid) */
export function setDuelCandleSource(f: CandleSource | null) { candleOverride = f; }

export async function duelCandles(from: number, to: number): Promise<Candle[] | null> {
  if (candleOverride) return candleOverride(from, to);
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2500);
  try {
    const startTime = Math.floor(from / 60_000) * 60_000;
    const r = await fetch(HL_INFO, {
      method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal, cache: "no-store",
      body: JSON.stringify({ type: "candleSnapshot", req: { coin: "BTC", interval: "1m", startTime, endTime: to } }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(j)) return null;
    const out = j.map((c) => ({ t: Number(c.t), T: Number(c.T), o: Number(c.o), c: Number(c.c), h: Number(c.h), l: Number(c.l) }))
      .filter((c) => c.t > 0 && c.o > 0 && c.c > 0 && c.h > 0 && c.l > 0);
    return out.length ? out : null;
  } catch { return null; } finally { clearTimeout(t); }
}
/** Price at time `t` from the tape: inside its minute, open → close by how far into the minute `t` is. */
export function priceAt(tape: Candle[] | null, t: number): number | null {
  const c = tape?.find((k) => t >= k.t && t < k.t + 60_000);
  if (!c) return null;
  return c.o + (c.c - c.o) * Math.min(1, Math.max(0, (t - c.t) / 60_000));
}
