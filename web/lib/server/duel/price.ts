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
