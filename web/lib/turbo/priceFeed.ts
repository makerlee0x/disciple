/**
 * Live ETH / BTC prices and prints for the stand-in adapter.
 *
 * Primary path: Hyperliquid's public WebSocket (wss://api.hyperliquid.xyz/ws), read-only, no key, no wallet.
 *   - `allMids`        → tick-by-tick mid prices (the rocket follows the resulting market cap)
 *   - `trades` BTC/ETH → completed buys and sells (existing engine boosts / bombs). Never `l2Book`.
 * If the socket drops, mid prices may fall back to the public info HTTP poll until the socket is back.
 * Nothing is invented: no mid and no trade is emitted until the venue has sent one.
 *
 * Nova can later replace this stand-in by handing a PriceFeed + TradeFeed to getTurboAdapter() / the adapter hook.
 */
import type { Market, MarketTrade, PriceFeed, TradeFeed } from "./types";

export const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
export const HYPERLIQUID_WS_URL = "wss://api.hyperliquid.xyz/ws";

const MARKETS: Market[] = ["BTC", "ETH"];

export function parseAllMids(json: unknown): Partial<Record<Market, number>> {
  const out: Partial<Record<Market, number>> = {};
  if (!json || typeof json !== "object") return out;
  const j = json as Record<string, unknown>;
  // HTTP allMids body is { BTC: "…", ETH: "…" }. The WS channel wraps that as { channel, data: { mids } } or { data }.
  const src = (j.mids && typeof j.mids === "object" ? j.mids : j.data && typeof j.data === "object" && (j.data as Record<string, unknown>).mids ? (j.data as Record<string, unknown>).mids : j.data && typeof j.data === "object" && !Array.isArray(j.data) ? j.data : j) as Record<string, unknown>;
  for (const m of MARKETS) {
    const v = typeof src[m] === "string" ? Number(src[m]) : typeof src[m] === "number" ? (src[m] as number) : NaN;
    if (Number.isFinite(v) && v > 0) out[m] = v;
  }
  return out;
}

/** WS `allMids` message, or a bare mids map / HTTP body. */
export function parseAllMidsMessage(json: unknown): Partial<Record<Market, number>> {
  return parseAllMids(json);
}

/** One completed print from Hyperliquid's `trades` channel. side B = taker buy, A = taker sell. */
export function parseTradesMessage(json: unknown): MarketTrade[] {
  if (!json || typeof json !== "object") return [];
  const j = json as Record<string, unknown>;
  const raw = Array.isArray(j) ? j : Array.isArray(j.data) ? j.data : j.data && typeof j.data === "object" ? [j.data] : Array.isArray(j.trades) ? j.trades : [];
  const out: MarketTrade[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const coin = String(r.coin ?? r.market ?? "");
    const market = (coin === "BTC" || coin === "ETH" ? coin : "") as Market | "";
    if (!market) continue;
    const sideRaw = String(r.side ?? "");
    const side = sideRaw === "B" || sideRaw === "buy" || sideRaw === "BUY" ? "buy" as const : sideRaw === "A" || sideRaw === "sell" || sideRaw === "SELL" ? "sell" as const : null;
    if (!side) continue;
    const price = Number(r.px ?? r.price);
    const size = Number(r.sz ?? r.size ?? r.qty);
    const usd = Number.isFinite(Number(r.usd)) && Number(r.usd) > 0 ? Number(r.usd) : price * size;
    const ts = Number(r.time ?? r.ts ?? Date.now());
    if (!(price > 0) || !(usd > 0)) continue;
    const id = r.tid != null ? String(r.tid) : r.hash != null ? String(r.hash) : undefined;
    out.push({ market, side, price, usd, size: Number.isFinite(size) && size > 0 ? size : undefined, ts: Number.isFinite(ts) ? ts : Date.now(), id });
  }
  return out;
}

export interface HyperliquidStreamOptions {
  wsUrl?: string;
  infoUrl?: string;
  WebSocketImpl?: typeof WebSocket;
  fetchImpl?: typeof fetch;
  /** HTTP mid poll, used only while the WebSocket is down. Default 5000 ms. */
  pollIntervalMs?: number;
  /** WebSocket ping interval. Default 30000 ms. */
  pingIntervalMs?: number;
}

type PriceCb = (m: Market, price: number) => void;
type TradeCb = (t: MarketTrade) => void;

/**
 * One shared Hyperliquid socket: allMids + trades for BTC and ETH. Price and trade subscribers share the connection.
 * Does not subscribe to l2Book (that's the book, not fills).
 */
export function createHyperliquidStream(opts: HyperliquidStreamOptions = {}) {
  const wsUrl = opts.wsUrl ?? HYPERLIQUID_WS_URL;
  const infoUrl = opts.infoUrl ?? HYPERLIQUID_INFO_URL;
  const pollIntervalMs = opts.pollIntervalMs ?? 5000;
  const pingIntervalMs = opts.pingIntervalMs ?? 30_000;
  const priceSubs = new Set<PriceCb>();
  const tradeSubs = new Set<TradeCb>();
  let ws: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  let backoff = 500;
  let lastPrices: Partial<Record<Market, number>> = {};

  const WSImpl = () => opts.WebSocketImpl ?? (typeof WebSocket !== "undefined" ? WebSocket : null);
  const fetchImpl = () => opts.fetchImpl ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);

  const emitPrices = (mids: Partial<Record<Market, number>>) => {
    for (const m of MARKETS) {
      const p = mids[m];
      if (p && p > 0) {
        lastPrices[m] = p;
        priceSubs.forEach((cb) => { try { cb(m, p); } catch { /* listener */ } });
      }
    }
  };
  const emitTrades = (trades: MarketTrade[]) => {
    for (const t of trades) tradeSubs.forEach((cb) => { try { cb(t); } catch { /* listener */ } });
  };

  const stopPoll = () => { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } };
  const pollOnce = async () => {
    const f = fetchImpl();
    if (!f || priceSubs.size === 0) return;
    try {
      const r = await f(infoUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allMids" }) });
      if (r.ok) emitPrices(parseAllMids(await r.json()));
    } catch { /* keep last mid; never invent one */ }
  };
  const startPoll = () => {
    if (pollTimer || priceSubs.size === 0) return;
    const loop = async () => {
      await pollOnce();
      if (!stopped && (ws == null || ws.readyState !== 1) && priceSubs.size) {
        const wait = typeof document !== "undefined" && document.hidden ? pollIntervalMs * 2 : pollIntervalMs;
        pollTimer = setTimeout(loop, wait);
      } else pollTimer = null;
    };
    void loop();
  };

  const closeSocket = () => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (ws) {
      try { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; ws.close(); } catch { /* ignore */ }
      ws = null;
    }
  };

  const subscribeAll = (sock: WebSocket) => {
    const send = (sub: unknown) => { try { sock.send(JSON.stringify({ method: "subscribe", subscription: sub })); } catch { /* ignore */ } };
    send({ type: "allMids" });
    for (const coin of MARKETS) send({ type: "trades", coin });
  };

  const connect = () => {
    if (stopped) return;
    const Impl = WSImpl();
    if (!Impl) { startPoll(); return; }
    closeSocket();
    let sock: WebSocket;
    try { sock = new Impl(wsUrl); } catch { startPoll(); scheduleReconnect(); return; }
    ws = sock;
    sock.onopen = () => {
      backoff = 500;
      stopPoll();
      subscribeAll(sock);
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => { try { if (sock.readyState === 1) sock.send(JSON.stringify({ method: "ping" })); } catch { /* ignore */ } }, pingIntervalMs);
    };
    sock.onmessage = (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : "";
      if (!raw) return;
      let json: unknown;
      try { json = JSON.parse(raw); } catch { return; }
      if (!json || typeof json !== "object") return;
      const ch = String((json as Record<string, unknown>).channel ?? "");
      if (ch === "trades" || (Array.isArray((json as Record<string, unknown>).data) && (json as Record<string, unknown>).data)) {
        const trades = parseTradesMessage(json);
        if (trades.length) emitTrades(trades);
      }
      if (ch === "allMids" || ch === "subscriptionResponse") {
        const mids = parseAllMidsMessage(json);
        if (Object.keys(mids).length) emitPrices(mids);
      } else if (!ch) {
        const mids = parseAllMidsMessage(json);
        if (Object.keys(mids).length) emitPrices(mids);
      }
    };
    sock.onerror = () => { /* onclose reconnects */ };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (!stopped) { startPoll(); scheduleReconnect(); }
    };
  };

  const scheduleReconnect = () => {
    if (stopped || retryTimer) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, 15_000);
    retryTimer = setTimeout(() => { retryTimer = null; if (!stopped) connect(); }, wait);
  };

  const ensure = () => {
    if (stopped) {
      stopped = false;
      connect();
    } else if (!ws || (ws.readyState !== 0 && ws.readyState !== 1)) {
      if (!retryTimer) connect();
    }
  };

  const maybeStop = () => {
    if (priceSubs.size || tradeSubs.size) return;
    stopped = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    stopPoll();
    closeSocket();
  };

  return {
    start(handlers: { onPrice?: PriceCb; onTrade?: TradeCb }): () => void {
      if (handlers.onPrice) priceSubs.add(handlers.onPrice);
      if (handlers.onTrade) tradeSubs.add(handlers.onTrade);
      ensure();
      // replay last mids so a late subscriber (market switch) isn't blank
      if (handlers.onPrice) for (const m of MARKETS) if (lastPrices[m]) handlers.onPrice(m, lastPrices[m]!);
      return () => {
        if (handlers.onPrice) priceSubs.delete(handlers.onPrice);
        if (handlers.onTrade) tradeSubs.delete(handlers.onTrade);
        maybeStop();
      };
    },
  };
}

/** PriceFeed wrapper around the shared stream (plus HTTP fallback while the socket is down). */
export function createHyperliquidPriceFeed(opts: HyperliquidStreamOptions & { stream?: ReturnType<typeof createHyperliquidStream> } = {}): PriceFeed {
  const stream = opts.stream ?? createHyperliquidStream(opts);
  return { start(onPrice) { return stream.start({ onPrice }); } };
}

/** TradeFeed wrapper: completed BTC/ETH prints only. */
export function createHyperliquidTradeFeed(opts: HyperliquidStreamOptions & { stream?: ReturnType<typeof createHyperliquidStream> } = {}): TradeFeed {
  const stream = opts.stream ?? createHyperliquidStream(opts);
  return { start(onTrade) { return stream.start({ onTrade }); } };
}
