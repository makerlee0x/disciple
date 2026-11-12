import type { Metadata } from "next";

/** Hidden route: not in the public nav, footer or homepage, and not indexed. The page itself stays blank until the
 *  Turbo flag is on (lib/turbo/flag.ts: ?turbo=1 on this page, or NEXT_PUBLIC_TURBO=1 at build time — unset everywhere). */
export const metadata: Metadata = { title: "DISCIPLE", robots: { index: false, follow: false } };

export default function TurboLayout({ children }: { children: React.ReactNode }) {
  return children;
}
