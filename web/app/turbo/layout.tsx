import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { TURBO_INVITE_COOKIE, TURBO_PASS_COOKIE, turboOpen } from "@/lib/server/turboPass";
import TurboGate from "@/components/turbo/TurboGate";

/** Turbo: open to everyone (launch prep, maker 2026-11-16). The old early-access password (lib/server/turboPass.ts) comes back
 *  only with TURBO_GATE=1, and then the iPhone app and friend invite links still skip it. The static preview has no server. */
export const metadata: Metadata = {
  title: "Turbo · DISCIPLE",
  description: "1v1 trading duels on live BTC. One minute, most profit wins. Practice free, no sign-up.",
  robots: process.env.TURBO_GATE === "1" ? { index: false, follow: false } : undefined,
};

export default async function TurboLayout({ children }: { children: React.ReactNode }) {
  if (process.env.STATIC_PREVIEW === "1") return children;
  const jar = await cookies();
  const ua = (await headers()).get("user-agent");
  if (!turboOpen({ ua, pass: jar.get(TURBO_PASS_COOKIE)?.value, invite: jar.get(TURBO_INVITE_COOKIE)?.value })) return <TurboGate />;
  return children;
}
