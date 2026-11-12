/**
 * GET /api/profile/referral-ledger?wallet=0x… → { referrer, totalUsd, rows: [{ id, tx, ts, usd }] }
 * Read-only view of the off-chain manual referral payout ledger (lib/server/referralLedger, the same rows the
 * /api/cron/referral-payout CSV sums) for one referrer, so the Rewards popup can add it to the on-chain totals.
 * Same public wallet= read as /api/profile/stats: no login, no writes, no friend wallets in the response. The rows are
 * built only from public trades and the on-chain referrer, like the on-chain referral events the popup already reads.
 */
import { NextResponse } from "next/server";
import { referrerLedger } from "@/lib/server/referralLedger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
const isAddr = (a: string | null): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);

export async function GET(req: Request) {
  const wallet = new URL(req.url).searchParams.get("wallet");
  if (!isAddr(wallet)) return NextResponse.json({ error: "bad wallet" }, { status: 400 });
  try {
    const l = await referrerLedger(wallet);
    return NextResponse.json(l, { headers: { "cache-control": "public, max-age=15, s-maxage=30, stale-while-revalidate=60" } });
  } catch (e) {
    console.warn("[disciple] referral ledger route failed", (e as Error).message);
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
