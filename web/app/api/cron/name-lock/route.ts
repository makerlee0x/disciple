/**
 * GET /api/cron/name-lock[?dry=1] — name+ticker lock tick (lib/server/nameLock).
 * Scheduled in vercel.json every 5 minutes. Mainnet only (testnet returns skipped: not_mainnet).
 *  - scan Launched + GraduatedToV4 from the KV cursor, claim on ascend (SET NX), flag slipped-in copies
 *  - tick drop-back on holders (24h continuously below $33,333 + one final mcap check)
 * Idempotent. Auth: Bearer CRON_SECRET (constant-time); in production an unset CRON_SECRET ⇒ 503.
 */
import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { kv } from "@/lib/server/kv";
import { runNameLock } from "@/lib/server/nameLock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const isProd = () => process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
const same = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: Request) {
  const s = process.env.CRON_SECRET;
  if (!s && isProd()) return NextResponse.json({ error: "cron_not_configured" }, { status: 503 });
  if (s && !same(req.headers.get("authorization") || "", `Bearer ${s}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dryRun = new URL(req.url).searchParams.get("dry") === "1";
  if (!(await kv().setNX("namelock:lock", "1", 50))) return NextResponse.json({ ok: true, skipped: "locked" }, { headers: NO_STORE });
  try {
    const r = await runNameLock({ budgetMs: 45_000, dryRun });
    return NextResponse.json(r, { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500, headers: NO_STORE });
  } finally {
    await kv().del("namelock:lock").catch(() => {});
  }
}
