/**
 * Live Activity numbers (lock screen + Dynamic Island, maker 2026-11-14 option 5), shared by the page (components/native/LiveFlight,
 * while the app is open) and the server (lib/server/liveActivity, pushes while it is closed), so both show the same thing.
 * `share` = the part of the supply the bag holds (bag value / market cap when it was registered): value now = share × mcap now.
 */
import { FLIGHT_TIERS, tierIndexAt } from "./flight/tiers";

export type LiveFlightNumbers = { mcap: number; valueUsd: number; pnlUsd: number; pnlPct: number; zone: string; nextZone: string; zoneProgress: number; closed: boolean };

/** Pure (scripts/test-live-flight.mts). */
export function liveFlightNumbers(o: { mcap: number; valueUsd?: number; share?: number; investedUsd: number; closed?: boolean }): LiveFlightNumbers {
  const mcap = Number.isFinite(o.mcap) && o.mcap > 0 ? o.mcap : 0;
  const valueUsd = typeof o.valueUsd === "number" && Number.isFinite(o.valueUsd) ? Math.max(0, o.valueUsd) : Math.max(0, (o.share ?? 0) * mcap);
  const invested = o.investedUsd > 0 ? o.investedUsd : 0;
  const pnlUsd = valueUsd - invested, pnlPct = invested > 0 ? (pnlUsd / invested) * 100 : 0;
  const i = tierIndexAt(mcap), t = FLIGHT_TIERS[i], nx = FLIGHT_TIERS[i + 1];
  const zoneProgress = nx ? Math.max(0, Math.min(1, (mcap - t.lo) / Math.max(1, nx.lo - t.lo))) : 1;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return { mcap: Math.round(mcap), valueUsd: r2(valueUsd), pnlUsd: r2(pnlUsd), pnlPct: Math.round(pnlPct * 10) / 10, zone: t.name, nextZone: nx ? nx.name : "ORBIT", zoneProgress: Math.round(zoneProgress * 1000) / 1000, closed: !!o.closed };
}
