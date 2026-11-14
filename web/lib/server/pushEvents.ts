import "server-only";
/**
 * Finds the push events (lib/push.ts) from the indexed trades, every few minutes (GET /api/cron/push):
 *  - orbit: a rocket graduated; everyone aboard at the orbit fill (host excluded) gets "reached orbit"
 *  - host:  a launch passed 25 / 50 / 100 … passengers; its host gets the milestone
 *  - crew:  a rocket climbed into a zone at or past the Kármán Line with 2+ of a crew aboard; that crew hears about it
 * The first run only records where everything stands, so nothing old is announced.
 */
import { CREW_ENABLED, LOGBOOK_ENABLED } from "@/lib/features";
import { pushCopy, type PushKind } from "@/lib/push";
import { hostStats, PASSENGER_MARKS } from "@/lib/host";
import { ORBIT_MCAP, zoneIndex, zoneName } from "@/lib/logbook";
import { TIERS } from "@/lib/config";
import { weekPeriod } from "@/lib/xp";
import { getHomeData } from "./home";
import { guilds, guildTagsOf } from "./guilds";
import { kv } from "./kv";
import { toLog } from "./logbook";
import { notify } from "./push";
import { tradesOf } from "./trades";

const WATCH = 40;
const FILLS = 5000;
const MAX_PER_EVENT = 500;
const CREW_ZONE_FROM = TIERS.findIndex((t) => t.name === "KÁRMÁN LINE");
const DUST = 1e-9;
const S = { seeded: "push:seeded", orbited: "push:orbited", mark: (c: string) => `push:hostmark:${c}`, zone: (c: string) => `push:zone:${c}`, crewWeek: (id: string, wk: string) => `push:crewweek:${id}:${wk}` };

export type PushRun = { seeded: boolean; checked: number; sent: Record<PushKind, number> };

export async function runPushEvents(budgetMs = 45_000, now = Date.now()): Promise<PushRun> {
  const s = kv(), t0 = Date.now(), seeded = !!(await s.get(S.seeded));
  const coins = (await getHomeData()).coins;
  const orbited = new Set(await s.smembers(S.orbited));
  const sent: Record<PushKind, number> = { orbit: 0, host: 0, crew: 0 };
  const count = (k: PushKind) => (r: string) => { if (r === "sent") sent[k]++; };

  if (!seeded) {
    const grads = coins.filter((c) => c.graduated).map((c) => c.token.toLowerCase());
    if (grads.length) await s.sadd(S.orbited, ...grads);
  }
  const watch = coins.slice(0, WATCH);
  const fresh = seeded ? coins.filter((c) => c.graduated && !orbited.has(c.token.toLowerCase())) : [];
  const todo = [...new Map([...fresh, ...watch].map((c) => [c.token.toLowerCase(), c])).values()];
  let checked = 0;
  for (const c of todo) {
    if (Date.now() - t0 > budgetMs) break;
    checked++;
    const coin = c.token.toLowerCase(), creator = (c.creatorAddr ?? "").toLowerCase();
    const fills = (await tradesOf(coin, null, FILLS, "asc").catch(() => [])).map(toLog);

    // orbit with you aboard
    if (seeded && c.graduated && !orbited.has(coin)) {
      await s.sadd(S.orbited, coin);
      const held = new Map<string, number>(), firstMcap = new Map<string, number>();
      for (const f of fills) {
        const t = f.trader.toLowerCase();
        if ((f.mcapUsd ?? 0) >= ORBIT_MCAP) break;
        if (f.side === "buy" && !firstMcap.has(t)) firstMcap.set(t, f.mcapUsd ?? 0);
        held.set(t, Math.max(0, (held.get(t) ?? 0) + (f.side === "buy" ? f.tokens : -f.tokens)));
      }
      const aboard = [...held.entries()].filter(([t, v]) => v > DUST && t !== creator).map(([t]) => t).slice(0, MAX_PER_EVENT);
      for (const w of aboard) count("orbit")(await notify(w, "orbit", `orbit:${coin}`, { ...pushCopy.orbit(c.ticker, zoneName(firstMcap.get(w) ?? 0)), url: LOGBOOK_ENABLED ? `/logbook/${coin}` : `/coin/${coin}` }, now).catch(() => "error"));
    }

    // host passenger milestones
    if (creator) {
      const h = hostStats(fills, creator, { now, graduated: c.graduated, launchedAt: c.launchedAt });
      const mark = PASSENGER_MARKS.filter((m) => m >= 25 && h.passengers >= m).pop() ?? 0;
      const prev = await s.get(S.mark(coin));
      if (prev === null) await s.set(S.mark(coin), String(mark));
      else if (mark > Number(prev)) {
        await s.set(S.mark(coin), String(mark));
        count("host")(await notify(creator, "host", `host:${coin}:${mark}`, { ...pushCopy.host(c.ticker, mark), url: `/host?coin=${coin}` }, now).catch(() => "error"));
      }
    }

    // crew zones at or past the Kármán Line
    const z = zoneIndex(c.mcapUsd ?? 0), prevZ = await s.get(S.zone(coin));
    if (prevZ === null || z !== Number(prevZ)) await s.set(S.zone(coin), String(z));
    if (CREW_ENABLED && prevZ !== null && z > Number(prevZ) && z >= CREW_ZONE_FROM) {
      const held = new Map<string, number>();
      for (const f of fills) { const t = f.trader.toLowerCase(); held.set(t, Math.max(0, (held.get(t) ?? 0) + (f.side === "buy" ? f.tokens : -f.tokens))); }
      const aboard = [...held.entries()].filter(([t, v]) => v > DUST && t !== creator).map(([t]) => t).slice(0, 1000);
      const tags = await guildTagsOf(aboard);
      const by = new Map<string, { tag: string; n: number }>();
      for (const w of aboard) { const g = tags[w]; if (g) by.set(g.id, { tag: g.tag, n: (by.get(g.id)?.n ?? 0) + 1 }); }
      const wk = weekPeriod(now).id;
      for (const [id, g] of by) {
        if (g.n < 2) continue;
        const nth = await s.incrEx(S.crewWeek(id, wk), 8 * 86400);
        const members = await guilds().membersOf(id, 200).catch(() => []);
        for (const w of members) count("crew")(await notify(w, "crew", `crew:${coin}:${z}:${id}`, { ...pushCopy.crew(g.tag, TIERS[z].name, nth), url: "/crew" }, now).catch(() => "error"));
      }
    }
  }
  if (!seeded) await s.set(S.seeded, String(now));
  return { seeded, checked, sent };
}
