import "server-only";
/**
 * Retention pushes (retention loop, maker 2026-11-21 "do all 10", item 4), run by the push cron (lib/server/pushEvents):
 *  - daily: today's daily flight opened. Pilots who saved a run on yesterday's board hear it once, with where they placed.
 *           From the end of the late-run grace (10 min) to 2 hours after the reset, so a late or first cron never sends
 *           it mid-day; a big board goes out over several cron runs.
 *  - rival: a named pilot passed you on today's daily flight board or the Overall board (top 50 of each). One push a day
 *           per board per pilot; a board's first snapshot passes nobody.
 * Duel requests already push from POST /api/duel/request.
 */
import { pushCopy, passedBy } from "@/lib/push";
import { dailyEndsAt, dailyToday } from "@/lib/sim/daily";
import { seasonAt } from "@/lib/duel/season";
import { defaultUsername } from "@/lib/defaultUsername";
import { kv, type Kv } from "./kv";
import { notify, type NotifyResult } from "./push";
import { DAILY_GRACE_MS, okey, zkey } from "./daily";
import { getOverall } from "./leaderboard";
import { usernameOf } from "./usernames";

const TOP = 50;
const OPEN_WINDOW_MS = 2 * 3_600_000;
const YESTERDAY_MAX = 2000;
const DAY_MS = 86_400_000;
const R = { open: (id: number) => `push:dailyopen:${id}`, snapD: (id: number) => `push:rival:d:${id}`, snapO: (season: string) => `push:rival:o:${season}` };

export type RetentionSent = { daily: number; rival: number };
const at = (name: string | null, w: string) => (name ? (name.startsWith("@") ? name : `@${name}`) : defaultUsername(w));

/** the wallets on daily `id`'s board, best first (every boarded run has an owner) */
async function dailyWallets(id: number, limit: number, s: Kv): Promise<string[]> {
  const runs = await s.zrange(zkey(id), limit, true);
  if (!runs.length) return [];
  return (await s.mget(runs.map((r) => okey(id, r)))).filter((w): w is string => !!w).map((w) => w.toLowerCase());
}

async function snapshot(key: string, next: string[], s: Kv): Promise<string[]> {
  const raw = await s.get(key);
  await s.set(key, JSON.stringify(next));
  try { return raw ? (JSON.parse(raw) as string[]) : []; } catch { return []; }
}

export async function runRetentionPushes(now = Date.now(), s: Kv = kv(), budgetMs = 15_000): Promise<RetentionSent> {
  const sent: RetentionSent = { daily: 0, rival: 0 };
  const count = (k: keyof RetentionSent) => (r: NotifyResult | "error") => { if (r === "sent") sent[k]++; };
  const id = dailyToday(), opened = dailyEndsAt(id - 1);

  // today's flight opened: after the late-run grace, in passes of a few seconds (a cursor carries on next run)
  const since = now - opened;
  if (since > DAILY_GRACE_MS && since < OPEN_WINDOW_MS) {
    const cur = Number(await s.get(R.open(id))) || 0;
    if (cur >= 0) {
      const ws = await dailyWallets(id - 1, YESTERDAY_MAX, s), t0 = Date.now();
      let i = cur;
      for (; i < ws.length && Date.now() - t0 < budgetMs; i++) count("daily")(await notify(ws[i], "daily", `daily:${id}`, { ...pushCopy.dailyOpen(id, i + 1, ws.length), url: "/flight/sim?daily=1" }, now, s).catch(() => "error" as const));
      await s.set(R.open(id), String(i >= ws.length ? -1 : i));
    }
  }
  await s.del(R.open(id - 1));

  // passed on today's flight board (yesterday's snapshot is done with)
  await s.del(R.snapD(id - 1));
  const today = await dailyWallets(id, TOP, s), count0 = await s.zcard(zkey(id));
  for (const [v, p] of passedBy(await snapshot(R.snapD(id), today, s), today)) {
    count("rival")(await notify(v, "rival", `rival:d:${id}`, { ...pushCopy.rivalDaily(at(await usernameOf(p.by).catch(() => null), p.by), p.rank, Math.max(count0, p.rank)), url: "/flight/sim?daily=1" }, now, s).catch(() => "error" as const));
  }

  // passed on the Overall board
  const rows = (await getOverall(null).catch(() => null))?.rows ?? [];
  const names = new Map(rows.map((r) => [r.wallet, r.username]));
  const overall = rows.slice(0, TOP).map((r) => r.wallet);
  const day = Math.floor(now / DAY_MS);
  for (const [v, p] of passedBy(await snapshot(R.snapO(seasonAt(now).id), overall, s), overall)) {
    count("rival")(await notify(v, "rival", `rival:o:${day}`, { ...pushCopy.rivalOverall(at(names.get(p.by) ?? null, p.by), p.rank), url: "/leaderboard" }, now, s).catch(() => "error" as const));
  }
  return sent;
}
