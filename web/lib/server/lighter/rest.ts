import "server-only";
/** Lighter REST calls Disciple needs (shapes from Lighter's OpenAPI models, lighter-sdk 1.1.8). */
import { getAddress } from "viem";
import type { LighterConfig } from "./config";

export class LighterError extends Error {
  constructor(public status: number, message: string, public code?: number) { super(message); }
}

type Resp = { code?: number; message?: string };
async function call<T extends Resp>(cfg: LighterConfig, p: string, init?: RequestInit): Promise<T> {
  const res = await fetch(cfg.url + p, { ...init, cache: "no-store", signal: AbortSignal.timeout(8000) });
  const j = (await res.json().catch(() => ({}))) as T;
  // Lighter answers code 200 on success; anything else carries a message
  if (!res.ok || (j.code !== undefined && j.code !== 200)) throw new LighterError(res.status || 502, j.message || `Lighter ${p} ${res.status}`, j.code);
  return j;
}
const get = <T extends Resp>(cfg: LighterConfig, p: string, q: Record<string, string | number>) =>
  call<T>(cfg, `${p}?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]))}`);
const form = <T extends Resp>(cfg: LighterConfig, p: string, f: Record<string, string | number>, headers: Record<string, string> = {}) =>
  call<T>(cfg, p, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(Object.entries(f).map(([k, v]) => [k, String(v)])) });

export interface MarketDetail {
  symbol: string; market_id: number; status: string;
  size_decimals: number; price_decimals: number;
  min_base_amount: string; min_quote_amount: string;
  last_trade_price: number; mark_price?: string;
  min_initial_margin_fraction: number; taker_fee: string; market_type?: string;
}
export interface LighterPosition { market_id: number; symbol: string; sign: number; position: string; avg_entry_price: string; unrealized_pnl: string; liquidation_price: string; allocated_margin: string }
export interface LighterAccount { index: number; account_type: number; collateral: string; available_balance: string; positions: LighterPosition[]; approved_integrators?: unknown[] }

let marketsCache: { at: number; net: string; rows: MarketDetail[] } | null = null;
export async function markets(cfg: LighterConfig): Promise<MarketDetail[]> {
  if (marketsCache && marketsCache.net === cfg.network && Date.now() - marketsCache.at < 10 * 60_000) return marketsCache.rows;
  const r = await get<Resp & { order_book_details: MarketDetail[] }>(cfg, "/api/v1/orderBookDetails", { filter: "perp" });
  marketsCache = { at: Date.now(), net: cfg.network, rows: r.order_book_details ?? [] };
  return marketsCache.rows;
}
export async function marketBySymbol(cfg: LighterConfig, symbol: string): Promise<MarketDetail> {
  const rows = await markets(cfg);
  const m = rows.find((x) => x.symbol === symbol && (x.market_type ?? "perp") === "perp") ?? rows.find((x) => x.symbol === symbol);
  if (!m) throw new LighterError(404, `No ${symbol} market on Lighter ${cfg.network}.`);
  return m;
}
/** Fresh price for one market (the 30 s list cache is too old to size an order). */
export async function marketNow(cfg: LighterConfig, marketId: number): Promise<MarketDetail> {
  const r = await get<Resp & { order_book_details: MarketDetail[] }>(cfg, "/api/v1/orderBookDetails", { market_id: marketId });
  const m = r.order_book_details?.[0];
  if (!m) throw new LighterError(404, "Lighter market not found.");
  return m;
}

/** The player's main Lighter account for their wallet, or null before their first deposit. */
/** The player's main Lighter account, or null if they haven't deposited yet. Lighter matches the address as given, so
 *  try the checksummed form first, then lowercase. */
export async function accountIndexOf(cfg: LighterConfig, l1: string, trace?: string[]): Promise<number | null> {
  const forms = [...new Set([safeChecksum(l1), l1.toLowerCase()])];
  for (const a of forms) {
    try {
      // the app uses /account?by=l1_address (accountsByL1Address 400s on testnet for real accounts)
      const r = await get<Resp & { accounts?: { index: number; account_type?: number }[] }>(cfg, "/api/v1/account", { by: "l1_address", value: a });
      trace?.push(`${a.slice(0, 8)} account: ${JSON.stringify(r.accounts?.map((x) => [x.index, x.account_type]) ?? r).slice(0, 200)}`);
      const main = r.accounts?.find((x) => !x.account_type) ?? r.accounts?.[0];
      if (main) return Number(main.index);
    } catch (e) {
      trace?.push(`${a.slice(0, 8)} account: ${e instanceof LighterError ? `${e.status} ${e.code ?? ""} ${e.message}` : String(e)}`.slice(0, 200));
      if (!(e instanceof LighterError && (e.status === 400 || e.status === 404))) throw e;
    }
    try {
      const r = await get<Resp & { sub_accounts?: { index: number; account_type?: number }[] }>(cfg, "/api/v1/accountsByL1Address", { l1_address: a });
      trace?.push(`${a.slice(0, 8)}: ${JSON.stringify(r).slice(0, 200)}`);
      const main = r.sub_accounts?.find((x) => !x.account_type) ?? r.sub_accounts?.[0];
      if (main) return Number(main.index);
    } catch (e) {
      trace?.push(`${a.slice(0, 8)}: ${e instanceof LighterError ? `${e.status} ${e.code ?? ""} ${e.message}` : String(e)}`.slice(0, 200));
      if (!(e instanceof LighterError && (e.status === 400 || e.status === 404))) throw e;
    }
  }
  return null;
}
function safeChecksum(a: string) { try { return getAddress(a); } catch { return a; } }
export async function account(cfg: LighterConfig, index: number): Promise<LighterAccount | null> {
  const r = await get<Resp & { accounts: LighterAccount[] }>(cfg, "/api/v1/account", { by: "index", value: index });
  return r.accounts?.[0] ?? null;
}
export async function nextNonce(cfg: LighterConfig, accountIndex: number, apiKeyIndex: number): Promise<number> {
  return (await get<Resp & { nonce: number }>(cfg, "/api/v1/nextNonce", { account_index: accountIndex, api_key_index: apiKeyIndex })).nonce;
}
/** The price a market order of `base` (size units) would reach walking the book, or null if the book can't fill it.
 *  Market orders cap at this + slippage: capping off the mark price gets "price too low for IoC" on a thin book. */
export type Book = { asks: { price: string; remaining_base_amount: string }[]; bids: { price: string; remaining_base_amount: string }[] };
export async function book(cfg: LighterConfig, marketId: number): Promise<Book> {
  const r = await get<Resp & Partial<Book>>(cfg, "/api/v1/orderBookOrders", { market_id: marketId, limit: 50 });
  return { asks: r.asks ?? [], bids: r.bids ?? [] };
}
export function fillFrom(b: Book, isAsk: boolean, base: number, sizeDecimals: number): number | null {
  let left = base / 10 ** sizeDecimals;
  for (const o of isAsk ? b.bids : b.asks) { left -= Number(o.remaining_base_amount); if (left <= 1e-12) return Number(o.price); }
  return null;
}
export const midOf = (b: Book) => (b.asks[0] && b.bids[0] ? (Number(b.asks[0].price) + Number(b.bids[0].price)) / 2 : Number(b.asks[0]?.price ?? b.bids[0]?.price ?? 0));
export async function fillPrice(cfg: LighterConfig, marketId: number, isAsk: boolean, base: number, sizeDecimals: number): Promise<number | null> {
  return fillFrom(await book(cfg, marketId), isAsk, base, sizeDecimals);
}
/** What Lighter did with a sent tx, ~1.5 s later (for the test page). Raw and trimmed; never throws. */
export async function txStatus(cfg: LighterConfig, hash: string): Promise<string> {
  await new Promise((ok) => setTimeout(ok, 1500));
  try { return JSON.stringify(await get<Resp>(cfg, "/api/v1/tx", { by: "hash", value: hash })).slice(0, 400); }
  catch (e) { return `tx lookup: ${(e as Error).message}`.slice(0, 200); }
}
export async function sendTx(cfg: LighterConfig, txType: number, txInfo: string): Promise<string> {
  return (await form<Resp & { tx_hash: string }>(cfg, "/api/v1/sendTx", { tx_type: txType, tx_info: txInfo })).tx_hash;
}
/** Plus/Premium/Standard. Lighter allows one downgrade per 24 h. */
export async function changeTier(cfg: LighterConfig, accountIndex: number, tier: string, authToken: string) {
  return form<Resp>(cfg, "/api/v1/changeAccountTier", { account_index: accountIndex, new_tier: tier }, { authorization: authToken });
}
