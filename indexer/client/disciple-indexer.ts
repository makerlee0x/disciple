/**
 * Minimal typed client for the DISCIPLE indexer REST API (example for SITE/GAME; copy into /web if wanted).
 * Usage: const api = indexer("http://localhost:4200"); const coins = await api.coins({ sort: "volume" });
 */
export type Addr = `0x${string}`;
export interface Coin {
  token: Addr; stack: string; curve: Addr; creator: Addr; quote: Addr; name: string; ticker: string; graduated: number | boolean;
  pool_id: string | null; anon: number | boolean; stealth_owner: Addr | null; tier: number | null; launched_at: number;
  volume_usd?: number; trades?: number; last_mcap?: number | null;
}
export interface Trade {
  id: string; token: Addr; source: "curve" | "hook"; trader: Addr; is_buy: 0 | 1; quote_amt: string; token_amt: string;
  price_usd: number; volume_usd: number; mcap_usd: string; block: number; ts: number; tx: string;
}
export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number; n: number }
export interface Order {
  stack: string; id: number; kind: "tramp" | "wall"; owner: Addr; token: Addr; tick_lower: number; tick_upper: number;
  status: "open" | "filled" | "cancelled"; amount_in: string; amount_in_usd: number; keeper: Addr | null; keeper_quote_tip: string; keeper_token_tip: string;
}
export interface TierBreak { token: Addr; ticker?: string; fromTier: number; toTier: number; mcapUsd: number; source: "curve" | "hook"; block: number; ts: number; tx: string }
export type Interval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export type Board = "traders" | "creators" | "coins" | "tramps" | "keepers" | "referrers";

export function indexer(base: string, f: typeof fetch = fetch) {
  const get = async <T>(path: string, q: Record<string, string | number | boolean | undefined> = {}): Promise<T> => {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    const r = await f(`${base}${path}${qs.size ? "?" + qs : ""}`);
    if (!r.ok) throw new Error(`indexer ${path}: ${r.status}`);
    return r.json() as Promise<T>;
  };
  return {
    health: () => get<any>("/health"),
    coins: (q: { sort?: "new" | "volume" | "mcap" | "tier"; stack?: string; graduated?: boolean; creator?: Addr; limit?: number } = {}) => get<Coin[]>("/coins", q),
    coin: (t: Addr) => get<Coin & { live: any; tier: any }>(`/coins/${t}`),
    trades: (t: Addr, q: { limit?: number; before?: number } = {}) => get<Trade[]>(`/coins/${t}/trades`, q),
    candles: (t: Addr, interval: Interval = "5m", unit: "price" | "mcap" = "price") => get<Candle[]>(`/coins/${t}/candles`, { interval, unit }),
    holders: (t: Addr, limit = 100) => get<{ holder: Addr; balance: string; pct: number; protocol: boolean }[]>(`/coins/${t}/holders`, { limit }),
    altitude: (t: Addr) => get<{ tier: number | null; mcapUsd: number | null; breaks: TierBreak[]; context: any }>(`/coins/${t}/altitude`),
    feeRouting: (t: Addr) => get<any>(`/coins/${t}/fee-routing`),
    coinOrders: (t: Addr) => get<Order[]>(`/coins/${t}/orders`),
    orders: (q: { status?: string; kind?: string; token?: Addr; owner?: Addr; limit?: number } = {}) => get<Order[]>("/orders", q),
    tierBreaks: (limit = 50) => get<TierBreak[]>("/tier-breaks", { limit }),
    leaderboard: (b: Board, q: { by?: string; since?: number; limit?: number } = {}) => get<any[]>(`/leaderboard/${b}`, q),
    user: (a: Addr) => get<any>(`/users/${a}`),
    userTrades: (a: Addr) => get<Trade[]>(`/users/${a}/trades`),
    userOrders: (a: Addr) => get<Order[]>(`/users/${a}/orders`),
    rewards: () => get<any[]>("/rewards"),
  };
}
