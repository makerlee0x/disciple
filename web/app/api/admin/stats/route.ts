export const runtime = "nodejs";
/**
 * GET /api/admin/stats[?fresh=1] → Team stats (lib/server/adminStats): sign-ups, launches, trading, funnel, Turbo.
 * Same gate as /api/admin/funnel: Privy session whose email is in ADMIN_EMAILS; ADMIN_EMAILS unset ⇒ 503 (fail closed).
 */
import { NextResponse } from "next/server";
import { adminStats } from "@/lib/server/adminStats";
import { authenticateAdmin, bearer, privyEnv } from "@/lib/server/privyAuth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const json = (s: number, b: unknown) => NextResponse.json(b, { status: s, headers: { "cache-control": "no-store" } });

export async function GET(req: Request) {
  const a = await authenticateAdmin(bearer(req.headers), privyEnv(), process.env.ADMIN_EMAILS);
  if (!a.ok) return json(a.status, { error: a.reason });
  try {
    return json(200, await adminStats(new URL(req.url).searchParams.get("fresh") === "1"));
  } catch {
    return json(503, { error: "Stats are unavailable right now." });
  }
}
