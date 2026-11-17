import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { TURBO_INVITE_COOKIE, TURBO_PASS_COOKIE, turboOpen } from "@/lib/server/turboPass";
import TurboGate from "@/components/turbo/TurboGate";

/** /duel: the duel-only demo page (maker 2026-11-16, for the Nova team). Just Trading Duel, none of the site's nav or chrome
 *  (AppShell draws nothing else here). Open like Turbo (no password unless TURBO_GATE=1). Not indexed. */
export const metadata: Metadata = { title: "Trading Duel · DISCIPLE", robots: { index: false, follow: false } };

export default async function DuelOnlyLayout({ children }: { children: React.ReactNode }) {
  if (process.env.STATIC_PREVIEW === "1") return children;
  const jar = await cookies();
  const ua = (await headers()).get("user-agent");
  if (!turboOpen({ ua, pass: jar.get(TURBO_PASS_COOKIE)?.value, invite: jar.get(TURBO_INVITE_COOKIE)?.value })) return <TurboGate duelOnly />;
  return children;
}
