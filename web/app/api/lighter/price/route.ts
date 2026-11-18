/**
 * Which live BTC price Turbo's screens draw, so the chart matches the price the duel server scores on
 * (lib/server/duel/price). { host } = a Lighter exchange's API host (its public market_stats WebSocket), or null for
 * the Hyperliquid feed. Public, no account data.
 */
import { NextResponse } from "next/server";
import { lighterConfig } from "@/lib/server/lighter/config";
import { duelPriceVenue } from "@/lib/server/duel/price";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const host = duelPriceVenue() === "lighter" ? new URL(lighterConfig().url).host : null;
  return NextResponse.json({ ok: true, host }, { headers: { "cache-control": "public, max-age=60" } });
}
