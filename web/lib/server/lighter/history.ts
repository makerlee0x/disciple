import "server-only";
/**
 * Turbo cash history (maker 2026-11-20, Turbo pill → Advanced): the player's own Lighter record, read straight from
 * Lighter so nothing is our guess. Fills (/api/v1/trades), deposits, withdrawals and transfers (fast withdrawals to
 * Cash are transfers to Lighter's pool). Read with an auth token made by the player's trading key, so it needs set-up's
 * key step; before that there's nothing to show but the first deposit, which status() already reflects.
 *
 * Lighter units (lighter-python models): trade fees are in millionths of the notional (Plus 0.5 bp = 50; our partner
 * fee 0.05 bp = 5, the same unit as LIGHTER_PARTNER_FEE). Timestamps come in ms on trades and s on cash moves; both are
 * turned into ms here. One page of each (newest first), enough for the popup.
 */
import type { LighterConfig } from "./config";
import { getPlayer, open } from "./keys";
import { LighterError, markets } from "./rest";
import { signerFor } from "./signer";
import { cashHistory } from "@/lib/server/cashHistory";

/**
 * Our own record of Turbo cash moves (the Flight log's "To Turbo" / "From Turbo" rows, lib/server/cashHistory). Lighter
 * only answers once set-up's key step is done (the first real trade), so before that these are the only rows; after it they
 * fill in any kind Lighter returned nothing for (a bridge deposit isn't listed under the player's own address).
 */
async function ownMoves(pid: string): Promise<HistoryItem[]> {
  const { rows } = await cashHistory(pid, 4_000).catch(() => ({ rows: [] as Awaited<ReturnType<typeof cashHistory>>["rows"] }));
  return rows.flatMap((r): HistoryItem[] => r.kind === "turbo-in" ? [{ kind: "deposit", at: r.ts, usd: r.usd, fee: null, status: null, tx: r.tx ?? null }]
    : r.kind === "turbo-out" ? [{ kind: "withdraw", at: r.ts, usd: r.usd, fee: null, status: null, tx: r.tx ?? null }] : []);
}

export type HistoryItem =
  | { kind: "fill"; at: number; market: string; side: "buy" | "sell"; size: number; price: number; usd: number; fee: number | null; pnl: number | null; liq: boolean; tx: string | null }
  | { kind: "deposit" | "withdraw" | "in" | "out"; at: number; usd: number; fee: number | null; status: string | null; tx: string | null };

export type History = { account: number | null; items: HistoryItem[]; missing: string[] };

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const ms = (t: unknown) => { const n = num(t); return n > 0 && n < 1e12 ? n * 1000 : n; };
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

type Raw = Record<string, unknown>;
async function read(cfg: LighterConfig, path: string, q: Record<string, string | number>, auth: string): Promise<Raw> {
  const u = `${cfg.url}${path}?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]))}`;
  const r = await fetch(u, { headers: { authorization: auth }, signal: AbortSignal.timeout(8000), cache: "no-store" });
  const j = (await r.json().catch(() => ({}))) as Raw;
  if (!r.ok || (j.code !== undefined && j.code !== 200)) throw new LighterError(r.status || 502, String(j.message ?? `Lighter ${path} ${r.status}`));
  return j;
}

/** one Lighter trade from this account's side */
export function fillOf(t: Raw, me: number, symbols: Map<number, string>): HistoryItem {
  const buy = num(t.bid_account_id) === me;
  const usd = num(t.usd_amount);
  // the taker pays the taker fee (+ the integrator's taker fee); market orders are always takers
  const taker = buy ? !!t.is_maker_ask : !t.is_maker_ask;
  const rate = taker ? num(t.taker_fee) + num(t.integrator_taker_fee) : num(t.maker_fee) + num(t.integrator_maker_fee);
  const fee = usd * rate / 1e6;
  const pnlRaw = buy ? t.bid_account_pnl : t.ask_account_pnl;
  const type = String(t.type ?? "trade");
  return {
    kind: "fill", at: ms(t.timestamp), market: str(t.market_symbol) ?? symbols.get(num(t.market_id)) ?? `#${num(t.market_id)}`,
    side: buy ? "buy" : "sell", size: num(t.size), price: num(t.price), usd,
    // a fee over 1% of the fill means the unit isn't what we think: show nothing rather than a wrong number
    fee: rate >= 0 && fee <= usd * 0.01 ? fee : null,
    pnl: pnlRaw == null || pnlRaw === "" ? null : num(pnlRaw),
    liq: /liquidat|deleverag/i.test(type), tx: str(t.tx_hash),
  };
}

export function transferOf(t: Raw, me: number): HistoryItem {
  const out = num(t.from_account_index) === me && num(t.to_account_index) !== me;
  return { kind: out ? "out" : "in", at: ms(t.timestamp), usd: num(t.amount), fee: t.fee == null ? null : num(t.fee) || null, status: null, tx: str(t.tx_hash) };
}

export async function history(cfg: LighterConfig, pid: string): Promise<History> {
  const p = await getPlayer(cfg, pid);
  if (!p?.keyReady) return { account: p?.account ?? null, items: (await ownMoves(pid)).sort((a, b) => b.at - a.at), missing: [] };
  const w = await signerFor(open(cfg.keySecret, p.enc), cfg.chainId, p.keyIndex, p.account);
  const tok = w.CreateAuthToken(Math.floor(Date.now() / 1000) + 600, p.keyIndex, p.account);
  if (!tok.authToken) throw new Error(`lighter auth: ${tok.error}`);
  const auth = tok.authToken, me = p.account;
  const symbols = new Map((await markets(cfg).catch(() => [])).map((m) => [m.market_id, m.symbol] as const));
  const [fills, deps, wds, xfers] = await Promise.allSettled([
    read(cfg, "/api/v1/trades", { account_index: me, sort_by: "timestamp", sort_dir: "desc", limit: 50 }, auth),
    read(cfg, "/api/v1/deposit/history", { account_index: me, l1_address: pid, filter: "all" }, auth),
    read(cfg, "/api/v1/withdraw/history", { account_index: me, filter: "all" }, auth),
    read(cfg, "/api/v1/transfer/history", { account_index: me }, auth),
  ]);
  const items: HistoryItem[] = [];
  const missing: string[] = [];
  const rows = (r: PromiseSettledResult<Raw>, key: string, name: string) => {
    if (r.status === "rejected") { missing.push(name); console.warn("[lighter history]", name, (r.reason as Error)?.message); return []; }
    const v = r.value[key]; return Array.isArray(v) ? (v as Raw[]) : [];
  };
  for (const t of rows(fills, "trades", "fills")) items.push(fillOf(t, me, symbols));
  for (const d of rows(deps, "deposits", "deposits")) items.push({ kind: "deposit", at: ms(d.timestamp), usd: num(d.amount), fee: null, status: str(d.status), tx: str(d.l1_tx_hash) });
  for (const d of rows(wds, "withdraws", "withdrawals")) items.push({ kind: "withdraw", at: ms(d.timestamp), usd: num(d.amount), fee: null, status: str(d.status), tx: str(d.l1_tx_hash) });
  for (const t of rows(xfers, "transfers", "transfers")) items.push(transferOf(t, me));
  const has = (k: HistoryItem["kind"][]) => items.some((i) => k.includes(i.kind));
  const own = await ownMoves(pid);
  if (!has(["deposit", "in"])) items.push(...own.filter((i) => i.kind === "deposit"));
  if (!has(["withdraw", "out"])) items.push(...own.filter((i) => i.kind === "withdraw"));
  items.sort((a, b) => b.at - a.at);
  return { account: me, items: items.slice(0, 120), missing };
}

/**
 * Up to `pages` × 100 of this account's fills, newest first (the Turbo page's trades and PnL). null = no Turbo account
 * yet (or set-up not done); throws when Lighter doesn't answer.
 */
export async function fillsOf(cfg: LighterConfig, pid: string, pages = 5): Promise<Extract<HistoryItem, { kind: "fill" }>[] | null> {
  const p = await getPlayer(cfg, pid);
  if (!p?.keyReady) return null;
  const w = await signerFor(open(cfg.keySecret, p.enc), cfg.chainId, p.keyIndex, p.account);
  const tok = w.CreateAuthToken(Math.floor(Date.now() / 1000) + 600, p.keyIndex, p.account);
  if (!tok.authToken) throw new Error(`lighter auth: ${tok.error}`);
  const symbols = new Map((await markets(cfg).catch(() => [])).map((m) => [m.market_id, m.symbol] as const));
  const out: Extract<HistoryItem, { kind: "fill" }>[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < pages; i++) {
    const j = await read(cfg, "/api/v1/trades", { account_index: p.account, sort_by: "timestamp", sort_dir: "desc", limit: 100, ...(cursor ? { cursor } : {}) }, tok.authToken);
    const rows = Array.isArray(j.trades) ? (j.trades as Raw[]) : [];
    for (const t of rows) { const f = fillOf(t, p.account, symbols); if (f.kind === "fill") out.push(f); }
    cursor = str(j.next_cursor);
    if (!cursor || rows.length < 100) break;
  }
  return out;
}
