/**
 * Full trade history for the coin chart: /api/trades returns at most TRADES_MAX_LIMIT (5000) fills per call, oldest first,
 * so this pages with ?offset= until a short page (or the page cap). Pure apart from the injected fetch (tested).
 */
import type { Tick } from "./candles";

export const HISTORY_PAGE = 5000, HISTORY_MAX_PAGES = 40;   // ≤ 200K fills; beyond that the oldest pages are kept
type Fetch = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
type FillLike = { id?: string; ts?: number; mcapUsd?: number; usd?: number; usdIn?: number; usdOut?: number; side?: string; block?: number; logIndex?: number };

/** a stored fill → chart tick ($ = the router's real USDG when known, like the feed) */
export function fillTick(f: FillLike): Tick | null {
  if (!f || !Number.isFinite(f.ts) || !Number.isFinite(f.mcapUsd)) return null;
  const side = f.side === "sell" ? "sell" : "buy";
  const real = side === "buy" ? f.usdIn : f.usdOut;
  return { id: f.id, ts: f.ts as number, mcapUsd: f.mcapUsd as number, usd: Number.isFinite(real) && (real as number) > 0 ? real : f.usd, side, block: f.block, logIndex: f.logIndex };
}

export async function fetchHistory(coin: string, fetchFn: Fetch, base = ""): Promise<{ ticks: Tick[]; pages: number; capped: boolean }> {
  const out: Tick[] = [];
  let pages = 0;
  for (let off = 0; pages < HISTORY_MAX_PAGES; off += HISTORY_PAGE) {
    const r = await fetchFn(`${base}/api/trades?coin=${coin}&limit=${HISTORY_PAGE}&order=asc${off ? `&offset=${off}` : ""}`);
    if (!r.ok) { if (pages === 0) throw new Error("trades " + coin); break; }
    const j = (await r.json()) as { fills?: FillLike[] } | null;
    const fills = j?.fills ?? [];
    pages++;
    for (const f of fills) { const t = fillTick(f); if (t) out.push(t); }
    if (fills.length < HISTORY_PAGE) return { ticks: out, pages, capped: false };
  }
  return { ticks: out, pages, capped: true };
}
