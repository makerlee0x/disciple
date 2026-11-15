import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { TURBO_INVITE_COOKIE, TURBO_PASS_COOKIE, turboOpen } from "@/lib/server/turboPass";
import TurboGate from "@/components/turbo/TurboGate";

/** Hidden route: not in the public nav, footer or homepage, and not indexed. Behind a password (lib/server/turboPass.ts; the iPhone app and friend invite links skip it)
 *  until launch; the static preview build has no server, so it skips the gate. */
export const metadata: Metadata = { title: "DISCIPLE", robots: { index: false, follow: false } };

export default async function TurboLayout({ children }: { children: React.ReactNode }) {
  if (process.env.STATIC_PREVIEW === "1") return children;
  const jar = await cookies();
  const ua = (await headers()).get("user-agent");
  if (!turboOpen({ ua, pass: jar.get(TURBO_PASS_COOKIE)?.value, invite: jar.get(TURBO_INVITE_COOKIE)?.value })) return <TurboGate />;
  return children;
}
