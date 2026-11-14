/**
 * Push alerts (main mode hook loop, maker 2026-11-13, mockup board "Notifications"). Pure, shared by client and server.
 * At most 3 a day, all off by default except orbit, one switch per kind in Settings. Each push names something that
 * already happened (people and zones). What we never send: price alerts that say buy or sell now, "your crew is buying"
 * or entry prices, "win it back" after a red flight, streak warnings that push a trade.
 */
export type PushKind = "orbit" | "host" | "crew";
export const PUSH_DAILY_CAP = 3;
export const PUSH_KINDS: readonly { k: PushKind; label: string; help: string; on: boolean }[] = [
  { k: "orbit", label: "Orbit with you aboard", help: "A rocket you're aboard reaches orbit.", on: true },
  { k: "host", label: "Your launch milestones", help: "Passenger milestones on rockets you launched.", on: false },
  { k: "crew", label: "Crew zones", help: "Your crew's rocket climbs past the Kármán Line.", on: false },
];
export type PushPrefs = Record<PushKind, boolean>;
export const DEFAULT_PUSH_PREFS: PushPrefs = Object.fromEntries(PUSH_KINDS.map((x) => [x.k, x.on])) as PushPrefs;
export function readPrefs(v: unknown): PushPrefs {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return Object.fromEntries(PUSH_KINDS.map((x) => [x.k, typeof o[x.k] === "boolean" ? o[x.k] : x.on])) as PushPrefs;
}

export interface PushMsg { id: string; kind: PushKind; title: string; body: string; url: string; ts: number }

const title = (z: string) => z.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const nth = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

export const pushCopy = {
  orbit: (ticker: string, boardedZone: string) => ({ title: `$${ticker} reached orbit`, body: `You boarded at the ${title(boardedZone)} and were aboard for it. See its flight.` }),
  host: (ticker: string, n: number) => ({ title: `Your launch $${ticker} has ${n} passengers`, body: "A milestone card is ready to share." }),
  crew: (tag: string, zone: string, nthThisWeek: number) => ({ title: `[${tag}] flew to ${title(zone)}`, body: `Your crew's ${nth(nthThisWeek)} rocket past the Kármán Line this week.` }),
  never: ["Price alerts that say buy or sell now", "\"Your crew is buying\" or entry prices", "\"Win it back\" after a red flight", "Streak warnings that push a trade"],
  rule: "At most 3 pushes a day, all off by default except orbit. Settings has one switch per kind.",
} as const;
