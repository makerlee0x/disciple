/**
 * `next dev` + ?sample=1 only (lib/devSample): the main mode hook loop mockup's sample pilots, rockets and crew, so
 * the logbook, story, crew, host, streak and lobby-note screens can be laid out and screenshotted without a chain.
 * Never imported in production code paths without the inline NODE_ENV guard.
 */
import type { LogEntry, LogRecord, StoryEvent } from "@/lib/logbook";
import { dayIndex, type Streak } from "@/lib/streaks";
import type { CrewPage } from "@/lib/crew";
import type { HostView } from "@/lib/host";

const H = 3600_000, D = 24 * H;
const now = () => Date.now();

const base = (o: Partial<LogEntry> & Pick<LogEntry, "coin" | "name" | "ticker" | "status">): LogEntry => ({
  creator: "0x000000000000000000000000000000000000c0de", graduated: false, mode: 1,
  boardedAt: now() - 3 * D, boardedMcap: 5_000, boardedZone: "LAUNCH PAD", pilotNo: 6, firstCrew: true,
  peakWithYou: 40_000, peakZone: "OUTER SPACE", bombsHeld: 0, aboardMs: 3 * D + 4 * H, leftAt: null, bankedUsd: 0,
  paperUsd: null, paperPct: null, orbitAboard: false, crewAboard: 0, news: null, lastAt: now() - H, nowMcap: 40_000, nowZone: "OUTER SPACE",
  zonesClimbed: 0, pilots: 40, ...o,
});

export function sampleLogbook(): { entries: LogEntry[]; record: LogRecord; total: number; crew: { tag: string; name: string } | null; own: boolean } {
  const t = now();
  const entries: LogEntry[] = [
    base({ coin: "0x00000000000000000000000000000000000a1a10", name: "Halo Drive", ticker: "HALO", status: "aboard", graduated: true, orbitAboard: true, news: { kind: "orbit_aboard", at: t - 2 * H }, boardedZone: "LAUNCH PAD", peakZone: "OUTER SPACE", aboardMs: 3 * D + 4 * H, paperUsd: 312, paperPct: 212, zonesClimbed: 5, nowZone: "IN ORBIT", pilots: 58 }),
    base({ coin: "0x00000000000000000000000000000000000a6a10", name: "Glowworm", ticker: "GLOW", status: "green", boardedZone: "OZONE", boardedMcap: 13_000, peakZone: "STRATOSPHERE", bombsHeld: 2, news: { kind: "zone_after", at: t - D, zone: "KÁRMÁN LINE" }, aboardMs: 5 * H, leftAt: t - 2 * D, bankedUsd: 48 }),
    base({ coin: "0x00000000000000000000000000000000000a7a10", name: "Moth Light", ticker: "MOTH", status: "aboard", boardedZone: "LAUNCH PAD", pilotNo: 4, peakZone: "STRATOSPHERE", crewAboard: 3, news: { kind: "crew_aboard", at: t, crew: 3 }, aboardMs: 11 * H, paperUsd: 64, paperPct: 28 }),
    base({ coin: "0x00000000000000000000000000000000000a8a10", name: "Rust Belt", ticker: "RUST", status: "red", boardedZone: "STRATOSPHERE", boardedMcap: 19_000, peakZone: "STRATOSPHERE", firstCrew: false, pilotNo: 31, aboardMs: 40 * 60_000, leftAt: t - 3 * D, bankedUsd: -22, nowZone: "LAUNCH PAD", lastAt: t - 3 * D }),
  ];
  return { entries, record: { rockets: 23, orbits: 2, firstCrews: 7, bombsHeld: 9, green: 13, red: 10, aboard: 4, news: 3 }, total: 23, crew: { tag: "NOVA", name: "Nova Squadron" }, own: true };
}

export function sampleStory(): { entry: LogEntry; story: StoryEvent[]; index: number; total: number; host: string | null; hostName: string; own: boolean } {
  const e = sampleLogbook().entries[0];
  const t0 = e.boardedAt;
  return {
    entry: e, index: 14, total: 23, host: e.creator, hostName: "lumen", own: true,
    story: [
      { kind: "boarded", at: t0, zone: "LAUNCH PAD", pilotNo: 6, firstCrew: true },
      { kind: "crew_joined", at: t0 + 20 * 60_000, crew: 3 },
      { kind: "bomb_held", at: t0 + 9 * H, impactPct: 7 },
      { kind: "zone", at: t0 + 33 * H, zone: "KÁRMÁN LINE", passengers: 41 },
      { kind: "orbit", at: t0 + 3 * D - 2 * H, aboard: true, pilotsAboard: 58 },
    ],
  };
}

export function sampleStreaks(): { aboard: Streak; checkin: Streak; paid: number } {
  const t = dayIndex(now());
  const week = (states: Streak["week"][number]["state"][]) => states.map((state, i) => ({ day: t - 6 + i, state }));
  return {
    aboard: { current: 6, best: 14, week: week(["done", "done", "paused", "done", "done", "done", "today"]), shieldUsed: true, pausedDay: t - 4, todayOk: true, run: [] },
    checkin: { current: 11, best: 11, week: week(["done", "done", "done", "done", "done", "done", "done"]), shieldUsed: false, pausedDay: null, todayOk: true, run: [] },
    paid: 0,
  };
}

export function sampleCrew(): CrewPage {
  const w = (n: number) => `0x${String(n).padStart(40, "0")}`;
  return {
    crew: { id: "u-000000000001", tag: "NOVA", name: "Nova Squadron", mark: "", members: 9, since: Date.UTC(2026, 9, 28) },
    record: { together: 31, orbits: 3, longestMs: 2 * D + 9 * H, rank: 12 },
    flying: [
      { coin: "0x00000000000000000000000000000000000a7a10", ticker: "MOTH", name: "Moth Light", zone: "STRATOSPHERE", mode: 1, graduated: false, count: 3, you: true,
        aboard: [{ wallet: w(2), name: "jo" }, { wallet: w(3), name: "ra" }, { wallet: w(4), name: "ev" }] },
      { coin: "0x00000000000000000000000000000000000a1a10", ticker: "HALO", name: "Halo Drive", zone: "In orbit", mode: 1, graduated: true, count: 2, you: false,
        aboard: [{ wallet: w(4), name: "ev" }, { wallet: w(5), name: "li" }] },
    ],
    mission: { best: 2, target: 3, xp: 400, done: false, resetsAt: now() + 2 * D },
    username: "mk",
  };
}

export function sampleHost(): HostView {
  const t = now(), t0 = t - 2 * D - 20 * H;
  const curve = [0, 8, 16, 21, 19, 24, 31, 29, 37, 43, 49, 52];
  const series = curve.map((n, i) => ({ at: t0 + ((t - t0) * i) / (curve.length - 1), n }));
  const at = (i: number) => series[i].at;
  return {
    coin: "0x00000000000000000000000000000000000b1b10", name: "Lumen Trail", ticker: "LUMA", creator: "0x000000000000000000000000000000000000c0de", hostName: "lumen", mode: 2, graduated: false,
    launchedAt: t0, zone: "KÁRMÁN LINE", toOrbitUsd: 8_100, passengers: 52, crews: 4, top10Pct: 31, series, peak: 52, day: 3,
    milestones: [
      { key: "p10", kind: "passengers", label: "First 10 passengers", at: at(2) },
      { key: "crew", kind: "crew", label: "First crew aboard", at: at(2) },
      { key: "z:OZONE", kind: "zone", label: "Ozone", at: at(3) },
      { key: "z:STRATOSPHERE", kind: "zone", label: "Stratosphere", at: at(5) },
      { key: "z:KÁRMÁN LINE", kind: "zone", label: "Kármán Line", at: at(8) },
      { key: "p25", kind: "passengers", label: "25 passengers", at: at(6) },
      { key: "p50", kind: "passengers", label: "50 passengers", at: at(10) },
      { key: "p100", kind: "passengers", label: "100 passengers", at: null },
      { key: "orbit", kind: "orbit", label: "Orbit", at: null },
    ],
    rockets: { launched: 4, orbits: 1, mostPassengers: 88 },
  };
}
