export const runtime = "nodejs";
/**
 * GET /api/admin/funnel?days=14&net=46630&src=app → { net, src, days, steps, rows: [{ day, counts }], totals }
 * src (app | x | web) reads the per-source counters; left out, the unsplit ones.
 * Read-only funnel counts (lib/funnel.ts). Privy admin session (Authorization: Bearer <access token>) whose email is in
 * ADMIN_EMAILS, same gate as /api/admin/verifications; ADMIN_EMAILS unset ⇒ 503 (fail closed).
 */
import { NextResponse } from "next/server";
import { ACTIVE_CHAIN } from "@/lib/chains";
import { FUNNEL_STEPS, dayKey, funnelNet, isFunnelSource, lastDays, srcDayKey, srcTotalKey, totalKey, type FunnelStep } from "@/lib/funnel";
import { kv } from "@/lib/server/kv";
import { authenticateAdmin, bearer, privyEnv } from "@/lib/server/privyAuth";

export const dynamic = "force-dynamic";
const json = (s: number, b: Record<string, unknown>) => NextResponse.json(b, { status: s, headers: { "cache-control": "no-store" } });

export async function GET(req: Request) {
  const a = await authenticateAdmin(bearer(req.headers), privyEnv(), process.env.ADMIN_EMAILS);
  if (!a.ok) return json(a.status, { error: a.reason });
  const u = new URL(req.url);
  const netParam = u.searchParams.get("net");
  const net = netParam && /^[a-z0-9]{1,16}$/.test(netParam) ? netParam : funnelNet(ACTIVE_CHAIN.id, process.env.VERCEL_ENV);
  const days = lastDays(Date.now(), Number(u.searchParams.get("days") || 14));
  const srcParam = u.searchParams.get("src"), src = isFunnelSource(srcParam) ? srcParam : null;
  const dk = (s: FunnelStep, d: string) => (src ? srcDayKey(net, s, src, d) : dayKey(net, s, d));
  const tk = (s: FunnelStep) => (src ? srcTotalKey(net, s, src) : totalKey(net, s));
  const keys = days.flatMap((d) => FUNNEL_STEPS.map((s) => dk(s, d)));
  try {
    const store = kv();
    const [vals, tot] = await Promise.all([store.mget(keys), store.mget(FUNNEL_STEPS.map(tk))]);
    const n = (v: string | null | undefined) => Number(v) || 0;
    const rows = days.map((day, i) => ({ day, counts: Object.fromEntries(FUNNEL_STEPS.map((s, j) => [s, n(vals[i * FUNNEL_STEPS.length + j])])) }));
    const totals = Object.fromEntries(FUNNEL_STEPS.map((s, j) => [s, n(tot[j])]));
    return json(200, { net, src, days: days.length, steps: FUNNEL_STEPS, rows, totals });
  } catch {
    return json(503, { error: "Counts are unavailable right now." });
  }
}
