/**
 * Live ETH / BTC prices for the stand-in adapter: Hyperliquid's public mid prices (POST https://api.hyperliquid.xyz/info
 * {"type":"allMids"}). Read-only, no key, no wallet, CORS-open. Nova's 1000× markets are a synthetic on top of
 * Hyperliquid, so these are the closest public numbers until Nova's API / SDK supplies its own price stream.
 * If the feed fails, nothing is made up: the adapter simply has no price and the screen says "Still waiting on a price…".
 */
import type { Market } from "./types";

export interface PriceFeed {
  /** Starts polling; returns stop(). */
  start(onPrice: (m: Market, price: number) => void): () => void;
}

export const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";

export function parseAllMids(json: unknown): Partial<Record<Market, number>> {
  const out: Partial<Record<Market, number>> = {};
  if (!json || typeof json !== "object") return out;
  const j = json as Record<string, unknown>;
  for (const m of ["BTC", "ETH"] as const) {
    const v = typeof j[m] === "string" ? Number(j[m]) : typeof j[m] === "number" ? (j[m] as number) : NaN;
    if (Number.isFinite(v) && v > 0) out[m] = v;
  }
  return out;
}

export function createHyperliquidPriceFeed(opts: { intervalMs?: number; fetchImpl?: typeof fetch; url?: string } = {}): PriceFeed {
  const intervalMs = opts.intervalMs ?? 1000;
  return {
    start(onPrice) {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const f = opts.fetchImpl ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
      const poll = async () => {
        if (stopped || !f) return;
        try {
          const r = await f(opts.url ?? HYPERLIQUID_INFO_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allMids" }) });
          if (r.ok) {
            const mids = parseAllMids(await r.json());
            for (const m of ["BTC", "ETH"] as const) if (mids[m]) onPrice(m, mids[m]!);
          }
        } catch { /* keep the last price; the screen shows "Still waiting on a price…" if none ever arrives */ }
        if (!stopped) timer = setTimeout(poll, typeof document !== "undefined" && document.hidden ? intervalMs * 5 : intervalMs);
      };
      void poll();
      return () => { stopped = true; if (timer) clearTimeout(timer); };
    },
  };
}
