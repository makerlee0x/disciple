export const runtime = "nodejs";
/** GET → { passes: FounderPass[] | null, url }. The 12 Ethereum founder passes from OpenSea (OPENSEA_API_KEY), cached 1 h. */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { founderPasses, type FounderPass } from "@/lib/server/nft/chain";
import { FOUNDER_URL } from "@/lib/nft/config";

export const dynamic = "force-dynamic";
const KEY = "nft:founders";
export async function GET() {
  let passes: FounderPass[] | null = null;
  try {
    const c = await kv().get(KEY);
    const p = c ? (JSON.parse(c) as { at: number; passes: FounderPass[] }) : null;
    if (p && Date.now() - p.at < 3600_000) passes = p.passes;
  } catch { /* recompute */ }
  if (!passes) {
    passes = await founderPasses();
    if (passes?.length) await kv().set(KEY, JSON.stringify({ at: Date.now(), passes })).catch(() => {});
  }
  return NextResponse.json({ passes, url: FOUNDER_URL }, { headers: { "cache-control": "public, max-age=300, s-maxage=300" } });
}
