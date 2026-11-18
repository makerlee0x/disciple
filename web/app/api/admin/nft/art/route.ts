export const runtime = "nodejs";
/**
 * /admin/mint art import (ADMIN_EMAILS). Copies maker's original Disciple files from Google Drive into Vercel Blob
 * (lib/server/nft/art). GET → { blob, imported, base, unmapped } (unmapped: trait values no revealed NFT spells yet;
 * ?traits=1 re-reads them from the chain). POST { numbers: [n…] (≤ 8) } → copies those. Safe to re-run: overwrites in place.
 */
import { NextResponse } from "next/server";
import { authenticateAdmin, bearer, privyEnv } from "@/lib/server/privyAuth";
import { artBase, attributesOf, blobConfigured, importOne, importedNumbers, traitMap } from "@/lib/server/nft/art";
import { DISCIPLE_SUPPLY } from "@/lib/nft/config";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const out = (s: number, b: unknown) => NextResponse.json(b, { status: s, headers: { "cache-control": "no-store" } });

export async function GET(req: Request) {
  const a = await authenticateAdmin(bearer(req.headers), privyEnv(), process.env.ADMIN_EMAILS);
  if (!a.ok) return out(a.status, { error: a.reason });
  const map = await traitMap(new URL(req.url).searchParams.get("traits") === "1");
  const unmapped = new Set<string>();
  for (let n = 0; n < DISCIPLE_SUPPLY; n++) attributesOf(n, map).unmapped.forEach((u) => unmapped.add(u));
  if (!blobConfigured()) return out(200, { blob: false, imported: [], base: null, unmapped: [...unmapped] });
  return out(200, { blob: true, imported: await importedNumbers(), base: await artBase(), unmapped: [...unmapped] });
}

export async function POST(req: Request) {
  const a = await authenticateAdmin(bearer(req.headers), privyEnv(), process.env.ADMIN_EMAILS);
  if (!a.ok) return out(a.status, { error: a.reason });
  if (!blobConfigured()) return out(503, { error: "Vercel Blob isn't connected (BLOB_READ_WRITE_TOKEN)." });
  let b: { numbers?: unknown };
  try { b = await req.json(); } catch { return out(400, { error: "Bad JSON" }); }
  const nums = Array.isArray(b?.numbers) ? b.numbers.map(Number) : [];
  if (!nums.length || nums.length > 8 || nums.some((n) => !Number.isInteger(n) || n < 0 || n >= DISCIPLE_SUPPLY)) return out(400, { error: "numbers: 1-8 disciple numbers" });
  const done: number[] = [], failed: { n: number; error: string }[] = [];
  await Promise.all(nums.map(async (n) => {
    try { await importOne(n); done.push(n); }
    catch (e) { failed.push({ n, error: (e as Error).message.slice(0, 160) }); }
  }));
  return out(200, { done: done.sort((x, y) => x - y), failed });
}
