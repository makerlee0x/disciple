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

/** streams mids to `cb` (at most every `everyMs`); returns stop */
export function streamRoyaleMids(cb: (m: RoyaleMids) => void, everyMs = 250): () => void {
  let ws: WebSocket | null = null, stopped = false, backoff = 500, lastEmit = 0;
  let poll: ReturnType<typeof setTimeout> | null = null, retry: ReturnType<typeof setTimeout> | null = null, ping: ReturnType<typeof setInterval> | null = null;
  const emit = (m: RoyaleMids) => {
    if (!Object.keys(m).length) return;
    const now = Date.now(); if (now - lastEmit < everyMs) return; lastEmit = now;
    try { cb(m); } catch { /* listener */ }
  };
  const pollLoop = async () => {
    poll = null;
    if (stopped || (ws && ws.readyState === 1)) return;
    try {
      const r = await fetch(HYPERLIQUID_INFO_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allMids" }) });
      if (r.ok) emit(parseRoyaleMids(await r.json()));
    } catch { /* keep the last price */ }
    if (!stopped && !(ws && ws.readyState === 1)) poll = setTimeout(pollLoop, 1000);
  };
  const connect = () => {
    if (stopped) return;
    let sock: WebSocket;
    try { sock = new WebSocket(HYPERLIQUID_WS_URL); } catch { if (!poll) void pollLoop(); reconnect(); return; }
    ws = sock;
    sock.onopen = () => {
      backoff = 500;
      sock.send(JSON.stringify({ method: "subscribe", subscription: { type: "allMids" } }));
      ping = setInterval(() => { try { sock.send(JSON.stringify({ method: "ping" })); } catch { /* closed */ } }, 30_000);
    };
    sock.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try { const j = JSON.parse(ev.data) as { channel?: string }; if (j.channel === "allMids") emit(parseRoyaleMids(j)); } catch { /* not JSON */ }
    };
    sock.onclose = () => {
      if (ping) { clearInterval(ping); ping = null; }
      if (ws === sock) ws = null;
      if (!stopped) { if (!poll) void pollLoop(); reconnect(); }
    };
  };
  const reconnect = () => {
    if (stopped || retry) return;
    retry = setTimeout(() => { retry = null; connect(); }, backoff);
    backoff = Math.min(backoff * 2, 15_000);
  };
  void pollLoop(); // a first price right away, before the socket is up
  connect();
  return () => {
    stopped = true;
    if (poll) clearTimeout(poll); if (retry) clearTimeout(retry); if (ping) clearInterval(ping);
    if (ws) { ws.onclose = null; try { ws.close(); } catch { /* ignore */ } ws = null; }
  };
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

/** Lighter's market ids for the four coins (public order book list) */
async function lighterIds(): Promise<Map<number, RoyaleCoin>> {
  const ids = new Map<number, RoyaleCoin>();
  try {
    const r = await fetch(`https://${LIGHTER_PRICE_HOST}/api/v1/orderBookDetails?filter=perp`);
    const j = (await r.json()) as { order_book_details?: { symbol?: string; market_id?: number }[] };
    for (const d of j.order_book_details ?? []) {
      const sym = String(d.symbol ?? "").toUpperCase();
      if ((ROYALE_COINS as readonly string[]).includes(sym) && Number.isSafeInteger(d.market_id)) ids.set(d.market_id as number, sym as RoyaleCoin);
    }
  } catch { /* symbols in the stream may still name them; Hyperliquid covers the rest */ }
  return ids;
}

/** Lighter mark prices for the four coins; returns stop */
export function streamLighterMids(cb: (m: RoyaleMids) => void): () => void {
  let ws: WebSocket | null = null, stopped = false, backoff = 500;
  let retry: ReturnType<typeof setTimeout> | null = null, ping: ReturnType<typeof setInterval> | null = null;
  let ids = new Map<number, RoyaleCoin>();
  const connect = () => {
    if (stopped) return;
    let sock: WebSocket;
    try { sock = new WebSocket(`wss://${LIGHTER_PRICE_HOST}/stream`); } catch { reconnect(); return; }
    ws = sock;
    sock.onopen = () => {
      backoff = 500;
      sock.send(JSON.stringify({ type: "subscribe", channel: "market_stats/all" }));
      ping = setInterval(() => { try { sock.send(JSON.stringify({ type: "ping" })); } catch { /* closed */ } }, 20_000);
    };
    sock.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try { const m = parseLighterStats(JSON.parse(ev.data), ids); if (Object.keys(m).length) cb(m); } catch { /* not JSON */ }
    };
    sock.onclose = () => {
      if (ping) { clearInterval(ping); ping = null; }
      if (ws === sock) ws = null;
      reconnect();
    };
  };
  const reconnect = () => {
    if (stopped || retry) return;
    retry = setTimeout(() => { retry = null; connect(); }, backoff);
    backoff = Math.min(backoff * 2, 15_000);
  };
  void lighterIds().then((m) => { ids = m; connect(); });
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry); if (ping) clearInterval(ping);
    if (ws) { ws.onclose = null; try { ws.close(); } catch { /* ignore */ } ws = null; }
  };
}

/** Royale's feed: Lighter's price per coin once it has one (for good), Hyperliquid's before that; at most every
 *  `everyMs`, and the last prices again every second */
export function streamRoyalePrices(cb: (m: RoyaleMids) => void, everyMs = 250): () => void {
  const merged = royaleMerge();
  let last = 0, timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null; last = Date.now();
    const out = merged.prices();
    if (Object.keys(out).length) try { cb(out); } catch { /* listener */ }
  };
  const kick = () => { if (!timer) timer = setTimeout(flush, Math.max(0, everyMs - (Date.now() - last))); };
  const beat = setInterval(() => { if (Date.now() - last > 900) kick(); }, 1_000);
  const stopL = streamLighterMids((m) => { merged.lighter(m); kick(); });
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
