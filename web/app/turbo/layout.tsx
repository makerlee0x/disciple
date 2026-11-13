import type { Metadata } from "next";
import { cookies } from "next/headers";
import { TURBO_PASS_COOKIE, hasTurboPass } from "@/lib/server/turboPass";
import TurboGate from "@/components/turbo/TurboGate";

/** Hidden route: not in the public nav, footer or homepage, and not indexed. Behind a password (lib/server/turboPass.ts)
 *  until launch; the static preview build has no server, so it skips the gate. */
export const metadata: Metadata = { title: "DISCIPLE", robots: { index: false, follow: false } };

export default async function TurboLayout({ children }: { children: React.ReactNode }) {
  if (process.env.STATIC_PREVIEW === "1") return children;
  const pass = (await cookies()).get(TURBO_PASS_COOKIE)?.value;
  if (!hasTurboPass(pass)) return <TurboGate />;
  return children;
}
