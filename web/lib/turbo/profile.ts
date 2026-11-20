/**
 * The Turbo page's numbers (maker 2026-11-20: "a full public trading dashboard for turbo players"), shared by the server
 * (lib/server/turboProfile) and the view (components/turbo/page/TurboView). A null number shows "—", never a made-up 0.
 */
export type TurboResult = "win" | "loss" | "draw";

/** one finished online duel, from this pilot's seat (lib/server/duel/store duelHistory) */
export type TurboMatch = {
  id: string;
  at: number;
  mode: "ranked" | "casual" | "friend";
  /** NORMIE / DEGEN / WHALE, or "$<n>" for a friend duel with a custom budget */
  tier: string;
  lenMs: number;
  result: TurboResult;
  /** $ profit on the duel's budget, this pilot and the other one */
  me: number;
  them: number;
  /** rating change (0 unless ranked) */
  delta: number;
  /** this seat traded real money on Turbo (armed on Lighter); false = Simulator */
  real: boolean;
  opp: { wallet: string; name: string; pfp: string };
};

/** one Lighter fill */
export type TurboFill = { at: number; market: string; side: "buy" | "sell"; size: number; price: number; usd: number; fee: number | null; pnl: number | null; liq: boolean };

export type TurboPnl = { d1: number; d7: number; d30: number; all: number };

export type TurboProfile = {
  wallet: string;
  /** duel ladder: record, streak, rank on the Duels board, this season's league */
  duel: { w: number; l: number; games: number; streak: number; rank: number | null; league: string | null; sp: number | null } | null;
  climb: { level: number; rank: number | null } | null;
  /** realized PnL from real Turbo fills, net of fees. null = no Turbo account yet */
  pnl: TurboPnl | null;
  /** fills counted, $ traded, share of closing fills in profit, fees paid */
  trading: { fills: number; volume: number; winRate: number | null; fees: number } | null;
  matches: TurboMatch[];
  fills: TurboFill[];
  /** true when Lighter didn't answer (the fills and PnL are missing, not zero) */
  fillsMissing: boolean;
};

export const PNL_PERIODS = [
  { k: "d1", label: "24H" },
  { k: "d7", label: "7D" },
  { k: "d30", label: "30D" },
  { k: "all", label: "All time" },
] as const;

/** sum of realized PnL (net of fees) for fills at or after `since` */
export function pnlSince(fills: readonly TurboFill[], since: number): number {
  let t = 0;
  for (const f of fills) if (f.at >= since) t += (f.pnl ?? 0) - (f.fee ?? 0);
  return Math.round(t * 100) / 100;
}

export function pnlOf(fills: readonly TurboFill[], now = Date.now()): TurboPnl {
  const D = 86_400_000;
  return { d1: pnlSince(fills, now - D), d7: pnlSince(fills, now - 7 * D), d30: pnlSince(fills, now - 30 * D), all: pnlSince(fills, 0) };
}

export function tradingOf(fills: readonly TurboFill[]): TurboProfile["trading"] {
  if (!fills.length) return null;
  const closes = fills.filter((f) => f.pnl != null && f.pnl !== 0);
  return {
    fills: fills.length,
    volume: Math.round(fills.reduce((a, f) => a + f.usd, 0) * 100) / 100,
    winRate: closes.length ? closes.filter((f) => (f.pnl ?? 0) > 0).length / closes.length : null,
    fees: Math.round(fills.reduce((a, f) => a + (f.fee ?? 0), 0) * 10000) / 10000,
  };
}
