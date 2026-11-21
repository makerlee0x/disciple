import "server-only";
/**
 * Loads the three streaks (lib/streaks.ts) for a pilot, records today's check-in and play, pays what they've earned,
 * claims the daily drop, and works out the season track (lib/season/track.ts) and its crates.
 */
import { aboardDays, DAY, DAILY_DROP, dayIndex, dropReward, streakOf, streakPays, type DropReward, type Streak } from "@/lib/streaks";
import { rankSeasonAt } from "@/lib/duel/season";
import { seasonXp, trackOf, TRACK_REWARDS, type TrackState } from "@/lib/season/track";
import { kv, type Kv } from "./kv";
import { playerUsd } from "@/lib/trades";
import { coinsOf, tradesOf } from "./trades";
import { award, ledgerOf, XPK } from "./xp";
import { accountIdOf } from "./xpAccount";
import { LOGBOOK_MAX_COINS } from "./logbook";
import { verifiedOuts } from "./transferCache";
import { grantCrate } from "./collection";
import { playsKey, recordPlay } from "./plays";

export { recordPlay };

export type DropState = DropReward & { claimed: boolean };
export type SeasonTrack = TrackState & { season: number; endsAt: number };
export type Streaks = { aboard: Streak; checkin: Streak; flight: Streak; drop: DropState; track: SeasonTrack; paid: number };

const SK = {
  /** UTC days the pilot finished a match (lib/server/plays) */
  plays: playsKey,
  /** one bound crate per account per source: a second wallet on the same account doesn't get it again */
  acct: (acct: string, src: string) => `streaks:crate:${acct}:${src}`,
};

/** today's check-in (idempotent: a member per day) */
export async function checkIn(wallet: string, now = Date.now(), s: Kv = kv()) {
  const d = dayIndex(now);
  await s.zadd(XPK.checkins(wallet), [{ score: d, member: String(d) }]);
}

async function daysOf(key: string, t: number, s: Kv) {
  // every day since STREAKS_FROM (a member a day; dropping old ones would renumber the streak)
  return new Set((await s.zrange(key, 5000, true)).map(Number).filter((d) => Number.isFinite(d) && d <= t));
}

/** a bound crate, once per account for this source */
async function accountCrate(w: string, tier: Parameters<typeof grantCrate>[1], src: string, label: string, now: number, s: Kv): Promise<boolean> {
  if (!(await s.setNX(SK.acct(await accountIdOf(w, s), src), w))) return false;
  return grantCrate(w, tier, src, label, now, s);
}

const dropSrc = (day: number) => `drop:${day}`;
function dropState(checkin: Streak, claimed: boolean): DropState {
  // claimed: today is in the streak; not yet: claiming makes today the next day of it
  return { ...dropReward(checkin.todayOk ? checkin.current : checkin.current + 1), claimed };
}

/**
 * Claim today's daily drop: checks in, then pays the day's reward (XP, or a bound crate on day 7) once per wallet a day.
 * Returns the reward and whether it was paid just now.
 */
export async function claimDrop(walletIn: string, now = Date.now(), s: Kv = kv()): Promise<DropState & { paid: boolean }> {
  const w = walletIn.toLowerCase(), t = dayIndex(now);
  await checkIn(w, now, s);
  const checkin = streakOf(await daysOf(XPK.checkins(w), t, s), now, { todayCounts: true, todayOk: true });
  const r = dropReward(checkin.current), src = dropSrc(t);
  const paid = r.crate
    ? await accountCrate(w, DAILY_DROP.crate, src, `Daily drop day ${r.day}`, now, s)
    : await award(w, { src, kind: "streak", xp: r.xp, label: `Daily drop day ${r.day}`, ts: now }, s);
  return { ...r, claimed: true, paid };
}

/** the season track and its crates (granted once each, on read) */
export async function seasonTrackFor(w: string, now = Date.now(), s: Kv = kv()): Promise<SeasonTrack> {
  const season = rankSeasonAt(now);
  const st = trackOf(seasonXp(await ledgerOf(w, s), season.startsAt, season.endsAt));
  for (const e of st.earned) await accountCrate(w, TRACK_REWARDS[e.tier], `season:${season.id}:t${e.tier}`, `Season ${season.n} · tier ${e.tier}`, now, s).catch(() => false);
  return { ...st, season: season.n, endsAt: season.endsAt };
}

export async function streaksFor(walletIn: string, now = Date.now(), s: Kv = kv()): Promise<Streaks> {
  const w = walletIn.toLowerCase(), t = dayIndex(now);
  const coins = (await coinsOf(w)).slice(0, LOGBOOK_MAX_COINS);
  // each rocket: your fills plus your transfers away (as $0 sells), trusted only as far as the transfer scan reaches
  const perCoin = await Promise.all(coins.map(async (c) => {
    const [fs, v] = await Promise.all([tradesOf(c, w, 5000, "asc").catch(() => []), verifiedOuts(w, c, t * DAY, s)]);
    return { fills: [...fs.map((f) => ({ ts: f.ts, block: f.block, logIndex: f.logIndex, side: f.side, tokens: f.tokens, usd: playerUsd(f) })), ...v.outs], verifiedTo: v.verifiedTo };
  }));
  const held = aboardDays(perCoin, now);
  const [ci, pl] = await Promise.all([daysOf(XPK.checkins(w), t, s), daysOf(SK.plays(w), t, s)]);
  const aboard = streakOf(held.days, now, { todayCounts: false, todayOk: held.today });
  const checkin = streakOf(ci, now, { todayCounts: true, todayOk: ci.has(t) });
  const flight = streakOf(pl, now, { todayCounts: true, todayOk: pl.has(t) });
  // one MGET over the once-keys, then write only the rows not paid yet
  const pays = [...streakPays("aboard", aboard), ...streakPays("checkin", checkin), ...streakPays("flight", flight)];
  const have = await s.mget([...pays.map((p) => XPK.once(p.src, w)), XPK.once(dropSrc(t), w)]);
  let paid = 0;
  for (let i = 0; i < pays.length; i++) if (!have[i] && (await award(w, { ...pays[i], kind: "streak" }, s))) paid += pays[i].xp;
  // a day-7 drop is a crate, not a ledger row: its once-key lives with the crates
  const dropXpPaid = !!have[have.length - 1];
  const nextDrop = dropReward(checkin.todayOk ? checkin.current : checkin.current + 1);
  const claimed = nextDrop.crate ? !!(await s.get(SK.acct(await accountIdOf(w, s), dropSrc(t)))) : dropXpPaid;
  const track = await seasonTrackFor(w, now, s);
  return { aboard, checkin, flight, drop: dropState(checkin, claimed), track, paid };
}
