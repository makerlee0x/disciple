import "server-only";
/** Crew flights page (lib/crew.ts): your crew, its record with you, where it's flying now, the weekly crew mission. */
import { CREW_RULES, crewAboardNow, crewOnCoin, crewRecord, type CrewFlying, type CrewMate, type CrewPage } from "@/lib/crew";
import { zoneName } from "@/lib/logbook";
import { weekPeriod } from "@/lib/xp";
import { getCrewBoard } from "./leaderboard";
import { coinFillsFor, coinMetas, crewOf, LOGBOOK_MAX_COINS, toLog } from "./logbook";
import { guilds } from "./guilds";
import { coinsOf, tradesOf } from "./trades";
import { usernameOf } from "./usernames";
import { verifiedOuts } from "./transferCache";
import { award } from "./xp";

/** live rockets from the lobby list checked for crew aboard, on top of your own */
const LOBBY_COINS = 30;
const RECENT_FILLS = 2000;
const SHOWN = 4;
/** transfer scans read per rocket for the crew mission */
const MISSION_CHECKS_MAX = 40;

const named = async (ws: string[]): Promise<CrewMate[]> => Promise.all(ws.map(async (w) => ({ wallet: w, name: await usernameOf(w).catch(() => null) })));

export async function crewPageFor(walletIn: string, now = Date.now()): Promise<CrewPage> {
  const w = walletIn.toLowerCase(), wk = weekPeriod(now);
  const [{ guild, members }, username] = await Promise.all([crewOf(w), usernameOf(w).catch(() => null)]);
  const empty: CrewPage = { crew: null, record: { together: 0, orbits: 0, longestMs: 0, rank: null }, flying: [], mission: { best: 0, target: CREW_RULES.missionCrew, xp: CREW_RULES.missionXp, done: false, resetsAt: wk.end }, username };
  if (!guild) return empty;
  const [metas, mine, since, count, board] = await Promise.all([
    coinMetas(), coinsOf(w), guilds().memberSince(w).catch(() => null), guilds().memberCount(guild.id).catch(() => members.size + 1), getCrewBoard("week", w).catch(() => null),
  ]);
  const myCoins = mine.map((c) => c.toLowerCase()).filter((c) => metas.has(c)).slice(0, LOGBOOK_MAX_COINS);
  const mineSet = new Set(myCoins);
  const lobby = [...metas.keys()].filter((c) => !mineSet.has(c)).slice(0, LOBBY_COINS);

  const rows = await Promise.all(myCoins.map(async (c) => {
    const fills = await coinFillsFor(w, c).catch(() => []);
    const grad = metas.get(c)!.graduated;
    // the mission first on fills alone (an upper bound, nothing paid from it); only rockets that could qualify load
    // the transfer scans of you and the crewmates on them, and the mission is then recounted on checked holds
    const traders = new Set(fills.map((f) => f.trader.toLowerCase()).filter((t) => t === w || members.has(t)));
    const trustAll = new Map([...traders].map((t) => [t, { outs: [], verifiedTo: Infinity }]));
    let r = crewOnCoin(fills, w, members, now, wk.start, grad, trustAll);
    if (r.missionBest >= CREW_RULES.missionCrew) {
      const checks = new Map(await Promise.all([...traders].slice(0, MISSION_CHECKS_MAX).map(async (t) => [t, await verifiedOuts(t, c, now - CREW_RULES.missionMs)] as const)));
      r = { ...r, missionBest: crewOnCoin(fills, w, members, now, wk.start, grad, checks).missionBest };
    }
    return { c, r };
  }));
  const others = await Promise.all(lobby.map(async (c) => ({ c, aboard: crewAboardNow((await tradesOf(c, null, RECENT_FILLS, "desc").catch(() => [])).map(toLog), members, now) })));

  const live = [...rows.map((x) => ({ c: x.c, aboard: x.r.aboardNow })), ...others].filter((x) => x.aboard.length > 0)
    .sort((a, b) => b.aboard.length - a.aboard.length).slice(0, SHOWN);
  const flying = await Promise.all(live.map(async (x): Promise<CrewFlying> => {
    const m = metas.get(x.c)!;
    return { coin: x.c, ticker: m.ticker, name: m.name, zone: m.graduated ? "In orbit" : zoneName(m.mcapUsd ?? 0), mode: m.mode, graduated: m.graduated, aboard: await named(x.aboard.slice(0, 5)), count: x.aboard.length, you: mineSet.has(x.c) };
  }));

  const best = Math.max(0, ...rows.map((x) => x.r.missionBest));
  const done = best >= CREW_RULES.missionCrew;
  // the weekly crew mission pays once per week per pilot (ledger src keyed by the week)
  if (done) await award(w, { src: `crew:${wk.id}`, kind: "mission", xp: CREW_RULES.missionXp, label: "Crew mission: 3 crewmates aboard for an hour", ts: now }).catch(() => false);

  return {
    crew: { id: guild.id, tag: guild.tag, name: guild.name, mark: guild.mark, members: count, since },
    record: { ...crewRecord(rows.map((x) => x.r)), rank: board?.mine?.rank ?? null },
    flying, mission: { best: Math.min(best, CREW_RULES.missionCrew), target: CREW_RULES.missionCrew, xp: CREW_RULES.missionXp, done, resetsAt: wk.end }, username,
  };
}

/** lobby cards: crewmates aboard each listed rocket (you excluded). Only rockets with someone aboard are returned. */
export async function crewAboardFor(walletIn: string, coins: string[], now = Date.now()): Promise<Record<string, number>> {
  const { guild, members } = await crewOf(walletIn.toLowerCase());
  if (!guild || !members.size) return {};
  const out: Record<string, number> = {};
  await Promise.all(coins.slice(0, LOBBY_COINS).map(async (c) => {
    const n = crewAboardNow((await tradesOf(c, null, RECENT_FILLS, "desc").catch(() => [])).map(toLog), members, now).length;
    if (n) out[c.toLowerCase()] = n;
  }));
  return out;
}
