/**
 * GET /api/cron/gas-refill — Vercel cron (vercel.json, every 10 minutes). Keeps every relay wallet (main relayer + the
 * RELAYER_KEY_POOL keys) in ETH by swapping the USDG gas fees the main relayer collects (lib/server/gasRefill).
 * Off unless GAS_REFILL_ENABLED=1; GAS_REFILL_DRY_RUN=1 reports the plan without sending.
 * Auth: Bearer CRON_SECRET, constant-time; in production an unset CRON_SECRET ⇒ 503 (never an open endpoint).
 * Response: wallet addresses + balances (public on chain anyway), the plan, tx hashes, alerts. Never key material.
 */
import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { isRelayerNotConfigured } from "@/lib/server/relayer";
import { runGasRefill } from "@/lib/server/gasRefill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const isProd = () => process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
const same = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

export async function GET(req: Request) {
  const s = process.env.CRON_SECRET;
  if (!s && isProd()) return NextResponse.json({ error: "cron_not_configured" }, { status: 503 });
  if (s && !same(req.headers.get("authorization") || "", `Bearer ${s}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await runGasRefill());
  } catch (e) {
    if (isRelayerNotConfigured(e)) return NextResponse.json({ error: "relayer_not_configured" }, { status: 503 });
    return NextResponse.json({ error: "refill_error" }, { status: 500 });
  }
}
