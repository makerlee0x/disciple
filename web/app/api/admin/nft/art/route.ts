export const runtime = "nodejs";
/**
 * /admin/mint art import (ADMIN_EMAILS). Copies maker's original Disciple files from Google Drive into Vercel Blob
 * (lib/server/nft/art). GET → { blob, imported, base }. POST { numbers: [n…] (≤ 8) } → copies those, returns unmapped
 * trait values (no revealed NFT shows their spelling yet). Safe to re-run: files are overwritten in place.
 */
import { NextResponse } from "next/server";
import { authenticateAdmin, bearer, privyEnv } from "@/lib/server/privyAuth";
import { artBase, blobConfigured, importOne, importedNumbers, traitMap } from "@/lib/server/nft/art";
import { DISCIPLE_SUPPLY } from "@/lib/nft/config";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const out = (s: number, b: unknown) => NextResponse.json(b, { status: s, headers: { "cache-control": "no-store" } });

export async function GET(req: Request) {
  const a = await authenticateAdmin(bearer(req.headers), privyEnv(), process.env.ADMIN_EMAILS);
  if (!a.ok) return out(a.status, { error: a.reason });
  if (!blobConfigured()) return out(200, { blob: false, imported: [], base: null });
  if (new URL(req.url).searchParams.get("traits") === "1") await traitMap(true);
  return out(200, { blob: true, imported: await importedNumbers(), base: await artBase() });
}

export async function POST(req: Request) {
  const a = await authenticateAdmin(bearer(req.headers), privyEnv(), process.env.ADMIN_EMAILS);
  if (!a.ok) return out(a.status, { error: a.reason });
  if (!blobConfigured()) return out(503, { error: "Vercel Blob isn't connected (BLOB_READ_WRITE_TOKEN)." });
  let b: { numbers?: unknown };
  try { b = await req.json(); } catch { return out(400, { error: "Bad JSON" }); }
  const nums = Array.isArray(b?.numbers) ? b.numbers.map(Number) : [];
  if (!nums.length || nums.length > 8 || nums.some((n) => !Number.isInteger(n) || n < 0 || n >= DISCIPLE_SUPPLY)) return out(400, { error: "numbers: 1-8 disciple numbers" });
  const map = await traitMap();
  const done: number[] = [], failed: { n: number; error: string }[] = [], unmapped = new Set<string>();
  await Promise.all(nums.map(async (n) => {
    try { const r = await importOne(n, map); r.unmapped.forEach((u) => unmapped.add(u)); done.push(n); }
    catch (e) { failed.push({ n, error: (e as Error).message.slice(0, 160) }); }
  }));
  return out(200, { done: done.sort((x, y) => x - y), failed, unmapped: [...unmapped] });
}
