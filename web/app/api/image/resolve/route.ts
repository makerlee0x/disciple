/** POST { keys: sha256(imageURI)[] (≤200) } → { map: { key: storedImageId } } for the URIs that passed moderation. */
import { NextResponse } from "next/server";
import { resolveKeys } from "@/lib/server/imageStore";
import { kv } from "@/lib/server/kv";
import { PUBLIC_GET_LIMITS, clientIp, hitLimit } from "@/lib/server/limits";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  // Unauthenticated batch KV reads (≤200 mget/request): cap per IP so shared Upstash can't be amplified.
  const rl = await hitLimit(kv(), `imgresolve:ip:${clientIp(req.headers)}`, PUBLIC_GET_LIMITS.imageResolvePerIp.limit, PUBLIC_GET_LIMITS.imageResolvePerIp.windowSec);
  if (!rl.ok) return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec), "cache-control": "no-store" } });
  const body = (await req.json().catch(() => ({}))) as { keys?: unknown };
  const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string").slice(0, 200) : [];
  const map = await resolveKeys(keys).catch(() => ({}));
  return NextResponse.json({ map }, { headers: { "cache-control": "no-store" } });
}
