import type { Metadata } from "next";
import PublicProfile from "./PublicProfile";
import { cardMeta } from "@/lib/ogMeta";

/**
 * The server build renders any username on demand. `output: 'export'` (STATIC_PREVIEW=1) needs at least one
 * pre-rendered path, so the static preview gets a single placeholder slug; no sample pilots are pre-rendered.
 */
export function generateStaticParams() {
  return process.env.STATIC_PREVIEW === "1" ? [{ username: "pilot" }] : [];
}

/** The pilot's link preview (step 7): handle + level, card from /api/og/pilot. */
export async function generateMetadata({ params }: { params: Promise<{ username: string }> }): Promise<Metadata> {
  const { username } = await params;
  if (process.env.STATIC_PREVIEW === "1") return {};
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
