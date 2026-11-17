import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { TURBO_INVITE_COOKIE, TURBO_PASS_COOKIE, turboOpen } from "@/lib/server/turboPass";
import TurboGate from "@/components/turbo/TurboGate";

/** Hidden route: not in the public nav, footer or homepage, and not indexed. Open to everyone (the password is off unless TURBO_GATE=1, lib/server/turboPass.ts); the static preview build has no server, so it skips the gate. */
export const metadata: Metadata = { title: "DISCIPLE", robots: { index: false, follow: false } };

export default async function TurboLayout({ children }: { children: React.ReactNode }) {
  if (process.env.STATIC_PREVIEW === "1") return children;
  const jar = await cookies();
  const ua = (await headers()).get("user-agent");
  if (!turboOpen({ ua, pass: jar.get(TURBO_PASS_COOKIE)?.value, invite: jar.get(TURBO_INVITE_COOKIE)?.value })) return <TurboGate />;
  return children;
}
