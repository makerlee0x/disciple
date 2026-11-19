import type { Metadata } from "next";
import PublicProfile from "./PublicProfile";
import { cardMeta } from "@/lib/ogMeta";

// Rendered per request (like /vs and /d). generateMetadata reads ?card=points, and on an on-demand static route reading
// searchParams throws "changed from static to dynamic at runtime", so every /u/<name> was a 500 (maker 2026-11-18).
export const dynamic = "force-dynamic";

/**
 * The server build renders any username on demand. `output: 'export'` (STATIC_PREVIEW=1) needs at least one
 * pre-rendered path, so the static preview gets a single placeholder slug; no sample pilots are pre-rendered.
 */
export function generateStaticParams() {
  return process.env.STATIC_PREVIEW === "1" ? [{ username: "pilot" }] : [];
}

/** The pilot's link preview (step 7): handle + level, card from /api/og/pilot. */
export async function generateMetadata({ params, searchParams }: { params: Promise<{ username: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<Metadata> {
  const { username } = await params;
  if (process.env.STATIC_PREVIEW === "1") return {};
  // a shared points card (/u/<name>?card=points) unfurls to that card (maker 2026-11-18)
  if ((await searchParams).card === "points") {
    const { pointsInfo } = await import("@/lib/server/og/data");
    const p = await pointsInfo(decodeURIComponent(username)).catch(() => null);
    if (p) return cardMeta(`@${p.handle} · ${p.pts.toLocaleString("en-US")} points · DISCIPLE`, `Rank #${p.rank.toLocaleString("en-US")}`, `/api/og/points?u=${encodeURIComponent(p.handle)}`, `@${p.handle} on DISCIPLE`);
  }
  const { pilotInfo } = await import("@/lib/server/og/data");
  const p = await pilotInfo(decodeURIComponent(username)).catch(() => null);
  if (!p) return {};
  const title = p.level != null ? `@${p.handle} · Level ${p.level} pilot · DISCIPLE` : `@${p.handle} · DISCIPLE`;
  const line = p.trophies ? `${p.trophies} ${p.trophies === 1 ? "trophy" : "trophies"}. See their hangar.` : "See their hangar.";
  return cardMeta(title, line, `/api/og/pilot?u=${encodeURIComponent(p.handle)}`, `@${p.handle} on DISCIPLE`);
}

export default async function Page({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  return <PublicProfile username={decodeURIComponent(username)} />;
}
