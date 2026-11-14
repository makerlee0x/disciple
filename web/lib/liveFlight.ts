/**
 * The Live Activity's content (iPhone lock screen / Dynamic Island, maker 2026-11-14). Keys = FlightActivityAttributes.ContentState
 * (mobile/ios/App/App/FlightActivityAttributes.swift). Built on the phone from the flight's own numbers (components/flight/LiveFlight)
 * and on the server from the indexed fills (lib/server/liveActivity). Pure, tested in scripts/test-native.mts.
 */
import { FLIGHT_TIERS, tierIndexAt } from "./flight/tiers";
import { TOTAL_SUPPLY_TOKENS } from "./trades";
import type { PositionPnl } from "./sharePnl";

export type LiveState = { mcap: string; zone: string; bagUsd: number; pnlUsd: number; pnlPct: number; closed: boolean };

export const liveMcap = (v: number) => (!(v > 0) ? "$0" : v >= 1e9 ? `$${+(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${+(v / 1e3).toFixed(1)}K` : `$${Math.round(v)}`);
const r2 = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 100) / 100;

/** from the flight HUD's numbers */
export function liveStateOf(o: { mcap: number; bagUsd: number; pnlUsd: number; pnlPct: number; closed: boolean }): LiveState {
  const m = o.mcap > 0 ? o.mcap : 0;
  return { mcap: liveMcap(m), zone: FLIGHT_TIERS[tierIndexAt(m)]?.name ?? "", bagUsd: r2(o.bagUsd), pnlUsd: r2(o.pnlUsd), pnlPct: Math.round((Number.isFinite(o.pnlPct) ? o.pnlPct : 0) * 10) / 10, closed: o.closed };
}

/** from a server-side position (lib/sharePnl) */
export function liveState(p: Pick<PositionPnl, "kind" | "holding" | "mcapEndUsd" | "gainUsd" | "gainPct">): LiveState {
  const mcap = p.mcapEndUsd || 0;
  return liveStateOf({ mcap, bagUsd: p.holding * (mcap / TOTAL_SUPPLY_TOKENS), pnlUsd: p.gainUsd, pnlPct: p.gainPct, closed: p.kind !== "unrealized" });
}
