import "server-only";
/** Host mission control (lib/host.ts): one rocket's passengers, crews, top-10 share and milestones, plus the host's rockets. */
import type { Address } from "viem";
import { hostStats, type HostView } from "@/lib/host";
import { zoneName } from "@/lib/logbook";
import { getHomeData } from "./home";
import { guildTagsOf } from "./guilds";
import { holdersOf } from "./holders";
import { toLog } from "./logbook";
import { tradesOf } from "./trades";
import { usernameOf } from "./usernames";

const FILLS = 5000;
const TAGGED_MAX = 1000;
const OWN_ROCKETS_MAX = 12;

export async function hostFor(coinIn: string, now = Date.now()): Promise<HostView | null> {
  const coin = coinIn.toLowerCase();
  const home = await getHomeData();
  const c = home.coins.find((x) => x.token.toLowerCase() === coin);
  if (!c) return null;
  const creator = (c.creatorAddr ?? "").toLowerCase();
  const fills = (await tradesOf(coin, null, FILLS, "asc").catch(() => [])).map(toLog);
  const traders = [...new Set(fills.map((f) => f.trader.toLowerCase()))].filter((t) => t !== creator).slice(0, TAGGED_MAX);
  const tagRows = await guildTagsOf(traders);
  const tags: Record<string, string | null> = {};
  for (const t of traders) tags[t] = tagRows[t]?.id ?? null;
  const h = hostStats(fills, creator, { now, graduated: c.graduated, launchedAt: c.launchedAt, tags });
  const crews = new Set(h.holders.map((t) => tags[t]).filter(Boolean)).size;

  const [top10Pct, hostName, rockets] = await Promise.all([
    holdersOf(coin as Address, 100).then((r) => {
      const hs = r.holders.filter((x) => x.kind === "holder").slice(0, 10);
      return Math.round(hs.reduce((a, x) => a + (Number(x.pct) || 0), 0) * 10) / 10;
    }).catch(() => null),
    creator ? usernameOf(creator).catch(() => null) : Promise.resolve(null),
    creator ? ownRockets(creator, home.coins.filter((x) => (x.creatorAddr ?? "").toLowerCase() === creator), now).catch(() => null) : Promise.resolve(null),
  ]);
  const mcap = c.mcapUsd ?? h.lastMcap;
  return {
    coin, name: c.name, ticker: c.ticker, creator, hostName, mode: c.mode ?? undefined, graduated: c.graduated,
    launchedAt: h.launchedAt, zone: c.graduated ? "IN ORBIT" : zoneName(mcap), toOrbitUsd: c.graduated ? null : Math.max(0, Math.round(33_333 - mcap)),
    passengers: h.passengers, crews, top10Pct, series: h.series, milestones: h.milestones, peak: h.peak, day: h.day, rockets,
  };
}

async function ownRockets(creator: string, coins: { token: string; graduated: boolean; launchedAt: number | null }[], now: number) {
  const peaks = await Promise.all(coins.slice(0, OWN_ROCKETS_MAX).map(async (c) => {
    const fills = (await tradesOf(c.token, null, FILLS, "asc").catch(() => [])).map(toLog);
    return hostStats(fills, creator, { now, graduated: c.graduated, launchedAt: c.launchedAt }).peak;
  }));
  return { launched: coins.length, orbits: coins.filter((c) => c.graduated).length, mostPassengers: Math.max(0, ...peaks) };
}
