"use client";
/**
 * App home feed: the existing Launchpad (sort tabs, pair filter, list/grid), defaulting to the New sort.
 * Lazy-loaded below the trending hero (components/home/HomeFeedLazy). Rockets come only from the same HomeData the hero
 * uses (chain launches + indexed 24h stats, /api/home, refreshed by the hero's poller via the "dsc:home-data" event).
 * No sample rockets in production (lee, Oct 26 2026). `next dev` + ?sample=1 appends dev-only sample rows (lib/devSample).
 * With no rockets the feed renders nothing: the hero carries the one empty state ("No rockets yet" + "Launch the first one").
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { LAUNCHPAD_DEFAULT_FILTER } from "@/lib/config";
import { withBase } from "@/lib/base-path";
import type { Rocket } from "@/lib/launchpad";
import { devSample } from "@/lib/devSample";
import type { HomeCoin, HomeData } from "@/lib/home/trending";
import Launchpad from "@/components/launchpad/Launchpad";

function liveRocket(x: HomeCoin): Rocket {
  const s = x.stats;
  return {
    id: x.token, name: x.name, tk: x.ticker, live: true, mcap: x.mcapUsd, chg: s?.chg24 ?? null, c: "#E8EAEE",
    icon: /^https?:|^data:|^\//.test(x.icon) ? x.icon : undefined,
    pair: x.pair, pairSym: x.pairSym, creator: x.creator, creatorAddr: x.creatorAddr, graduated: x.graduated, progressBps: x.progressBps, born: x.block,
    stats: {
      volume24hUsd: s?.vol24 ?? 0,
      ageHours: x.launchedAt ? Math.max(0, (Date.now() - x.launchedAt) / 36e5) : 0,
      holders: s?.crew ?? 1,
      liquidityUsd: 0,
    },
  };
}

/** Coin-page link for a feed card (dev sample rows have no coin page, so they don't navigate). */
export function coinHref(c: { id: string; icon?: string; pairSym?: string; name: string; tk: string }) {
  const q = new URLSearchParams();
  q.set("coin", c.id);
  q.set("launched", "1");
  if (c.icon) q.set("icon", c.icon);
  if (c.pairSym) q.set("pair", c.pairSym);
  q.set("nm", c.name);
  q.set("cs", c.tk);
  return `/coin/${c.id}?${q.toString()}`;
}

export default function HomeFeed({ initial }: { initial: HomeCoin[] }) {
  const router = useRouter();
  const [live, setLive] = useState<Rocket[]>(() => initial.map(liveRocket));
  const [dev, setDev] = useState<Rocket[]>([]);

  useEffect(() => {
    const h = (e: Event) => setLive((e as CustomEvent<HomeData>).detail.coins.map(liveRocket));
    window.addEventListener("dsc:home-data", h);
    return () => window.removeEventListener("dsc:home-data", h);
  }, []);

  useEffect(() => {
    // inline NODE_ENV check (not an early return) so webpack drops the import() and never emits the mock chunk in prod
    if (process.env.NODE_ENV === "development" && devSample()) import("@/lib/mock/launchpad").then((m) => setDev(m.sampleRockets(600, withBase))).catch(() => {});
  }, []);

  const all = useMemo(() => [...live, ...dev], [live, dev]);
  const pick = useCallback((c: Rocket) => { if (c.live) router.push(coinHref(c)); }, [router]);

  if (!all.length) return null;
  return (
    <Launchpad coins={all} onPick={pick} defaultVerified={LAUNCHPAD_DEFAULT_FILTER} defaultTab="new" defaultView="grid" showTrending={false} />
  );
}
