"use client";
/**
 * App home feed: the existing Launchpad (sort tabs, pair filter, list/grid), defaulting to the New sort.
 * Lazy-loaded below the trending hero (components/home/HomeFeedLazy). LIVE rockets come from the same HomeData the hero
 * uses (chain launches + indexed 24h stats, /api/home, refreshed by the hero's poller via the "dsc:home-data" event);
 * the hand-made + generated SAMPLE rockets and the AI/WETH demo pool are unchanged from the previous home page.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CHAIN, DEMO_POOL, LAUNCHPAD_DEFAULT_FILTER } from "@/lib/config";
import { withBase } from "@/lib/base-path";
import { sampleRockets, type Rocket } from "@/lib/launchpad";
import { SAYLOR_SQUARE } from "@/lib/pairArt";
import type { HomeCoin, HomeData } from "@/lib/home/trending";
import Launchpad from "@/components/launchpad/Launchpad";

const SEED: Rocket[] = [
  {
    id: DEMO_POOL.address,
    name: "Artificial Inu",
    tk: "AI",
    icon: "https://cdn.dexscreener.com/cms/images/U6RIzs8Fm7Jar6GE?width=256&height=256&quality=95&format=png",
    live: true,
    mcap: null,
    chg: null,
    c: "#C9CED6",
    pair: "OTHER",
    pairSym: "ETH",
    creator: "Robinhood pool",
    stats: { volume24hUsd: 42_000, ageHours: 900, holders: 640, liquidityUsd: 60_000 },
  },
  {
    // Hero SAMPLE: SAYLOR paired with STRATEGY — kept at the top of Altitude + Trending.
    id: "sample-saylor",
    name: "Saylor",
    tk: "SAYLOR",
    icon: withBase(SAYLOR_SQUARE),
    mcap: 2.4e6,
    chg: 21.0,
    c: "#C9CED6",
    pair: "STRATEGY",
    pairSym: "STRATEGY",
    creator: "GildedQuietOwl",
    graduated: true,
    seed: 4242,
    stats: { volume24hUsd: 61_000, ageHours: 300, holders: 1_480, liquidityUsd: 240_000 },
  },
  {
    id: "sample-halo",
    name: "Halo Dog",
    tk: "HALO",
    icon: withBase("/test-icons/wide.png"),
    mcap: 9.2e3,
    chg: -6.1,
    c: "#ffd0e0",
    pair: "USDG",
    pairSym: "USDG",
    stats: { volume24hUsd: 800, ageHours: 5, holders: 22, liquidityUsd: 1_200 },
  },
  {
    id: "sample-limbo",
    name: "Limbo Cat",
    tk: "LIMBO",
    icon: withBase("/test-icons/transparent.png"),
    mcap: 14.8e3,
    chg: -12.7,
    c: "#e3d6ff",
    pair: "OTHER",
    pairSym: "ETH",
    stats: { volume24hUsd: 3_100, ageHours: 30, holders: 61, liquidityUsd: 2_900 },
  },
  {
    id: "sample-choir",
    name: "Choir of Frogs",
    tk: "CHOIR",
    icon: withBase("/assets/tier4.webp"), // same plate as WebP (197 KB vs 852 KB PNG)
    mcap: 21.4e3,
    chg: 42.0,
    c: "#c9f5df",
    pair: "OTHER",
    pairSym: "PONS",
    stats: { volume24hUsd: 18_000, ageHours: 40, holders: 140, liquidityUsd: 7_400 },
  },
  {
    id: "sample-seraph",
    name: "Seraph Coin",
    tk: "SRPH",
    mcap: 28.6e3,
    chg: 18.4,
    c: "#C9CED6",
    pair: "OTHER",
    pairSym: "NVDA",
    stats: { volume24hUsd: 6_000, ageHours: 12, holders: 95, liquidityUsd: 6_100 },
  },
  {
    id: "sample-pearly",
    name: "Pearly Gates",
    tk: "GATE",
    mcap: 41.0e3,
    chg: 3.2,
    c: "#E8EAEE",
    pair: "STRATEGY",
    pairSym: "STRATEGY",
    stats: { volume24hUsd: 25_000, ageHours: 80, holders: 220, liquidityUsd: 12_000 },
  },
];

/** Hand-made SAMPLE cards + generated SAMPLE rockets so the launchpad is exercised at 500+ items. */
const SAMPLE: Rocket[] = [...SEED, ...sampleRockets(600, withBase)];

const RPC = CHAIN.rpcUrl;
const AI_POOL = DEMO_POOL.address;

function liveRocket(x: HomeCoin): Rocket {
  const s = x.stats;
  return {
    id: x.token, name: x.name, tk: x.ticker, live: true, mcap: x.mcapUsd, chg: s?.chg24 ?? null, c: "#E8EAEE",
    icon: /^https?:|^data:|^\//.test(x.icon) ? x.icon : undefined,
    pair: x.pair, pairSym: x.pairSym, creator: x.creator, graduated: x.graduated, progressBps: x.progressBps, born: x.block,
    stats: {
      volume24hUsd: s?.vol24 ?? 0,
      ageHours: x.launchedAt ? Math.max(0, (Date.now() - x.launchedAt) / 36e5) : 0,
      holders: s?.crew ?? 1,
      liquidityUsd: 0,
    },
  };
}

/** Same coin-page link the previous home built on pick (minus the rooftop launch animation, retired with it). */
export function coinHref(c: { id: string; live?: boolean; icon?: string; pairSym?: string; name: string; tk: string }) {
  const q = new URLSearchParams();
  q.set("coin", c.live ? c.id : AI_POOL);
  if (!c.live) q.set("replay", "1");
  q.set("launched", "1");
  if (c.icon) q.set("icon", c.icon);
  if (c.pairSym) q.set("pair", c.pairSym);
  q.set("nm", c.name);
  q.set("cs", c.tk);
  return `/coin/${c.live ? c.id : AI_POOL}?${q.toString()}`;
}

export default function HomeFeed({ initial }: { initial: HomeCoin[] }) {
  const router = useRouter();
  const [live, setLive] = useState<Rocket[]>(() => initial.map(liveRocket));
  const [coins, setCoins] = useState<Rocket[]>(SAMPLE);

  useEffect(() => {
    const h = (e: Event) => setLive((e as CustomEvent<HomeData>).detail.coins.map(liveRocket));
    window.addEventListener("dsc:home-data", h);
    return () => window.removeEventListener("dsc:home-data", h);
  }, []);

  // Live AI/WETH mcap from RPC slot0
  useEffect(() => {
    let alive = true;
    async function live() {
      const next = [...SAMPLE];
      const ai = { ...next[0] };
      try {
        const r = await fetch(RPC, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [{ to: AI_POOL, data: "0x3850c7bd" }, "latest"],
          }),
        });
        const j = await r.json();
        const s = Number(BigInt("0x" + j.result.slice(2, 66))) / 2 ** 96;
        let ethUsd = 2400;
        let supply = 1e9;
        try {
          const rep = await fetch(withBase("/replay.json"));
          const R = await rep.json();
          ethUsd = R.ethUsd || ethUsd;
          supply = R.totalSupply || supply;
        } catch {
          /* ignore */
        }
        const priceUsd = ethUsd / (s * s);
        ai.mcap = priceUsd * supply;
      } catch {
        try {
          const rep = await fetch(withBase("/replay.json"));
          const R = await rep.json();
          const sw = R.swaps || [];
          const last = sw[sw.length - 1];
          if (last?.price) ai.mcap = last.price * (R.totalSupply || 1e9);
        } catch {
          /* ignore */
        }
      }
      try {
        const d = await (
          await fetch(
            "https://api.dexscreener.com/latest/dex/pairs/robinhood/" + AI_POOL,
          )
        ).json();
        const p = (d.pairs || [d.pair])[0];
        if (p?.priceChange?.h24 != null) ai.chg = +p.priceChange.h24;
      } catch {
        /* ignore */
      }
      next[0] = ai;
      if (alive) setCoins((cs) => cs.map((c) => (c.id === next[0].id ? next[0] : c)));
    }
    live();
    const iv = setInterval(live, 15000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  const all = useMemo(
    () => [...live, ...coins.filter((c) => !live.some((l) => l.id.toLowerCase() === c.id.toLowerCase()))],
    [live, coins],
  );
  const pick = useCallback((c: Rocket) => router.push(coinHref(c)), [router]);

  return (
    <Launchpad coins={all} onPick={pick} defaultVerified={LAUNCHPAD_DEFAULT_FILTER} defaultTab="new" defaultView="grid" showTrending={false} />
  );
}
