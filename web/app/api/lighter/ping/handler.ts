import "server-only";
/** Times warm round trips from this server region to Lighter's API (picks where the Lighter route should run). */
import { NextResponse } from "next/server";
import { lighterConfig } from "@/lib/server/lighter/config";

export async function pingLighter(region: string) {
  const cfg = lighterConfig();
  if (!cfg.enabled) return NextResponse.json({ ok: false, reason: "Lighter isn't on." }, { status: 404 });
  const times: number[] = [];
  for (let i = 0; i < 6; i++) {
    const t0 = performance.now();
    await fetch(`${cfg.url}/api/v1/orderBookDetails?market_id=0`, { cache: "no-store" }).then((r) => r.arrayBuffer()).catch(() => null);
    times.push(Math.round(performance.now() - t0));
  }
  const warm = times.slice(1).sort((a, b) => a - b);
  return NextResponse.json({ ok: true, region, vercel: process.env.VERCEL_REGION ?? null, first: times[0], best: warm[0], median: warm[Math.floor(warm.length / 2)] }, { headers: { "cache-control": "no-store" } });
}
