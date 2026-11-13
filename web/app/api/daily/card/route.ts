/**
 * GET /api/daily/card?id=N[&run=runId] → the 1200×630 Daily flight share card (PNG), lib/server/share/dailyCard.
 * Every number comes from the server's replay of the stored run, never the query. No run: the day's best run, or an
 * invite card when nobody has flown it yet.
 */
import { kv } from "@/lib/server/kv";
import { PUBLIC_GET_LIMITS, clientIp, hitLimit } from "@/lib/server/limits";
import { dailyBoard, pilotOf, readRun } from "@/lib/server/daily";
import { renderDailyCard } from "@/lib/server/share/dailyCard";
import { dailyRecap, dailyToday, DAILY } from "@/lib/sim/daily";
import { serverDailySeed } from "@/lib/server/dailySeed";
import { cloneConfig } from "@/lib/sim/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `share:ip:${clientIp(req.headers)}`, PUBLIC_GET_LIMITS.sharePerIp.limit, PUBLIC_GET_LIMITS.sharePerIp.windowSec);
  if (!rl.ok) return new Response("rate limited", { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  const u = new URL(req.url), q = u.searchParams, id = q.get("id") ? Number(q.get("id")) : dailyToday();
  if (!Number.isInteger(id) || id < 1 || id > dailyToday()) return new Response("bad id", { status: 400 });
  const want = q.get("run");
  const board = await dailyBoard(id, { me: want && /^[0-9a-f]{16}$/.test(want) ? want : null });
  const runId = board.me?.runId ?? board.top[0]?.runId ?? null;
  const run = runId ? await readRun(id, runId) : null;
  const rc = run ? dailyRecap(run.seed ?? (await serverDailySeed(id)), run.inputs) : null, pilot = run ? await pilotOf(id, run).catch(() => null) : null;
  const rank = board.me?.rank ?? (run ? 1 : 0);
  const host = u.host.startsWith("localhost") || u.host.endsWith(".vercel.app") ? u.host : "disciple.vip";
  const png = await renderDailyCard({
    id, difficulty: cloneConfig().difficulties[DAILY.difficulty].label.toUpperCase(), host, rank, count: board.count,
    run: run && rc ? { name: pilot?.name ?? run.name, multiple: rc.score.multiple, goals: rc.score.goals, path: rc.path, outAtS: rc.score.outAtS } : null,
  });
  return new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600" } });
}
