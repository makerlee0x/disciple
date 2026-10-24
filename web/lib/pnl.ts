/**
 * Average-cost-basis position ledger (paper now; vault/indexer later via
 * ProtocolClient.getPosition).
 *
 * Invariants (maker lee):
 *   uPnL     = holdings × (mark − avgEntry)            avgEntry = costBasis / size (buy fee included)
 *   realized += exactly the uPnL portion closed by a sell  = tokens × (fillPrice − avgEntry)
 *   the exit fee is booked separately in `fees` (a cost of the exit, not price PnL),
 *   so a rising mark with size > 0 always means rising uPnL, and a sell at the mark moves PnL from
 *   uPnL into realized one-for-one.
 */
import { CURVE, holdBonus } from "./config";
// No network-fee line in the ledger: there is no flat per-trade "gas" charge to book. The cost basis is exactly the $ the
// buy spent (fee inside), and a receipt-backed fill books what actually moved. (Was: every buy and the creator's First
// BOOST added a modelled ~$0.01 "gas" to the cost basis, so a fresh position showed red from a charge nobody paid.)
// The `gas` arguments below stay for call-site compatibility and default to 0; callers pass 0.

export const FEE = CURVE.tradeFeeBps / 10_000;

export interface Position {
  /** token units */
  size: number;
  /** $ paid (buy fee included) for the current size */
  costBasis: number;
  /** $ realized on sells (closed uPnL; the exit fee is in `fees`) */
  realized: number;
  /** $ exit fees paid (kept out of realized so realized == closed uPnL) */
  fees?: number;
  /** ms timestamp continuous holding started (0 = flat) */
  holdStart: number;
  /** partial sells scale the hold bonus down proportionally */
  sellScale: number;
  /** token supply the sizes were booked with (mcap ↔ price); a different mark supply rescales size on load */
  supply?: number;
  /** ephemeral market session (mock replay); a position from another session is dropped */
  session?: string | null;
}

/** DISCIPLE total supply (lib/sim/config TOTAL_SUPPLY); every source defaults to it. */
export const DEFAULT_SUPPLY = 1_000_000;

/** Re-express a stored position under the mark's supply (same $ cost basis and same entry MCAP). */
export function rebase(p: Position, supply: number): Position {
  const s0 = p.supply || supply;
  if (!(supply > 0) || s0 === supply || !(p.size > 0)) return { ...p, supply };
  return { ...p, size: p.size * (supply / s0), supply };
}

export const emptyPosition = (): Position => ({ size: 0, costBasis: 0, realized: 0, fees: 0, holdStart: 0, sellScale: 1 });

/**
 * Book a First BOOST (creator buy inside the launch tx) into the coin's PnL ledger with its EXACT fill: tokens received
 * and $ paid (fees included). Bug #4: it was never booked, so the creator's HUD showed nothing (or a stale/paper bag)
 * while the tokens sat in another wallet. Only seeds an empty ledger (never double-books).
 */
export function seedCreatorBuyPosition(storageKey: string, tokens: number, usd: number, supply = DEFAULT_SUPPLY, at = Date.now()): Position | null {
  if (!(tokens > 0) || !(usd > 0)) return null;
  try {
    const cur = JSON.parse(localStorage.getItem(storageKey) || "null") as Position | null;
    if (cur && cur.size > 0) return null;
    const p: Position = { ...emptyPosition(), size: tokens, costBasis: usd, holdStart: at, supply };
    localStorage.setItem(storageKey, JSON.stringify({ ...p, session: null }));
    return p;
  } catch { return null; }
}

/** Apply a fill. usd = gross notional; price = $ per token at fill.
 *  frac (sells): close exactly that fraction of the bag (a "50%" button sells half the TOKENS, whatever the fill price);
 *  otherwise tokens = usd / price. A sell never exceeds holdings; selling with no holdings is a no-op. */
export function applyFill(p: Position, side: "buy" | "sell", usd: number, price: number, gas = 0, at = Date.now(), sellFrac?: number, bag?: number): Position {
  const q = { ...p };
  if (price <= 0 || usd <= 0) return q;
  if (side === "buy") {
    const tokens = (usd * (1 - FEE)) / price;
    if (q.size <= 0) { q.holdStart = at; q.sellScale = 1; }
    q.size += tokens;
    q.costBasis += usd + gas;
  } else {
    if (q.size <= 0) return q;
    if (bag !== undefined && bag >= 0 && bag < q.size) Object.assign(q, shrinkToWallet(q, bag));   // stale ledger: settle to the wallet first
    if (q.size <= 0) return q;
    // bag (live): the wallet's real balance before this sell. A $ sell then closes the tracked share pro-rata (same rule as
    // applyExactFill); a % sell is already pro-rata (frac of the wallet = frac of the tracked bag).
    const tokens = sellFrac && sellFrac > 0 ? q.size * Math.min(1, sellFrac) : Math.min(q.size, (usd / price) * trackedShare(q.size, bag));
    const frac = tokens / q.size;
    const basisOut = q.costBasis * frac;
    q.realized += tokens * price - basisOut;                 // = closed uPnL at this price
    q.fees = (q.fees || 0) + tokens * price * FEE + gas;     // exit cost, shown separately
    q.costBasis -= basisOut;
    q.size -= tokens;
    q.sellScale *= 1 - frac;
    if (q.size <= 1e-12) { q.size = 0; q.costBasis = 0; q.holdStart = 0; q.sellScale = 1; }
  }
  return q;
}

/**
 * EXACT fill from the tx receipt (lib/flight/fills.ts decodes UsdgTrade / Trade logs): real USDG in/out and real token amounts,
 * so cost basis, avg entry and realized use what actually moved instead of the curve-average estimate applyFill books.
 *   buy : size += tokens received; costBasis += USDG spent (fee inside)
 *   sell: closes `tokens` of the bag; realized += (usdOut + feeUsd) − basisOut (gross of the exit fee, same convention as
 *         applyFill), fees += feeUsd. A sell larger than the ledger bag (tokens bought outside this ledger) books
 *         only the ledger's share of the proceeds.
 * Paper / sim fills keep applyFill (curve-average booking); this is for live (receipt-backed) fills only.
 */
export interface ExactFill {
  /** USDG spent (buy, refund already subtracted) or received (sell, net of fees), in $ */
  usd: number;
  /** tokens received (buy) or sold (sell), whole tokens */
  tokens: number;
  /** trade fee in $ (sell: inside the gross; buy: informational, already inside `usd`) */
  feeUsd?: number;
  /** live sells: the wallet balance (whole tokens) the sell was sized from, i.e. right before it (TradeBridge) */
  bag?: number;
}
/** Share of a wallet sell that closes TRACKED tokens: ledger size ÷ wallet balance before the sell (≤ 1; 1 when unknown). */
export const trackedShare = (size: number, bag?: number) => (bag !== undefined && bag > size && size > 0 ? size / bag : 1);

/** bag (live sells): the wallet's real balance right before the sell. When the wallet holds tokens the ledger never saw
 *  (bought before the game tracked this coin / elsewhere), a sell is split pro-rata between tracked and untracked tokens,
 *  so a 50% DUMP closes 50% of the tracked bag (not all of it), and only the tracked part's proceeds go into realized.
 *  Without bag (paper / sim / old callers): a sell larger than the ledger closes the whole ledger (unchanged). */
export function applyExactFill(p: Position, side: "buy" | "sell", x: ExactFill, gas = 0, at = Date.now(), bag?: number): Position {
  const q = { ...p };
  if (!(x.tokens > 0) || !(x.usd >= 0)) return q;
  if (bag === undefined && x.bag !== undefined && x.bag >= 0) bag = x.bag;
  if (side === "buy") {
    if (q.size <= 0) { q.holdStart = at; q.sellScale = 1; }
    q.size += x.tokens;
    q.costBasis += x.usd + gas;
    return q;
  }
  if (q.size <= 0) return q;
  if (bag !== undefined && bag >= 0 && bag < q.size) Object.assign(q, shrinkToWallet(q, bag));   // stale ledger: settle to the wallet first
  if (q.size <= 0) return q;
  const tokens = Math.min(q.size, x.tokens * trackedShare(q.size, bag));
  const share = tokens / x.tokens;                      // part of this sell that closes ledger tokens
  const fee = (x.feeUsd || 0) * share;
  const frac = tokens / q.size;
  const basisOut = q.costBasis * frac;
  q.realized += x.usd * share + fee - basisOut;
  q.fees = (q.fees || 0) + fee + gas;
  q.costBasis -= basisOut;
  q.size -= tokens;
  q.sellScale *= 1 - frac;
  if (q.size <= Math.max(1e-12, tokens * 1e-9)) { q.size = 0; q.costBasis = 0; q.holdStart = 0; q.sellScale = 1; }
  return q;
}

/**
 * Optimistic live fills, reconciled when the receipt lands. The HUD books the estimate immediately (applyFill at the
 * engine's fill mark) and keeps {id: txHash, before, est}; when the receipt's exact fill arrives, the ledger is rebuilt
 * from that entry's `before` replaying every later pending fill (exact where known, else its estimate). Entries whose
 * receipt is in (and that have no earlier pending entry) are final and dropped.
 */
export interface PendingFill {
  id: string;
  side: "buy" | "sell";
  before: Position;
  est: { usd: number; price: number; gas: number; at: number; frac?: number; /** live sells: wallet balance before the sell */ bag?: number };
  exact?: ExactFill;
}
export function bookPending(pos: Position, pending: PendingFill[], f: Omit<PendingFill, "before">): { pos: Position; pending: PendingFill[] } {
  const e: PendingFill = { ...f, before: pos };
  return { pos: replayOne(pos, e), pending: [...pending, e] };
}
function replayOne(p: Position, e: PendingFill): Position {
  return e.exact ? applyExactFill(p, e.side, e.exact, e.est.gas, e.est.at, e.exact.bag ?? e.est.bag) : applyFill(p, e.side, e.est.usd, e.est.price, e.est.gas, e.est.at, e.est.frac, e.est.bag);
}
/** Receipt for pending fill `id` → rebuilt position, or null when `id` is not pending (caller books it directly). */
export function reconcileFill(pending: PendingFill[], id: string, exact: ExactFill): { pos: Position; pending: PendingFill[] } | null {
  const i = pending.findIndex((e) => e.id === id);
  if (i < 0) return null;
  const list = pending.map((e) => ({ ...e }));
  list[i].exact = exact;
  let pos = list[i].before;
  for (let k = i; k < list.length; k++) { list[k].before = pos; pos = replayOne(pos, list[k]); }
  let n = 0; while (n < list.length && list[n].exact) n++;
  return { pos, pending: list.slice(n) };
}

/** Shared PnL money/percent formatting (HUD, rocket tag, bottom bar, toasts).
 *  $ always 2 decimals; ≥ $1K compact with 2 decimals ($1.23K / $4.56M / $7.89B / $1.00T). Percent: 1 decimal. */
export function fmtMoney(v: number): string {
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  const n = a >= 1e12 ? (a / 1e12).toFixed(2) + "T" : a >= 1e9 ? (a / 1e9).toFixed(2) + "B" : a >= 1e6 ? (a / 1e6).toFixed(2) + "M" : a >= 1e3 ? (a / 1e3).toFixed(2) + "K" : a.toFixed(2);
  return s + "$" + n;
}
/** Signed: "+$0.11" / "−$0.11"; zero (and −0.00 after rounding) shows "+$0.00". */
export function fmtPnl(v: number): string { return (v < 0 && Math.abs(v) >= 0.005 ? "−" : "+") + fmtMoney(Math.abs(v)); }
export function fmtPct(v: number): string { return (v < 0 && Math.abs(v) >= 0.05 ? "−" : "+") + Math.abs(v).toFixed(1) + "%"; }

export interface PositionView {
  size: number;
  valueUsd: number;
  avgEntryUsd: number;
  entryMcap: number;
  pnlPct: number;
  uPnl: number;
  realized: number;
  fees: number;
  bonus: number;
}

/** Mark-to-market: uPnL = size × (mark − avgEntry). valueUsd = size × mark (gross, before the exit fee). */
export function view(p: Position, price: number, supply: number, now = Date.now()): PositionView {
  const valueUsd = p.size * price;
  const avg = p.size > 0 ? p.costBasis / p.size : 0;
  const uPnl = p.size > 0 ? p.size * (price - avg) : 0;
  const held = p.holdStart ? (now - p.holdStart) / 3.6e6 : 0;
  return {
    size: p.size, valueUsd, avgEntryUsd: avg, entryMcap: avg * supply,
    pnlPct: p.costBasis > 0 ? (uPnl / p.costBasis) * 100 : 0,
    uPnl, realized: p.realized, fees: p.fees || 0,
    bonus: holdBonus(uPnl, held, p.sellScale, valueUsd),
  };
}

/**
 * Buy fees inside the open position's cost basis, in $, when they are the ONLY reason uPnL is red (the mark is at or above
 * the fee-free entry), else 0. The PnL HUD then labels the red number "incl. $X buy fees". Buy fee = FEE × $ spent
 * (applyFill books tokens = usd·(1−FEE)/price), so the fee share of the basis is costBasis × FEE.
 */
export function redFromBuyFees(p: Position, v: Pick<PositionView, "size" | "uPnl">): number {
  if (!(v.size > 0) || !(v.uPnl < -0.005)) return 0;
  const fees = p.costBasis * FEE;
  return -v.uPnl <= fees + 1e-9 ? fees : 0;
}

/**
 * LIVE HUD position = the WALLET (maker lee: "should be from actual wallet balance"). The holdings amount and its $ value
 * are the trading account's real balanceOf for this coin × the mark, the same balance DUMP % sells (TradeBridge reads it
 * with freshSellBalance and pushes it as 'disciple:holdings'), so what the HUD shows is what DUMP sells.
 *
 * Cost basis / PnL — never invented. The ledger (game-tracked buys, receipt-exact) only knows what it booked:
 *   tracked   = min(ledger size, wallet)          tokens with a known cost
 *   untracked = wallet − tracked                  tokens bought before tracking / elsewhere: no cost basis, so no PnL
 *   costBasis = ledger.costBasis × tracked / ledger.size   (ledger bigger than the wallet ⇒ scaled down pro-rata)
 *   uPnL      = tracked × mark − costBasis;  pnlPct = uPnL ÷ costBasis;  avg entry = tracked avg entry
 * The untracked part counts in holdings value (it is real money DUMP sells) but not in uPnL / % / points; the HUD says so in
 * dollars ("$X held before tracking · no PnL"). Realized only ever books the tracked share of a sell (applyExactFill bag).
 */
export interface WalletView extends PositionView {
  /** tokens with a known (tracked) cost */
  tracked: number;
  /** $ value of the tracked tokens at the mark */
  trackedUsd: number;
  /** tokens in the wallet the ledger never booked (no cost basis ⇒ no PnL) */
  untracked: number;
  /** $ value of the untracked tokens at the mark */
  untrackedUsd: number;
  /** cost basis of the tracked tokens */
  costBasis: number;
}
export function walletView(p: Position, walletTokens: number, price: number, supply: number, now = Date.now()): WalletView {
  const wallet = walletTokens > 0 ? walletTokens : 0;
  const tracked = Math.min(Math.max(0, p.size), wallet);
  const scale = p.size > 0 ? tracked / p.size : 0;
  const basis = p.costBasis * scale;
  const avg = tracked > 0 ? basis / tracked : 0;
  const trackedUsd = tracked * price, uPnl = tracked > 0 ? trackedUsd - basis : 0;
  const held = tracked > 0 && p.holdStart ? (now - p.holdStart) / 3.6e6 : 0;
  const untracked = Math.max(0, wallet - tracked);
  return {
    size: wallet, valueUsd: wallet * price, avgEntryUsd: avg, entryMcap: avg * supply,
    pnlPct: basis > 0 ? (uPnl / basis) * 100 : 0,
    uPnl, realized: p.realized, fees: p.fees || 0,
    bonus: holdBonus(uPnl, held, p.sellScale, trackedUsd),
    tracked, trackedUsd, untracked, untrackedUsd: untracked * price, costBasis: basis,
  };
}

/**
 * Shrink the stored ledger to a SETTLED wallet balance (no own trade in flight / just landed): tokens that left the wallet
 * outside the game take their share of the cost basis with them (pro-rata, nothing booked to realized: the proceeds are
 * unknown). Never grows the ledger (untracked tokens stay untracked). Returns the same object when nothing changes.
 */
export function shrinkToWallet(p: Position, walletTokens: number): Position {
  if (!(p.size > 0) || !(walletTokens >= 0) || walletTokens >= p.size * (1 - 1e-9)) return p;
  if (walletTokens <= p.size * 1e-9) return { ...p, size: 0, costBasis: 0, holdStart: 0, sellScale: 1 };
  const k = walletTokens / p.size;
  return { ...p, size: walletTokens, costBasis: p.costBasis * k, sellScale: p.sellScale * k };
}
