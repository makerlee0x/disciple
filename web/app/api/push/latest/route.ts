/**
 * GET /api/push/latest?ep=<push endpoint>: the newest alert for the device behind that endpoint, read by the service
 * worker (public/push-sw.js) when a payload-less push wakes it. The endpoint is the capability: only the browser that
 * subscribed knows it. Returns { title, body, url } or 404.
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { latestFor } from "@/lib/server/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const rl = await hitLimit(kv(), `pushlatest:ip:${clientIp(req.headers)}`, 60, 60);
  if (!rl.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  const m = await latestFor(new URL(req.url).searchParams.get("ep") || "").catch(() => null);
  if (!m) return NextResponse.json({ error: "none" }, { status: 404, headers: { "cache-control": "no-store" } });
  return NextResponse.json({ title: m.title, body: m.body, url: m.url, id: m.id }, { headers: { "cache-control": "no-store" } });
}
