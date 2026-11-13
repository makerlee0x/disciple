import "server-only";
/** Loads both streaks (lib/streaks.ts) for a pilot, records today's check-in and pays what they've earned. */
import { aboardDays, dayIndex, streakOf, streakPays, type Streak } from "@/lib/streaks";
import { kv, type Kv } from "./kv";
import { playerUsd } from "@/lib/trades";
import { coinsOf, tradesOf } from "./trades";
import { award, XPK } from "./xp";
import { LOGBOOK_MAX_COINS } from "./logbook";

export type Streaks = { aboard: Streak; checkin: Streak; paid: number };

/** today's check-in (idempotent: a member per day) */
export async function checkIn(wallet: string, now = Date.now(), s: Kv = kv()) {
  const d = dayIndex(now);
  await s.zadd(XPK.checkins(wallet), [{ score: d, member: String(d) }]);
}

export async function streaksFor(walletIn: string, now = Date.now(), s: Kv = kv()): Promise<Streaks> {
  const w = walletIn.toLowerCase(), t = dayIndex(now);
  const coins = (await coinsOf(w)).slice(0, LOGBOOK_MAX_COINS);
  const perCoin = await Promise.all(coins.map((c) => tradesOf(c, w, 5000, "asc").catch(() => [])));
  const held = aboardDays(perCoin.map((fs) => fs.map((f) => ({ ts: f.ts, block: f.block, logIndex: f.logIndex, side: f.side, tokens: f.tokens, usd: playerUsd(f) }))), now);
  const ci = new Set((await s.zrange(XPK.checkins(w), 400, true)).map(Number).filter((d) => Number.isFinite(d) && d <= t));
  const aboard = streakOf(held.days, now, { todayCounts: false, todayOk: held.today });
  const checkin = streakOf(ci, now, { todayCounts: true, todayOk: ci.has(t) });
  // one MGET over the once-keys, then write only the rows not paid yet
  const pays = [...streakPays("aboard", aboard), ...streakPays("checkin", checkin)];
  const have = pays.length ? await s.mget(pays.map((p) => XPK.once(p.src, w))) : [];
  let paid = 0;
  for (let i = 0; i < pays.length; i++) if (!have[i] && (await award(w, { ...pays[i], kind: "streak" }, s))) paid += pays[i].xp;
  return { aboard, checkin, paid };
}
