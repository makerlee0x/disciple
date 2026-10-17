/** POST { keys: sha256(imageURI)[] (≤200) } → { map: { key: storedImageId } } for the URIs that passed moderation. */
import { NextResponse } from "next/server";
import { resolveKeys } from "@/lib/server/imageStore";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { keys?: unknown };
  const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string").slice(0, 200) : [];
  const map = await resolveKeys(keys).catch(() => ({}));
  return NextResponse.json({ map }, { headers: { "cache-control": "no-store" } });
}
