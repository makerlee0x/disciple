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

/**
 * Board guardrails (maker 2026-11-13, main mode hook loop): the board keeps PnL and % gain, but only for good calls.
 *  - a pilot's buys and sells on a rocket they launched never count (no "launched and dumped" winners)
 *  - a sell counts only after `minAboardMs` aboard (the position's first buy), so same-block snipes and flips don't top it
 *  - Best % needs at least `minPctBasisUsd` put in on that rocket, so a $1 ticket that went 80x can't win
 *  - every row carries its record (green / red flights, losses), and the board's Best call names the climb
 */
export const BOARD_RULES = { minAboardMs: 2 * 60_000, minPctBasisUsd: 20 } as const;
/** Rocket facts the guardrails need: who launched it, and whether it reached orbit. */
export type BoardOpts = { creators?: ReadonlyMap<string, string>; graduated?: ReadonlySet<string>; orbitMcap?: number };

/** One counted cash-out: a sell that passed the guardrails, with the position it closed part of. */
type Close = { wallet: string; coin: string; ts: number; pnl: number; basis: number; since: number; openMcap: number; mcap: number };

/** Walk every coin's fills once: counted closes, per-wallet buys, stays aboard and orbits aboard. Pure. */
function walk(fillsByCoin: Fill[][], now: number, o: BoardOpts = {}) {
  const closes: Close[] = [];
  const buys: { wallet: string; coin: string; ts: number; usd: number }[] = [];
  const stays: { wallet: string; coin: string; since: number; end: number }[] = [];
  const orbits: { wallet: string; coin: string; ts: number }[] = [];
  const orbitAt = o.orbitMcap ?? 33_333;
  for (const fills of fillsByCoin) {
    if (!fills.length) continue;
    const asc = [...fills].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    const coin = asc[0].coin.toLowerCase();
    const creator = o.creators?.get(coin)?.toLowerCase();
    const books = new Map<string, Book & { since: number; openMcap: number }>();
    let orbitDone = !o.graduated?.has(coin);
    for (const f of asc) {
      const w = f.trader.toLowerCase();
      const usd = playerUsd(f);
      if (!(f.tokens > 0) || !(usd > 0)) continue;
      const b = books.get(w) ?? { size: 0, cost: 0, since: 0, openMcap: 0 };
      if (f.side === "buy") {
        if (!(b.size > 0)) { b.since = f.ts; b.openMcap = f.mcapUsd; }
        b.size += f.tokens; b.cost += usd; books.set(w, b);
        if (w !== creator) buys.push({ wallet: w, coin, ts: f.ts, usd });
      } else if (b.size > 0) { // tokens bought before the indexed history: no known cost, not counted
        const sold = Math.min(f.tokens, b.size);
        const basis = b.cost * (sold / b.size);
        const pnl = usd * (sold / f.tokens) - basis;
        if (w !== creator && f.ts - b.since >= BOARD_RULES.minAboardMs) closes.push({ wallet: w, coin, ts: f.ts, pnl, basis, since: b.since, openMcap: b.openMcap, mcap: f.mcapUsd });
        b.size -= sold; b.cost -= basis;
        if (b.size < 1e-9) { if (w !== creator) stays.push({ wallet: w, coin, since: b.since, end: f.ts }); b.size = 0; b.cost = 0; }
        books.set(w, b);
      }
      // the first fill at or past the orbit line on a graduated rocket: everyone aboard after it was aboard for orbit
      if (!orbitDone && f.mcapUsd >= orbitAt) {
        orbitDone = true;
        for (const [pw, pb] of books) if (pb.size > 0 && pw !== creator) orbits.push({ wallet: pw, coin, ts: f.ts });
      }
    }
    for (const [w, b] of books) if (b.size > 0 && w !== creator) stays.push({ wallet: w, coin, since: b.since, end: now });
  }
  return { closes, buys, stays, orbits };
}

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
  /** of those, rockets cashed out of with a profit */
  green: number;
  /** realized profit in the window, $ */
  pnlUsd: number;
};
export type TopPilots = Record<PilotWindow, TopPilot[]>;

export const EMPTY_PILOTS: TopPilots = { day: [], week: [], month: [] };

type Book = { size: number; cost: number };

/** Realized profit per (window, wallet) from every coin's fills, under BOARD_RULES. `fillsByCoin`: any order per coin. */
export function topPilots(fillsByCoin: Fill[][], now: number, n = 5, o: BoardOpts = {}): TopPilots {
  const { closes } = walk(fillsByCoin, now, o);
  const out = { ...EMPTY_PILOTS } as TopPilots;
  for (const win of PILOT_WINDOWS) {
    const m = new Map<string, { pnl: number; coin: Map<string, number> }>();
    for (const c of closes) {
      const age = now - c.ts;
      if (age < 0 || age > win.ms) continue;
      const r = m.get(c.wallet) ?? { pnl: 0, coin: new Map() };
      r.pnl += c.pnl; r.coin.set(c.coin, (r.coin.get(c.coin) ?? 0) + c.pnl);
      m.set(c.wallet, r);
    }
    out[win.k] = [...m.entries()]
      .filter(([, r]) => r.pnl >= 0.01)
      .sort((x, y) => y[1].pnl - x[1].pnl)
      .slice(0, n)
      .map(([wallet, r]) => ({ wallet, flights: r.coin.size, green: [...r.coin.values()].filter((v) => v > 0).length, pnlUsd: Math.round(r.pnl * 100) / 100 }));
  }
  return out;
}

/** The window's Best call: the biggest % climb from boarding to a counted cash-out on one rocket ($20+ put in). */
export type BestCall = {
  wallet: string; username?: string | null; level?: number | null; prestige?: number | null;
  coin: string; coinName?: string;
  /** realized % on that rocket in the window (profit ÷ cost of what was sold) */
  pct: number;
  /** $ cost of what was sold */
  basisUsd: number;
  /** mcap when the pilot boarded, and at their last counted cash-out */
  boardedMcap: number; cashedMcap: number;
  /** boarding → last counted cash-out, ms */
  aboardMs: number;
};
export type BestCalls = Record<PilotWindow, BestCall | null>;
export const EMPTY_BEST_CALLS: BestCalls = { day: null, week: null, month: null };

export function bestCalls(fillsByCoin: Fill[][], now: number, o: BoardOpts = {}): BestCalls {
  const { closes } = walk(fillsByCoin, now, o);
  const out = { ...EMPTY_BEST_CALLS };
  for (const win of PILOT_WINDOWS) {
    const m = new Map<string, { pnl: number; basis: number; since: number; openMcap: number; last: Close }>();
    for (const c of closes) {
      const age = now - c.ts;
      if (age < 0 || age > win.ms) continue;
      const k = `${c.wallet}|${c.coin}`;
      const r = m.get(k);
      if (!r) m.set(k, { pnl: c.pnl, basis: c.basis, since: c.since, openMcap: c.openMcap, last: c });
      else { r.pnl += c.pnl; r.basis += c.basis; if (c.ts >= r.last.ts) r.last = c; if (c.since < r.since) { r.since = c.since; r.openMcap = c.openMcap; } }
    }
    let best: BestCall | null = null;
    for (const r of m.values()) {
      if (!(r.basis >= BOARD_RULES.minPctBasisUsd) || !(r.pnl > 0)) continue;
      const pct = (r.pnl / r.basis) * 100;
      if (!best || pct > best.pct) best = { wallet: r.last.wallet, coin: r.last.coin, pct: Math.round(pct * 10) / 10, basisUsd: Math.round(r.basis * 100) / 100, boardedMcap: r.openMcap, cashedMcap: r.last.mcap, aboardMs: r.last.ts - r.since };
    }
    out[win.k] = best;
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
/** Rank by: banked (realized profit, like the lobby shelf), best % gain on one rocket ($20+ in), orbits aboard. */
export type BoardSort = "pnl" | "pctGain" | "orbits";
export const BOARD_SORTS: readonly BoardSort[] = ["pnl", "pctGain", "orbits"];

export type BoardPilot = {
  wallet: string;
  username?: string | null;
  level?: number | null;
  prestige?: number | null;
  /** crew tag, when the pilot is in one (server fills it) */
  crew?: string | null;
  /** distinct rockets the pilot boosted or cashed out of in the window */
  flights: number;
  /** rockets cashed out of in the window with a profit / a loss (counted sells only) */
  green: number;
  red: number;
  /** realized profit in the window, $ (losses net out; same rule as topPilots) */
  pnlUsd: number;
  /** realized losses in the window, $ (a positive number) */
  lostUsd: number;
  /** best realized % gain on one rocket in the window with $20+ put in; null with none */
  bestPct: number | null;
  /** $ boosted (bought) in the window */
  boostedUsd: number;
  /** longest single stay aboard one rocket that overlaps the window, ms (still aboard counts up to `now`) */
  aboardMs: number;
  /** rockets that reached orbit with this pilot aboard, in the window */
  orbits: number;
};
export type PilotBoard = Record<BoardWindow, BoardPilot[]>;

/** Every pilot's numbers per window, from every coin's fills, under BOARD_RULES. Unsorted; rankBoard sorts. Pure. */
export function pilotBoard(fillsByCoin: Fill[][], now: number, o: BoardOpts = {}): PilotBoard {
  const { closes, buys, stays, orbits } = walk(fillsByCoin, now, o);
  type Acc = { coins: Set<string>; coinPnl: Map<string, { pnl: number; basis: number }>; boosted: number; aboard: number; orbits: number };
  const out = {} as PilotBoard;
  for (const win of BOARD_WINDOWS) {
    const m = new Map<string, Acc>();
    const get = (w: string) => { let r = m.get(w); if (!r) { r = { coins: new Set(), coinPnl: new Map(), boosted: 0, aboard: 0, orbits: 0 }; m.set(w, r); } return r; };
    const inWin = (ts: number) => now - ts >= 0 && now - ts <= win.ms;
    for (const x of buys) if (inWin(x.ts)) { const r = get(x.wallet); r.boosted += x.usd; r.coins.add(x.coin); }
    for (const c of closes) if (inWin(c.ts)) {
      const r = get(c.wallet); r.coins.add(c.coin);
      const k = r.coinPnl.get(c.coin) ?? { pnl: 0, basis: 0 };
      k.pnl += c.pnl; k.basis += c.basis; r.coinPnl.set(c.coin, k);
    }
    for (const st of stays) {
      const from = Math.max(st.since, now - win.ms);
      if (st.end < from) continue;
      const r = get(st.wallet); r.aboard = Math.max(r.aboard, st.end - from);
    }
    for (const x of orbits) if (inWin(x.ts)) get(x.wallet).orbits++;
    out[win.k] = [...m.entries()].filter(([, r]) => r.coins.size > 0 || r.orbits > 0).map(([wallet, r]) => {
      let best: number | null = null, pnl = 0, lost = 0, green = 0, red = 0;
      for (const c of r.coinPnl.values()) {
        pnl += c.pnl;
        if (c.pnl > 0.005) green++; else if (c.pnl < -0.005) { red++; lost -= c.pnl; }
        if (c.basis >= BOARD_RULES.minPctBasisUsd) { const p = (c.pnl / c.basis) * 100; if (best == null || p > best) best = p; }
      }
      return {
        wallet, flights: r.coins.size, green, red, pnlUsd: Math.round(pnl * 100) / 100, lostUsd: Math.round(lost * 100) / 100,
        bestPct: best == null ? null : Math.round(best * 10) / 10, boostedUsd: Math.round(r.boosted * 100) / 100, aboardMs: Math.round(r.aboard), orbits: r.orbits,
      };
    });
  }
  return out;
}

const sortValue = (p: BoardPilot, s: BoardSort) => (s === "pnl" ? p.pnlUsd : s === "pctGain" ? p.bestPct ?? -Infinity : p.orbits);

/** One window ranked by `sort`. Banked and Best % list only pilots who cashed out higher (like the lobby shelf). */
export function rankBoard(rows: BoardPilot[], sort: BoardSort): BoardPilot[] {
  const keep = rows.filter((p) => (sort === "pnl" ? p.pnlUsd >= 0.01 : sort === "pctGain" ? p.bestPct != null && p.bestPct > 0 && p.pnlUsd >= 0.01 : p.orbits > 0));
  return keep.sort((a, b) => sortValue(b, sort) - sortValue(a, sort) || b.pnlUsd - a.pnlUsd || a.wallet.localeCompare(b.wallet));
}

/** How far `me` is behind the pilot one place up, in the sort's own unit (0 when tied or first). */
export function gapToNext(ranked: BoardPilot[], i: number, sort: BoardSort): number {
  if (i <= 0 || i >= ranked.length) return 0;
  return Math.max(0, sortValue(ranked[i - 1], sort) - sortValue(ranked[i], sort));
}

/* ── Crews tab (maker 2026-11-13): crews ranked by orbits aboard, then green rockets, then banked ─────────────────── */

export type CrewRow = { id: string; tag: string; mark: string; pilots: number; orbits: number; green: number; flights: number; pnlUsd: number };

/** Sum one window's pilots by crew. `tags`: wallet → crew tag (null / missing = no crew). Pure. */
export function crewBoard(rows: readonly BoardPilot[], tags: Readonly<Record<string, { id: string; tag: string; mark: string } | null | undefined>>): CrewRow[] {
  const m = new Map<string, CrewRow>();
  for (const p of rows) {
    const t = tags[p.wallet];
    if (!t) continue;
    const r = m.get(t.id) ?? { id: t.id, tag: t.tag, mark: t.mark, pilots: 0, orbits: 0, green: 0, flights: 0, pnlUsd: 0 };
    r.pilots++; r.orbits += p.orbits; r.green += p.green; r.flights += p.flights; r.pnlUsd = Math.round((r.pnlUsd + p.pnlUsd) * 100) / 100;
    m.set(t.id, r);
  }
  return [...m.values()].filter((r) => r.flights > 0 || r.orbits > 0).sort((a, b) => b.orbits - a.orbits || b.green - a.green || b.pnlUsd - a.pnlUsd || a.tag.localeCompare(b.tag));
}
