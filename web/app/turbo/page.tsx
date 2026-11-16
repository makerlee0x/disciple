import { redirect } from "next/navigation";

/**
 * /turbo: the solo Turbo run is archived (maker 2026-11-16: "there is no solo turbo mode anymore. only duels and royale").
 * Old links land on Trading Duel, query kept (?turbo=1 still turns Turbo on for this device). The solo screen's code
 * (components/turbo/TurboScreen and friends) stays in the repo but nothing routes to it.
 */
export default async function TurboPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) for (const x of Array.isArray(v) ? v : v != null ? [v] : []) q.append(k, x);
  const qs = q.toString();
  redirect(`/turbo/duel${qs ? `?${qs}` : ""}`);
}
