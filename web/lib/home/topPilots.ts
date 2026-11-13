/**
 * Signed-out lobby: Top pilots (biggest cash-outs) and the live ticker, from the indexed trade fills (lib/server/trades,
 * the same fills the lobby stats use). Pure and isomorphic; nothing here is sampled or mocked.
 *
 * Profit is realized P&L on average cost (lib/pnl's rule): a dump books (cash received) minus (the cost of the tokens
 * sold). Only tokens whose buy is in the indexed history count: a dump of tokens bought before the history starts is
 * left out, so a cut-off history can understate a pilot but never invent profit. A dump lands in the window of its time.
 */
import { BOMB_TIERS } from "@/lib/config";
import { bombTierIndex } from "@/lib/flight/bombTier";
import { playerUsd, type Fill } from "@/lib/trades";
import { DAY_MS, prePriceOf } from "./trending";

export type PilotWindow = "day" | "week" | "month";
export const PILOT_WINDOWS: readonly { k: PilotWindow; label: string; ms: number }[] = [
  { k: "day", label: "Today", ms: DAY_MS },
  { k: "week", label: "Week", ms: 7 * DAY_MS },
  { k: "month", label: "Month", ms: 30 * DAY_MS },
];

export type TopPilot = {
  wallet: string;
  /** chosen username, if the pilot claimed one (server fills it) */
  username?: string | null;
  level?: number | null;
  prestige?: number | null;
  /** distinct rockets this pilot cashed out of in the window */
  flights: number;
  /** realized profit in the window, $ */
  pnlUsd: number;
};
export type TopPilots = Record<PilotWindow, TopPilot[]>;

export const EMPTY_PILOTS: TopPilots = { day: [], week: [], month: [] };

type Book = { size: number; cost: number };

/** Realized profit per (window, wallet) from every coin's fills. `fillsByCoin`: any order per coin. */
export function topPilots(fillsByCoin: Fill[][], now: number, n = 5): TopPilots {
  const acc: Record<PilotWindow, Map<string, { pnl: number; coins: Set<string> }>> = { day: new Map(), week: new Map(), month: new Map() };
  for (const fills of fillsByCoin) {
    const asc = [...fills].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    const books = new Map<string, Book>();
    for (const f of asc) {
      const w = f.trader.toLowerCase();
      const b = books.get(w) ?? { size: 0, cost: 0 };
      const usd = playerUsd(f);
      if (!(f.tokens > 0) || !(usd > 0)) continue;
      if (f.side === "buy") { b.size += f.tokens; b.cost += usd; books.set(w, b); continue; }
      if (!(b.size > 0)) continue; // tokens bought before the indexed history: no known cost, not counted
      const sold = Math.min(f.tokens, b.size);
      const basis = b.cost * (sold / b.size);
      const pnl = usd * (sold / f.tokens) - basis;
      b.size -= sold; b.cost -= basis;
      if (b.size < 1e-9) { b.size = 0; b.cost = 0; }
      books.set(w, b);
      const age = now - f.ts;
      for (const win of PILOT_WINDOWS) {
        if (age < 0 || age > win.ms) continue;
        const m = acc[win.k];
        const r = m.get(w) ?? { pnl: 0, coins: new Set<string>() };
        r.pnl += pnl; r.coins.add(f.coin.toLowerCase());
        m.set(w, r);
      }
    }
  }
  const out = { ...EMPTY_PILOTS } as TopPilots;
  for (const win of PILOT_WINDOWS) {
    out[win.k] = [...acc[win.k].entries()]
      .filter(([, r]) => r.pnl >= 0.01)
      .sort((a, b) => b[1].pnl - a[1].pnl)
      .slice(0, n)
      .map(([wallet, r]) => ({ wallet, flights: r.coins.size, pnlUsd: Math.round(r.pnl * 100) / 100 }));
  }
  return out;
}

/** One ticker line: a boost or a bomb on a rocket. */
export type TickerItem = {
  id: string;
  kind: "boost" | "bomb";
  coin: string;
  coinName: string;
  trader: string;
  username?: string | null;
  usd: number;
  /** bombs: the bomb's tier name (PUFF … ATOM BOMB) and the drop it made, % */
  bomb?: string;
  dropPct?: number;
  ts: number;
};

/** The latest boosts and bombs across every rocket, newest first. */
export function tickerOf(fillsByCoin: Fill[][], names: Map<string, string>, n = 16): TickerItem[] {
  const all: Fill[] = [];
  for (const fills of fillsByCoin) for (const f of fills) all.push(f);
  all.sort((a, b) => b.ts - a.ts || b.block - a.block || b.logIndex - a.logIndex);
  const out: TickerItem[] = [];
  for (const f of all) {
    if (out.length >= n) break;
    const usd = playerUsd(f) || f.usd;
    if (!(usd >= 1)) continue; // dust trades make a noisy ticker
    const coin = f.coin.toLowerCase();
    const item: TickerItem = { id: f.id, kind: f.side === "buy" ? "boost" : "bomb", coin, coinName: names.get(coin) ?? "", trader: f.trader.toLowerCase(), usd, ts: f.ts };
    if (!item.coinName) continue;
    if (f.side === "sell") {
      const pre = prePriceOf(f);
      const drop = pre ? Math.abs(f.priceUsd / pre - 1) * 100 : 0;
      item.bomb = BOMB_TIERS[bombTierIndex(drop)].name;
      item.dropPct = Math.round(drop * 10) / 10;
    }
    out.push(item);
  }
  return out;
}

/* ── Full leaderboard (/leaderboard, round 2 "Top pilots" board) ─────────────────────────────────────────────────── */

/** The full board's windows: the lobby's three plus all time (the whole indexed history). */
export type BoardWindow = PilotWindow | "all";
export const BOARD_WINDOWS: readonly { k: BoardWindow; label: string; ms: number }[] = [...PILOT_WINDOWS, { k: "all", label: "All time", ms: Infinity }];
/** Rank by: cashed out (realized profit, like the lobby shelf), best % gain on one rocket, most boosted ($ in), longest aboard. */
export type BoardSort = "pnl" | "pctGain" | "volume" | "holdTime";
export const BOARD_SORTS: readonly BoardSort[] = ["pnl", "pctGain", "volume", "holdTime"];

export type BoardPilot = {
  wallet: string;
  username?: string | null;
  level?: number | null;
  prestige?: number | null;
  /** distinct rockets the pilot boosted or dumped in the window */
  flights: number;
  /** realized profit in the window, $ (same rule as topPilots) */
  pnlUsd: number;
  /** best realized % gain on one rocket in the window (profit ÷ cost of what was sold); null with no cash-out */
  bestPct: number | null;
  /** $ boosted (bought) in the window */
  boostedUsd: number;
  /** longest single stay aboard one rocket that overlaps the window, ms (still aboard counts up to `now`) */
  aboardMs: number;
};
export type PilotBoard = Record<BoardWindow, BoardPilot[]>;

/** Every pilot's numbers per window, from every coin's fills. Unsorted; rankBoard sorts. Pure. */
export function pilotBoard(fillsByCoin: Fill[][], now: number): PilotBoard {
  type Acc = { pnl: number; coins: Set<string>; coinPnl: Map<string, { pnl: number; basis: number }>; boosted: number; aboard: number };
  const acc = Object.fromEntries(BOARD_WINDOWS.map((w) => [w.k, new Map<string, Acc>()])) as Record<BoardWindow, Map<string, Acc>>;
  const get = (win: BoardWindow, w: string) => {
    const m = acc[win];
    let r = m.get(w);
    if (!r) { r = { pnl: 0, coins: new Set(), coinPnl: new Map(), boosted: 0, aboard: 0 }; m.set(w, r); }
    return r;
  };
  const inWin = (ts: number, ms: number) => now - ts >= 0 && now - ts <= ms;
  for (const fills of fillsByCoin) {
    const asc = [...fills].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    const books = new Map<string, Book & { since: number }>();
    const closeHold = (w: string, since: number, end: number) => {
      for (const win of BOARD_WINDOWS) {
        const from = Math.max(since, now - win.ms);
        if (end < from) continue;
        const r = get(win.k, w);
        r.aboard = Math.max(r.aboard, end - from);
      }
    };
    for (const f of asc) {
      const w = f.trader.toLowerCase(), coin = f.coin.toLowerCase();
      const b = books.get(w) ?? { size: 0, cost: 0, since: 0 };
      const usd = playerUsd(f);
      if (!(f.tokens > 0) || !(usd > 0)) continue;
      if (f.side === "buy") {
        if (!(b.size > 0)) b.since = f.ts;
        b.size += f.tokens; b.cost += usd; books.set(w, b);
        for (const win of BOARD_WINDOWS) if (inWin(f.ts, win.ms)) { const r = get(win.k, w); r.boosted += usd; r.coins.add(coin); }
        continue;
      }
      if (!(b.size > 0)) continue; // tokens bought before the indexed history: no known cost, not counted
      const sold = Math.min(f.tokens, b.size);
      const basis = b.cost * (sold / b.size);
      const pnl = usd * (sold / f.tokens) - basis;
      b.size -= sold; b.cost -= basis;
      if (b.size < 1e-9) { closeHold(w, b.since, f.ts); b.size = 0; b.cost = 0; }
      books.set(w, b);
      for (const win of BOARD_WINDOWS) {
        if (!inWin(f.ts, win.ms)) continue;
        const r = get(win.k, w);
        r.pnl += pnl; r.coins.add(coin);
        const c = r.coinPnl.get(coin) ?? { pnl: 0, basis: 0 };
        c.pnl += pnl; c.basis += basis; r.coinPnl.set(coin, c);
      }
    }
    for (const [w, b] of books) if (b.size > 0) closeHold(w, b.since, now);
  }
  const out = {} as PilotBoard;
  for (const win of BOARD_WINDOWS) {
    out[win.k] = [...acc[win.k].entries()].filter(([, r]) => r.coins.size > 0).map(([wallet, r]) => {
      let best: number | null = null;
      for (const c of r.coinPnl.values()) if (c.basis > 0) { const p = (c.pnl / c.basis) * 100; if (best == null || p > best) best = p; }
      return {
        wallet, flights: r.coins.size, pnlUsd: Math.round(r.pnl * 100) / 100, bestPct: best == null ? null : Math.round(best * 10) / 10,
        boostedUsd: Math.round(r.boosted * 100) / 100, aboardMs: Math.round(r.aboard),
      };
    });
  }
  return out;
}

const sortValue = (p: BoardPilot, s: BoardSort) => (s === "pnl" ? p.pnlUsd : s === "pctGain" ? p.bestPct ?? -Infinity : s === "volume" ? p.boostedUsd : p.aboardMs);

/** One window ranked by `sort`. Cashed out and Best gain list only pilots who cashed out higher (like the lobby shelf). */
export function rankBoard(rows: BoardPilot[], sort: BoardSort): BoardPilot[] {
  const keep = rows.filter((p) => (sort === "pnl" ? p.pnlUsd >= 0.01 : sort === "pctGain" ? p.bestPct != null && p.bestPct > 0 && p.pnlUsd >= 0.01 : sortValue(p, sort) > 0));
  return keep.sort((a, b) => sortValue(b, sort) - sortValue(a, sort) || b.pnlUsd - a.pnlUsd || a.wallet.localeCompare(b.wallet));
}

/** How far `me` is behind the pilot one place up, in the sort's own unit (0 when tied or first). */
export function gapToNext(ranked: BoardPilot[], i: number, sort: BoardSort): number {
  if (i <= 0 || i >= ranked.length) return 0;
  return Math.max(0, sortValue(ranked[i - 1], sort) - sortValue(ranked[i], sort));
}
