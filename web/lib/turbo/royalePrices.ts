/**
 * Live prices for Turbo Royale's four maps (HYPE, SOL, ETH, BTC).
 * Lighter first (maker 2026-11-18: "switch to their charts"): its public `market_stats` WebSocket, the mark price of the
 * venue the real orders go to (mainnet: testnet books are empty, so their prices mean nothing). Hyperliquid's public
 * `allMids` stream (the duel's BTC source, priceFeed.ts) is only for a coin Lighter hasn't priced yet: once Lighter
 * prices a coin, that coin stays on Lighter (a quiet stretch holds its last price), so a chart never jumps between the
 * two venues' prices (maker 2026-11-18). The last prices go out again every second so the game knows they're live.
 * Nothing is invented: a coin with no price from either is left out, and the game holds the drop until all four have one.
 */
import { HYPERLIQUID_INFO_URL, HYPERLIQUID_WS_URL } from "./priceFeed";
import { backoffMs, liveSocket, type LiveSocket } from "@/lib/net/liveSocket";

export const ROYALE_COINS = ["HYPE", "SOL", "ETH", "BTC"] as const;
export type RoyaleCoin = (typeof ROYALE_COINS)[number];
export type RoyaleMids = Partial<Record<RoyaleCoin, number>>;

/** mids out of an `allMids` WS message or the HTTP body */
export function parseRoyaleMids(json: unknown): RoyaleMids {
  const out: RoyaleMids = {};
  if (!json || typeof json !== "object") return out;
  const j = json as Record<string, unknown>;
  const d = j.data && typeof j.data === "object" ? (j.data as Record<string, unknown>) : null;
  const src = (d && d.mids && typeof d.mids === "object" ? d.mids : j.mids && typeof j.mids === "object" ? j.mids : j) as Record<string, unknown>;
  for (const c of ROYALE_COINS) {
    const v = Number(src[c]);
    if (Number.isFinite(v) && v > 0) out[c] = v;
  }
  return out;
}

/** streams mids to `cb` (at most every `everyMs`); returns stop. HTTP poll only while the socket is down. */
export function streamRoyaleMids(cb: (m: RoyaleMids) => void, everyMs = 250): () => void {
  let stopped = false, lastEmit = 0, sock: LiveSocket | null = null;
  let poll: ReturnType<typeof setTimeout> | null = null;
  const up = () => !!sock?.open();
  const emit = (m: RoyaleMids) => {
    if (!Object.keys(m).length) return;
    const now = Date.now(); if (now - lastEmit < everyMs) return; lastEmit = now;
    try { cb(m); } catch { /* listener */ }
  };
  let polling = false;
  const pollLoop = async () => {
    poll = null;
    if (polling || stopped || up()) return;
    polling = true;
    try {
      const r = await fetch(HYPERLIQUID_INFO_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allMids" }) });
      if (r.ok) emit(parseRoyaleMids(await r.json()));
    } catch { /* keep the last price */ }
    polling = false;
    if (!stopped && !up() && !poll) poll = setTimeout(pollLoop, typeof document !== "undefined" && document.hidden ? 5_000 : 1_000);
  };
  sock = liveSocket({
    url: () => HYPERLIQUID_WS_URL,
    onOpen: (ws) => { if (poll) { clearTimeout(poll); poll = null; } ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "allMids" } })); },
    onMessage: (raw) => { try { const j = JSON.parse(raw) as { channel?: string }; if (j.channel === "allMids") emit(parseRoyaleMids(j)); } catch { /* not JSON */ } },
    onDown: () => { if (!poll) void pollLoop(); },
    ping: JSON.stringify({ method: "ping" }), pingMs: 15_000, staleMs: 12_000,
  });
  void pollLoop(); // a first price right away, before the socket is up
  return () => { stopped = true; if (poll) clearTimeout(poll); sock?.stop(); };
}

export const LIGHTER_PRICE_HOST = "mainnet.zklighter.elliot.ai";

/** coin → price out of a Lighter `market_stats` message (one market, or the `/all` map). `ids` maps market_id → coin. */
export function parseLighterStats(json: unknown, ids: Map<number, RoyaleCoin>): RoyaleMids {
  const out: RoyaleMids = {};
  if (!json || typeof json !== "object") return out;
  const ms = (json as Record<string, unknown>).market_stats;
  if (!ms || typeof ms !== "object") return out;
  const one = (o: unknown) => {
    if (!o || typeof o !== "object") return;
    const r = o as Record<string, unknown>;
    const sym = typeof r.symbol === "string" ? r.symbol.toUpperCase() : "";
    const coin = (ROYALE_COINS as readonly string[]).includes(sym) ? (sym as RoyaleCoin) : ids.get(Number(r.market_id));
    const p = Number(r.mark_price ?? r.last_trade_price ?? r.index_price);
    if (coin && Number.isFinite(p) && p > 0) out[coin] = p;
  };
  const m = ms as Record<string, unknown>;
  if ("market_id" in m) one(m); else Object.values(m).forEach(one);
  return out;
}

/** Lighter's market ids for the four coins (public order book list). A good answer is kept for the page's life (ids don't
 *  move), so Climb's two streams and every re-entry share one fetch; a failed one (flaky network) isn't kept. */
const idCache = new Map<string, Promise<Map<number, RoyaleCoin>>>();
export function lighterIds(host: string): Promise<Map<number, RoyaleCoin>> {
  const hit = idCache.get(host); if (hit) return hit;
  const p = (async () => {
    const ids = new Map<number, RoyaleCoin>();
    const r = await fetch(`https://${host}/api/v1/orderBookDetails?filter=perp`);
    const j = (await r.json()) as { order_book_details?: { symbol?: string; market_id?: number }[] };
    for (const d of j.order_book_details ?? []) {
      const sym = String(d.symbol ?? "").toUpperCase();
      if ((ROYALE_COINS as readonly string[]).includes(sym) && Number.isSafeInteger(d.market_id)) ids.set(d.market_id as number, sym as RoyaleCoin);
    }
    if (!ids.size) throw new Error("no ids");
    return ids;
  })();
  // symbols in the stream may still name them; Hyperliquid covers the rest. A failure is forgotten so the next ask retries.
  const safe = p.catch(() => { if (idCache.get(host) === safe) idCache.delete(host); return new Map<number, RoyaleCoin>(); });
  idCache.set(host, safe);
  return safe;
}

/** ids, asked again on a backoff until Lighter answers (a phone that loads the page in a dead zone still gets a feed) */
function idsUntil(host: string, ok: (m: Map<number, RoyaleCoin>) => boolean, cb: (m: Map<number, RoyaleCoin>) => void, stopped: () => boolean) {
  let n = 0;
  const go = () => void lighterIds(host).then((m) => {
    if (stopped()) return;
    cb(m);
    if (!ok(m)) setTimeout(go, backoffMs(n++, 15_000));
  });
  go();
}

/** Lighter mark prices for the four coins; returns stop. `host`: the exchange whose prices (Climb on Lighter passes the
 *  one its orders go to, e.g. api.rh.lighter.xyz) */
export function streamLighterMids(cb: (m: RoyaleMids) => void, host: string = LIGHTER_PRICE_HOST): () => void {
  let ids = new Map<number, RoyaleCoin>(), sock: LiveSocket | null = null, stopped = false;
  const start = () => liveSocket({
    url: () => `wss://${host}/stream`,
    onOpen: (ws) => ws.send(JSON.stringify({ type: "subscribe", channel: "market_stats/all" })),
    onMessage: (raw) => { try { const m = parseLighterStats(JSON.parse(raw), ids); if (Object.keys(m).length) cb(m); } catch { /* not JSON */ } },
    ping: JSON.stringify({ type: "ping" }), pingMs: 15_000, staleMs: 12_000,
  });
  // the socket starts on the first answer (symbols may name the coins even without ids); ids keep being asked for
  idsUntil(host, (m) => m.size > 0, (m) => { if (m.size) ids = m; if (!sock) sock = start(); }, () => stopped);
  return () => { stopped = true; sock?.stop(); sock = null; };
}

/** Royale's feed: Lighter's price per coin once it has one (for good), Hyperliquid's before that; at most every
 *  `everyMs`, and the last prices again every second */
export function streamRoyalePrices(cb: (m: RoyaleMids) => void, everyMs = 250, host: string = LIGHTER_PRICE_HOST): () => void {
  const merged = royaleMerge();
  let last = 0, timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null; last = Date.now();
    const out = merged.prices();
    if (Object.keys(out).length) try { cb(out); } catch { /* listener */ }
  };
  const kick = () => { if (!timer) timer = setTimeout(flush, Math.max(0, everyMs - (Date.now() - last))); };
  const beat = setInterval(() => { if (Date.now() - last > 900) kick(); }, 1_000);
  const stopL = streamLighterMids((m) => { merged.lighter(m); kick(); }, host);
  const stopH = streamRoyaleMids((m) => { merged.hyperliquid(m); kick(); }, 0);
  return () => { stopL(); stopH(); clearInterval(beat); if (timer) clearTimeout(timer); };
}

/** the source rule on its own (tested): a coin Lighter has priced never goes back to Hyperliquid */
export function royaleMerge() {
  const lit: RoyaleMids = {}, hl: RoyaleMids = {};
  return {
    lighter(m: RoyaleMids) { Object.assign(lit, m); },
    hyperliquid(m: RoyaleMids) { Object.assign(hl, m); },
    prices(): RoyaleMids {
      const out: RoyaleMids = {};
      for (const c of ROYALE_COINS) { const p = lit[c] ?? hl[c]; if (p) out[c] = p; }
      return out;
    },
  };
}

/**
 * Lighter's live BTC (or any coin) mid from its order book (maker 2026-11-19: "we need live chart and live price"):
 * `order_book/{market_id}` sends the book, then changed levels (size 0 = gone); the mid of the best bid and ask goes to
 * `cb` on every change. market_stats' mark price only moves every second or two, which drew the chart as stairs.
 * Returns stop.
 */
export function streamLighterBook(coin: RoyaleCoin, cb: (mid: number) => void, host: string = LIGHTER_PRICE_HOST): () => void {
  let stopped = false, id: number | null = null, sock: LiveSocket | null = null;
  const bids = new Map<string, number>(), asks = new Map<string, number>();
  const apply = (side: Map<string, number>, rows: unknown) => {
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      if (!r || typeof r !== "object") continue;
      const o = r as { price?: unknown; size?: unknown };
      const px = String(o.price ?? ""), sz = Number(o.size);
      if (!px || !(Number(px) > 0)) continue;
      if (!(sz > 0)) side.delete(px); else side.set(px, sz);
    }
  };
  const mid = () => {
    let b = 0, a = Infinity;
    for (const k of bids.keys()) { const v = Number(k); if (v > b) b = v; }
    for (const k of asks.keys()) { const v = Number(k); if (v < a) a = v; }
    return b > 0 && Number.isFinite(a) && a > b ? (a + b) / 2 : null;
  };
  const start = () => liveSocket({
    url: () => `wss://${host}/stream`,
    onOpen: (ws) => { bids.clear(); asks.clear(); ws.send(JSON.stringify({ type: "subscribe", channel: `order_book/${id}` })); },
    onMessage: (raw) => {
      try {
        const j = JSON.parse(raw) as { type?: string; order_book?: { asks?: unknown; bids?: unknown } };
        const ob = j.order_book; if (!ob) return;
        if (typeof j.type === "string" && j.type.startsWith("subscribed")) { bids.clear(); asks.clear(); }
        apply(bids, ob.bids); apply(asks, ob.asks);
        const m = mid(); if (m) cb(m);
      } catch { /* not JSON */ }
    },
    // a busy coin's book changes many times a second: quiet for 8 s means the socket is gone
    ping: JSON.stringify({ type: "ping" }), pingMs: 15_000, staleMs: 8_000,
  });
  // before: a failed id lookup (flaky network at page load) left the book off for the whole visit
  idsUntil(host, (m) => [...m.values()].includes(coin), (m) => { for (const [k, c] of m) if (c === coin) id = k; if (id != null && !sock) sock = start(); }, () => stopped);
  return () => { stopped = true; sock?.stop(); sock = null; };
}
