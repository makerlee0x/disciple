/**
 * Live mids for Turbo Royale's four maps (HYPE, SOL, ETH, BTC), read-only from Hyperliquid's public `allMids` stream,
 * the same source as the duel's BTC chart (priceFeed.ts). The HTTP poll covers the gaps while the socket is down.
 * Nothing is invented: a coin with no price yet is left out, and the game falls back to its simulated walk.
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
