"use client";
/** /dev/stats: the stats page with sample numbers, for mockup screenshots (next dev only). ?view=public hides own-only parts. */
import { useEffect, useState } from "react";
import StatsView, { type StatsData } from "@/components/stats/StatsView";
import { skinArt, skinId } from "@/lib/collection";
import { blankXp } from "@/lib/xpClient";

const DAY = 86_400_000;
function sample(own: boolean): StatsData {
  const now = Date.now(), x = blankXp(now);
  const prog = (l: typeof x.daily.missions, ps: number[]) => l.map((m, i) => ({ ...m, progress: Math.min(m.target, ps[i] ?? 0), done: (ps[i] ?? 0) >= m.target }));
  return {
    own, name: "Moon Maxi", handle: "@maker", pfp: "", rocketArt: skinArt(skinId("bullet", "neon-circuit")),
    level: { level: 27, prestige: 0, prestigeName: "Cadet", progress: 0.62 },
    season: { n: 1, rank: 12, total: 4210, pts: 1640, league: "gold" },
    lifetime: { pts: 12480, rank: 34 },
    pnlUsd: 4218.55,
    duel: { rank: 41, w: 38, l: 17, streak: 4, peak: 9 },
    climb: { rank: 7, level: 12, clearMs: 102_000 },
    daily: { best: 3, played: 22, today: 18 },
    rockets: { rank: 23, green: 61, red: 29, orbits: 6 },
    career: { winRate: 0.68, trades: 412, bestRocket: { ticker: "$PONS", icon: "/pairs/pons.png", pnlUsd: 1840.2 }, bestTrade: { ticker: "$SHROOM", icon: "/pairs/shroom.png", pct: 812, pnlUsd: 966.4 }, bombs: 14, launched: 3, longestMs: 4 * DAY, totalXp: 18_340 },
    trophies: new Map([["pad_ignition", now - 20 * DAY], ["first_blessing", now - 18 * DAY], ["first_grenade", now - 12 * DAY], ["through_pearly_gates", now - 9 * DAY], ["final_boost", now - 6 * DAY], ["unfumbled", now - 2 * DAY]]),
    orders: { daily: prog(x.daily.missions, [1, 1, 0]), weekly: prog(x.weekly.missions, [6, 0, 0]) },
  };
}

export default function Page() {
  const [own, setOwn] = useState(true);
  useEffect(() => { setOwn(new URLSearchParams(window.location.search).get("view") !== "public"); }, []);
  return <StatsView d={sample(own)} onShare={own ? () => {} : undefined} />;
}
