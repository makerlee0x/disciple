/**
 * Host mission control (main mode hook loop, maker 2026-11-13, mockup board "Host mission control"). Pure, fills-only.
 * Counts people and zones, never price targets. The host's own wallet is never a passenger.
 * "First crew aboard" = two pilots from the same crew holding at once (crew tags come from lib/server).
 */
import { TIERS } from "./config";
import { ORBIT_MCAP, type LogFill } from "./logbook";

const DUST = 1e-9;
export const HOST_SERIES_POINTS = 48;
export const PASSENGER_MARKS = [10, 25, 50, 100, 250, 500, 1000] as const;
/** the zones a host can reach before orbit, each a milestone */
const ZONE_MILESTONES = TIERS.filter((t) => t.lo > TIERS[0].lo && t.lo < ORBIT_MCAP);

export type MilestoneKind = "passengers" | "crew" | "zone" | "orbit";
export interface Milestone { key: string; kind: MilestoneKind; label: string; at: number | null }
export interface HostStats {
  passengers: number;
  /** traders (host excluded) holding now */
  holders: string[];
  peak: number;
  series: { at: number; n: number }[];
  milestones: Milestone[];
  launchedAt: number;
  lastMcap: number;
  day: number;
}

const order = (a: LogFill, b: LogFill) => a.block - b.block || a.logIndex - b.logIndex || a.ts - b.ts;

/** One rocket from its fills (any order). tags: trader → crew id, for "first crew aboard". */
export function hostStats(fillsIn: readonly LogFill[], creator: string, o: { now: number; graduated: boolean; launchedAt?: number | null; tags?: Record<string, string | null> }): HostStats {
  const fills = [...fillsIn].sort(order), host = creator.toLowerCase();
  const held = new Map<string, number>();
  let n = 0, peak = 0, lastMcap = 0, crewAt: number | null = null, orbitAt: number | null = null;
  const passAt = new Map<number, number>(), zoneAt = new Map<string, number>();
  const counts: { at: number; n: number }[] = [];
  const crewHeld = new Map<string, number>();
  for (const f of fills) {
    const t = f.trader.toLowerCase();
    const mcap = typeof f.mcapUsd === "number" && f.mcapUsd > 0 ? f.mcapUsd : lastMcap;
    lastMcap = mcap;
    if (t !== host) {
      const before = held.get(t) ?? 0, after = f.side === "buy" ? before + f.tokens : Math.max(0, before - f.tokens);
      held.set(t, after);
      const was = before > DUST, is = after > DUST;
      if (was !== is) {
        n += is ? 1 : -1;
        const crew = o.tags?.[t];
        if (crew) {
          const c = (crewHeld.get(crew) ?? 0) + (is ? 1 : -1);
          crewHeld.set(crew, c);
          if (crewAt === null && c >= 2) crewAt = f.ts;
        }
      }
    }
    peak = Math.max(peak, n);
    for (const m of PASSENGER_MARKS) if (n >= m && !passAt.has(m)) passAt.set(m, f.ts);
    for (const z of ZONE_MILESTONES) if (mcap >= z.lo && !zoneAt.has(z.name)) zoneAt.set(z.name, f.ts);
    if (orbitAt === null && o.graduated && mcap >= ORBIT_MCAP) orbitAt = f.ts;
    counts.push({ at: f.ts, n });
  }
  const launchedAt = o.launchedAt ?? fills[0]?.ts ?? o.now;
  const series: { at: number; n: number }[] = [];
  const span = Math.max(1, o.now - launchedAt);
  for (let i = 0, j = 0, cur = 0; i <= HOST_SERIES_POINTS; i++) {
    const at = launchedAt + (span * i) / HOST_SERIES_POINTS;
    while (j < counts.length && counts[j].at <= at) cur = counts[j++].n;
    series.push({ at, n: cur });
  }
  // milestones: the first two passenger marks past what's reached stay as goals; reached ones carry their time
  const reachedMax = PASSENGER_MARKS.filter((m) => passAt.has(m)).length;
  const marks = PASSENGER_MARKS.slice(0, Math.max(3, reachedMax + 1));
  const milestones: Milestone[] = [
    { key: "p10", kind: "passengers", label: "First 10 passengers", at: passAt.get(10) ?? null },
    { key: "crew", kind: "crew", label: "First crew aboard", at: crewAt },
    ...ZONE_MILESTONES.map((z): Milestone => ({ key: `z:${z.name}`, kind: "zone", label: titled(z.name), at: zoneAt.get(z.name) ?? null })),
    ...marks.filter((m) => m !== 10).map((m): Milestone => ({ key: `p${m}`, kind: "passengers", label: `${m} passengers`, at: passAt.get(m) ?? null })),
    { key: "orbit", kind: "orbit", label: "Orbit", at: orbitAt },
  ];
  const holders = [...held.entries()].filter(([, v]) => v > DUST).map(([k]) => k);
  return { passengers: n, holders, peak, series, milestones, launchedAt, lastMcap, day: Math.floor((o.now - launchedAt) / 86_400_000) + 1 };
}

const titled = (z: string) => z.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

/** Share copy for the host log card: people and zones only. */
export function hostLogLine(h: { passengers: number; crews: number; zone: string; day: number }) {
  return `${h.crews} ${h.crews === 1 ? "crew" : "crews"} aboard · in the ${titled(h.zone)} · day ${h.day}`;
}

/** the passenger mark to headline (the highest reached, else the current count) */
export function headlineMark(passengers: number) {
  const hit = PASSENGER_MARKS.filter((m) => passengers >= m);
  return hit.length ? hit[hit.length - 1] : passengers;
}

/** GET /api/host body (lib/server/host) */
export type HostView = {
  coin: string; name: string; ticker: string; creator: string; hostName: string | null; mode?: number; graduated: boolean;
  launchedAt: number; zone: string; toOrbitUsd: number | null;
  passengers: number; crews: number; top10Pct: number | null;
  series: HostStats["series"]; milestones: HostStats["milestones"]; peak: number; day: number;
  rockets: { launched: number; orbits: number; mostPassengers: number } | null;
};
