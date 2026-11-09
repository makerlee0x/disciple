import { NextResponse } from "next/server";
import { sponsorshipConfig } from "@/lib/server/sponsorshipConfig";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET() {
  return NextResponse.json(sponsorshipConfig(), { headers: { "cache-control": "private, no-store" } });
}
