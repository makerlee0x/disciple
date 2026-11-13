import type { Metadata } from "next";
import { DEMO_POOL } from "@/lib/config";
import { cardMeta, titleCase } from "@/lib/ogMeta";

/** `output: 'export'` needs one pre-rendered path: the engine demo pool. Sample launchpad cards are gone. */
export function generateStaticParams() {
  return [{ address: DEMO_POOL.address }];
}

/** The rocket's link preview (step 7): title + line from live data, card from /api/og/rocket. */
export async function generateMetadata({ params }: { params: Promise<{ address: string }> }): Promise<Metadata> {
  const { address } = await params;
  if (process.env.STATIC_PREVIEW === "1" || !/^0x[0-9a-fA-F]{40}$/.test(address)) return {};
  const { rocketInfo } = await import("@/lib/server/og/data");
  const { tierName } = await import("@/lib/server/og/card");
  const r = await rocketInfo(address).catch(() => null);
  if (!r) return {};
  const title = `$${r.ticker} · ${r.name} · DISCIPLE`;
  const tier = r.mcapUsd != null ? titleCase(tierName(r.mcapUsd)) : null;
  const line = r.graduated
    ? "Reached orbit. Hop aboard and ride it higher."
    : tier && r.orbitPct != null ? `In ${tier}, ${Math.round(r.orbitPct)}% to orbit. Hop aboard and help boost it.` : "Hop aboard and help boost it to orbit.";
  return cardMeta(title, line, `/api/og/rocket?coin=${address.toLowerCase()}`, `$${r.ticker} on DISCIPLE`);
}

export default function CoinLayout({ children }: { children: React.ReactNode }) {
  return children;
}
