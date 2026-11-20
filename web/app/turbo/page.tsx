import type { Metadata } from "next";
import { redirect } from "next/navigation";
import TurboPage from "@/components/turbo/page/TurboPage";

export const metadata: Metadata = { title: "Turbo · DISCIPLE", robots: { index: false, follow: false } };

/**
 * /turbo: the Turbo page (maker 2026-11-20: "we need a turbo page. so no more dropdown"), the pilot's trading dashboard
 * with Duel and Climb to start from (components/turbo/page). Old links that carried a query (?turbo=1, invite params)
 * still land on Trading Duel, query kept, as they did when /turbo only redirected.
 */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) for (const x of Array.isArray(v) ? v : v != null ? [v] : []) q.append(k, x);
  const qs = q.toString();
  if (qs) redirect(`/turbo/duel?${qs}`);
  return <TurboPage />;
}
