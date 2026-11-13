/**
 * Daily flight (Free play).
 * GET  /api/daily[?id=N][&me=runId][&run=runId] → lib/server/daily DailyBoard (today when id is left out)
 * POST /api/daily {id, device, inputs} → the server re-flies the input log and stores that verdict, one per device per day
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { PUBLIC_GET_LIMITS, clientIp, hitLimit } from "@/lib/server/limits";
import { dailyBoard, submitDaily, topPct } from "@/lib/server/daily";
import { dailyToday } from "@/lib/sim/daily";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const RUN_RE = /^[0-9a-f]{16}$/;

export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `daily:get:${clientIp(req.headers)}`, PUBLIC_GET_LIMITS.dailyPerIp.limit, PUBLIC_GET_LIMITS.dailyPerIp.windowSec);
  if (!rl.ok) return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  const q = new URL(req.url).searchParams, id = q.get("id") ? Number(q.get("id")) : dailyToday(), me = q.get("me"), run = q.get("run");
  if (!Number.isInteger(id) || id < 1 || id > dailyToday()) return NextResponse.json({ error: "bad id" }, { status: 400 });
  if ((me && !RUN_RE.test(me)) || (run && !RUN_RE.test(run))) return NextResponse.json({ error: "bad run" }, { status: 400 });
  const board = await dailyBoard(id, { me, run });
  return NextResponse.json(board, { headers: { "cache-control": me ? "private, max-age=0" : "public, max-age=0, s-maxage=10, stale-while-revalidate=30" } });
}

export async function POST(req: Request) {
  const ip = clientIp(req.headers);
  const rl = await hitLimit(kv(), `daily:post:${ip}`, 30, 3600);
  if (!rl.ok) return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  const raw = await req.text(); if (raw.length > 40_000) return NextResponse.json({ error: "too big" }, { status: 413 });
  let body: { id?: unknown; device?: unknown; inputs?: unknown };
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const r = await submitDaily(Number(body.id), body.device, body.inputs);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  const { run } = r;
  return NextResponse.json({ runId: run.runId, name: run.name, score: run.score, rank: r.rank, count: r.count, topPct: topPct(r.rank, r.count), already: r.already, ...(r.already ? { inputs: run.inputs } : {}) });
}
