/**
 * Push alerts (main mode hook loop, maker 2026-11-13, mockup board "Notifications"). Pure, shared by client and server.
 * At most 3 a day, all off by default except orbit, launch milestones and duel requests, one switch per kind in Settings. Each push names something that
 * already happened (people and zones). What we never send: price alerts that say buy or sell now, "your crew is buying"
 * or entry prices, "win it back" after a red flight, streak warnings that push a trade.
 */
export type PushKind = "orbit" | "host" | "crew" | "duel" | "market" | "rival" | "daily";
export const PUSH_DAILY_CAP = 3;
export const PUSH_KINDS: readonly { k: PushKind; label: string; on: boolean }[] = [
  { k: "orbit", label: "Orbit with you aboard", on: true },
  // on by default since launch funnel item 8 (2026-11-17): a host hears when their rocket gets its first pilots
  { k: "host", label: "Your launch milestones", on: true },
  { k: "crew", label: "Crew zones", on: false },
  // a person asked you for a duel (maker 2026-11-16, rematch requests): on by default, like orbit, because a person is waiting
  { k: "duel", label: "Duel requests", on: true },
  // your market item sold (maker 2026-11-18: "otherwise how would they know"); private sales and cash offers too
  // (maker 2026-11-19: "all of these should send a notification"): on by default, and outside the daily cap
  { k: "market", label: "Market and trades", on: true },
  // retention loop (maker 2026-11-21 "do all 10", item 4): a named pilot passed you on today's flight board or the Overall
  // board (once a day per board), and today's daily flight opening for pilots who flew yesterday. Both name something that
  // happened; neither asks for a trade. On by default; flip `on` to make either opt-in.
  { k: "rival", label: "Rivals passing you", on: true },
  { k: "daily", label: "Daily flight opens", on: true },
];
/** Kinds that name money that landed or a person waiting on you: they don't count toward PUSH_DAILY_CAP. */
export const UNCAPPED_KINDS: readonly PushKind[] = ["market"];
export type PushPrefs = Record<PushKind, boolean>;
export const DEFAULT_PUSH_PREFS: PushPrefs = Object.fromEntries(PUSH_KINDS.map((x) => [x.k, x.on])) as PushPrefs;
export function readPrefs(v: unknown): PushPrefs {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return Object.fromEntries(PUSH_KINDS.map((x) => [x.k, typeof o[x.k] === "boolean" ? o[x.k] : x.on])) as PushPrefs;
}

/**
 * Who passed whom between two snapshots of a board (wallets, best first). A pilot who dropped places was passed by the
 * nearest pilot now above them who was below them before (or new to the board). The first snapshot passes nobody.
 */
export function passedBy(prev: readonly string[], next: readonly string[]): Map<string, { by: string; rank: number }> {
  const out = new Map<string, { by: string; rank: number }>();
  if (!prev.length) return out;
  const was = new Map(prev.map((w, i) => [w, i]));
  next.forEach((v, j) => {
    const i = was.get(v);
    if (i === undefined || j <= i) return;
    for (let k = j - 1; k >= 0; k--) { const pi = was.get(next[k]); if (pi === undefined || pi > i) { out.set(v, { by: next[k], rank: j + 1 }); return; } }
  });
  return out;
}

export interface PushMsg { id: string; kind: PushKind; title: string; body: string; url: string; ts: number }

const title = (z: string) => z.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const nth = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

export const pushCopy = {
  orbit: (ticker: string, boardedZone: string) => ({ title: `$${ticker} reached orbit`, body: `You boarded at the ${title(boardedZone)} and were aboard for it. See its flight.` }),
  host: (ticker: string, n: number) => ({ title: `Your launch $${ticker} has ${n} passengers`, body: "A milestone card is ready to share." }),
  firstBoosts: (ticker: string, n: number) => ({ title: `$${ticker} has its first ${n} pilots aboard`, body: "Your share card is ready." }),
  duel: (from: string) => ({ title: `${from} wants a duel`, body: "1v1, one minute, live BTC. Their room is open for 30 minutes." }),
  sold: (item: string, sellerCents: number) => ({ title: `Sold: ${item}`, body: `$${(sellerCents / 100).toFixed(2)} landed in your Cash.` }),
  privateSale: (from: string, item: string, cents: number) => ({ title: `${from} made you a private sale`, body: `${item} for $${(cents / 100).toFixed(2)}. Only you can buy it.` }),
  offer: (from: string, item: string, cents: number, youGet: number) => ({ title: `${from} offered $${(cents / 100).toFixed(2)}`, body: `For your ${item}. You'd get $${(youGet / 100).toFixed(2)}.` }),
  offerAccepted: (item: string, cents: number) => ({ title: `Offer accepted: ${item}`, body: `Pay $${(cents / 100).toFixed(2)} within 24h and it's yours.` }),
  offerDeclined: (item: string, cents: number) => ({ title: `Offer declined: ${item}`, body: `Your $${(cents / 100).toFixed(2)} offer was turned down.` }),
  rivalDaily: (by: string, rank: number, count: number) => ({ title: `${by} passed you on today's flight`, body: `You're #${rank} of ${count} now.` }),
  rivalOverall: (by: string, rank: number) => ({ title: `${by} passed you on the Overall board`, body: `You're #${rank} this season.` }),
  dailyOpen: (id: number, rank: number, count: number) => ({ title: `Daily flight #${id} is open`, body: `You placed #${rank} of ${count} yesterday.` }),
  crew: (tag: string, zone: string, nthThisWeek: number) => ({ title: `[${tag}] flew to ${title(zone)}`, body: `Your crew's ${nth(nthThisWeek)} rocket past the Kármán Line this week.` }),
  never: ["Price alerts that say buy or sell now", "\"Your crew is buying\" or entry prices", "\"Win it back\" after a red flight", "Streak warnings that push a trade"],
  rule: "At most 3 a day.",
} as const;
