/**
 * GET /api/og/site | /api/og/rocket?coin=0x… | /api/og/pilot?u=name | /api/og/invite[?from=name]
 * The 1200×630 link preview cards (lib/server/og/card.ts) that X, Discord, iMessage and WhatsApp show. Live numbers are
 * read here, never taken from the query. A rocket or pilot we can't read falls back to the site card.
 */
import { renderOgCard, type OgCard } from "@/lib/server/og/card";
import { inviterName, pilotInfo, rocketIcon, rocketInfo } from "@/lib/server/og/data";
import { kv } from "@/lib/server/kv";
import { PUBLIC_GET_LIMITS, clientIp, hitLimit } from "@/lib/server/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const rl = await hitLimit(kv(), `og:ip:${clientIp(req.headers)}`, PUBLIC_GET_LIMITS.sharePerIp.limit, PUBLIC_GET_LIMITS.sharePerIp.windowSec);
  if (!rl.ok) return new Response("rate limited", { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  const { kind } = await params;
  const q = new URL(req.url).searchParams;
  let card: OgCard = { kind: "site" };
  let maxAge = 86_400;
  try {
    if (kind === "rocket") {
      const coin = q.get("coin") || "";
      const [r, icon] = await Promise.all([rocketInfo(coin), rocketIcon(coin).catch(() => null)]);
      if (r) { card = { kind: "rocket", ...r, icon }; maxAge = 300; }
    } else if (kind === "pilot") {
      const p = await pilotInfo(q.get("u") || "");
      if (p) { card = { kind: "pilot", ...p }; maxAge = 600; }
    } else if (kind === "invite") {
      card = { kind: "invite", from: await inviterName(q.get("from")) };
      maxAge = 3_600;
    }
  } catch (e) {
    console.warn("[disciple] og card data failed", (e as Error).message);
  }
  const png = await renderOgCard(card);
  return new Response(new Uint8Array(png), {
    headers: { "content-type": "image/png", "cache-control": `public, max-age=${Math.min(maxAge, 300)}, s-maxage=${maxAge}, stale-while-revalidate=86400` },
  });
}
