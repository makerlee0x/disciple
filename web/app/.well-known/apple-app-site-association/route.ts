/**
 * Universal links for the DISCIPLE iPhone app: https://disciple.vip/... links open the app when it's installed
 * (mobile/ios/App/App/App.entitlements applinks:disciple.vip). Apple fetches this file through its CDN, so a change can
 * take a day to reach phones. Needs APPLE_TEAM_ID (10 characters, Apple Developer → Membership) in Vercel;
 * APNS_BUNDLE_ID overrides the bundle id (default vip.disciple.app). Without a team id the file lists no apps.
 */
import { NextResponse } from "next/server";
import { aasa } from "@/lib/nativeLinks";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(aasa(process.env), { headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" } });
}
