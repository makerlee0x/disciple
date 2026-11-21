export const runtime = "nodejs";
/**
 * POST /api/funnel { step, src? } → 204. Counts one funnel step (lib/funnel.ts) on the existing Upstash KV (lib/server/kv):
 * INCR fun:<net>:<step>:d:<UTC day> and fun:<net>:<step>:all, plus the same pair under :s:<src> (app | x | web; anything
 * else counts as web). Counts only: no user id, email, wallet address or IP is
 * stored (the IP is hashed into a 60 s rate-limit key and dropped). Always answers quickly; errors are not surfaced.
 */
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { ACTIVE_CHAIN } from "@/lib/chains";
import { DAY_TTL_SEC, TOTAL_TTL_SEC, dayKey, funnelNet, isFunnelSource, isFunnelStep, srcDayKey, srcTotalKey, totalKey, utcDay } from "@/lib/funnel";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";

export const dynamic = "force-dynamic";
const done = (status = 204) => new NextResponse(null, { status, headers: { "cache-control": "no-store" } });

export async function POST(req: Request) {
  let step: unknown, rawSrc: unknown;
  try { ({ step, src: rawSrc } = ((await req.json()) as { step?: unknown; src?: unknown }) ?? {}); } catch { return done(400); }
  if (!isFunnelStep(step)) return done(400);
  try {
    const ipTag = createHash("sha256").update(clientIp(req.headers)).digest("hex").slice(0, 16);
    // 40/min: a first visit can send ~10 steps, and phone carriers put many players behind one IP
    const lim = await hitLimit(kv(), `fun:${ipTag}`, 40, 60);
    if (!lim.ok) return done(429);
    const net = funnelNet(ACTIVE_CHAIN.id, process.env.VERCEL_ENV);
    const store = kv(), day = utcDay(Date.now()), src = isFunnelSource(rawSrc) ? rawSrc : "web";
    await Promise.all([
      store.incrEx(dayKey(net, step, day), DAY_TTL_SEC),
      store.incrEx(totalKey(net, step), TOTAL_TTL_SEC),
      store.incrEx(srcDayKey(net, step, src, day), DAY_TTL_SEC),
      store.incrEx(srcTotalKey(net, step, src), TOTAL_TTL_SEC),
    ]);
  } catch { /* counting is best-effort */ }
  return done();
}
