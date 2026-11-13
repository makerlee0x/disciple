/**
 * `next dev` + ?sample=1 only (lib/devSample): the main mode hook loop mockup's sample pilots, rockets and crew, so
 * the logbook, story, crew, host, streak and lobby-note screens can be laid out and screenshotted without a chain.
 * Never imported in production code paths without the inline NODE_ENV guard.
 */
import type { LogEntry, LogRecord, StoryEvent } from "@/lib/logbook";

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
