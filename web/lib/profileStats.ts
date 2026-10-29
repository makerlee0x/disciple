"use client";
/**
 * Real profile stats (lee, Oct 26 2026: no sample data on prod). Everything comes from the wallet's indexed fills
 * (/api/trades, the same KV trade index the share card and the trade history use) run through lib/stats computeStats.
 * Season points, leaderboard rank and tramps/walls have no real source yet, so they are 0 and every achievement that
 * depends on them is left out (REAL_ACHIEVEMENT_CATEGORIES): nothing can unlock from a placeholder.
 * `next dev` + ?sample=1 swaps in the seeded persona (lib/mock/sample-trades) for local design work only.
 */
import { useEffect, useState } from "react";
import { parseAbi, type Address } from "viem";
import { computeStats, type PlayerStats, type StatsTrade } from "@/lib/stats";
import { deriveIdentity, type DerivedIdentity } from "@/lib/identity";
import { evaluateAchievements, topBadgesFromAchievements, type AchievementCategory, type AchievementView } from "@/lib/achievements";
import { playerUsd, type Fill } from "@/lib/trades";
import { prePriceOf } from "@/lib/home/trending";
import { publicClient } from "@/lib/protocol-viem";
import { IS_STATIC_PREVIEW } from "@/lib/base-path";
import { devSample } from "@/lib/devSample";

export type ProfileStats = PlayerStats & { identity: DerivedIdentity; achievements: AchievementView[] };

/** Achievement categories whose progress comes only from real fills. Seasonal (points / rank) and Tramps & Walls are out until they have a source. */
export const REAL_ACHIEVEMENT_CATEGORIES: ReadonlySet<AchievementCategory> = new Set(["flight", "crew", "bombs", "conviction", "launcher", "trencher"]);

const MAX_COINS = 40;
const isAddr = (a: string | null | undefined): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);
const erc20 = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)"]);

/** One indexed fill → the stats engine's trade shape (player-side $, price before/after, impact, mcap after). */
export function statsTradeOf(f: Fill, meta: { ticker: string; name: string }): StatsTrade {
  const after = f.priceUsd > 0 ? f.priceUsd : 0;
  const before = prePriceOf(f) ?? after;
  const usd = playerUsd(f) || (Number.isFinite(f.usd) && f.usd > 0 ? f.usd : 0);
  const impactBps = before > 0 && after > 0 ? Math.abs(after / before - 1) * 1e4 : 0;
  return {
    token: f.coin.toLowerCase() as Address, ticker: meta.ticker, name: meta.name, side: f.side, usd,
    priceBefore: before, priceAfter: after, impactBps, mcapAfter: f.mcapUsd || 0, ts: f.ts,
    launchTs: 0, // launch time unknown here: never counts a buy as a snipe
    graduated: f.venue === "hook", txHash: f.tx, block: f.block,
  };
}

/** Stats from real trades only: no points, no rank, achievements limited to fill-based categories. */
export function profileStatsFrom(trades: StatsTrade[], handle: string, now = Date.now()): ProfileStats {
  const stats = computeStats([...trades].sort((a, b) => a.ts - b.ts), {
    handle, persona: "", points: 0, leaderboardRank: 0, leaderboardSize: 0, firstPlacePoints: 0, now, showcaseIcon: null,
  });
  const achievements = evaluateAchievements(stats).filter((a) => REAL_ACHIEVEMENT_CATEGORIES.has(a.category));
  stats.topBadges = topBadgesFromAchievements(achievements, 3);
  return { ...stats, identity: deriveIdentity(stats.metrics), achievements };
}

async function coinMeta(coin: string): Promise<{ ticker: string; name: string }> {
  const pc = publicClient();
  const [sym, nm] = await Promise.all([
    pc.readContract({ address: coin as Address, abi: erc20, functionName: "symbol" }).catch(() => ""),
    pc.readContract({ address: coin as Address, abi: erc20, functionName: "name" }).catch(() => ""),
  ]);
  const ticker = String(sym || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || coin.slice(2, 6).toUpperCase();
  return { ticker, name: String(nm || "").slice(0, 40) || `${coin.slice(0, 6)}…${coin.slice(-4)}` };
}

/** The wallet's real fills across every coin it traded, as stats trades. */
export async function loadWalletTrades(wallet: string): Promise<StatsTrade[]> {
  const j = await fetch(`/api/trades?wallet=${wallet}`).then((r) => (r.ok ? r.json() : { coins: [] })) as { coins?: string[] };
  const coins = (j.coins ?? []).filter(isAddr).slice(0, MAX_COINS);
  const per = await Promise.all(coins.map(async (c) => {
    const [fj, meta] = await Promise.all([
      fetch(`/api/trades?coin=${c}&wallet=${wallet}&limit=5000`).then((r) => (r.ok ? r.json() : { fills: [] })).catch(() => ({ fills: [] })) as Promise<{ fills?: Fill[] }>,
      coinMeta(c),
    ]);
    return (fj.fills ?? []).map((f) => statsTradeOf(f, meta));
  }));
  return per.flat();
}

/**
 * Real stats for `wallet`. `ready` is false while loading or with no wallet; callers show "—" until then.
 * `data` is always a valid (all-zero) ProfileStats so the page can render the empty states right away.
 */
export function useProfileStats(wallet: string | null): { data: ProfileStats; ready: boolean; sample: boolean } {
  const [state, setState] = useState<{ data: ProfileStats; ready: boolean; sample: boolean }>(() => ({ data: profileStatsFrom([], ""), ready: false, sample: false }));
  useEffect(() => {
    let alive = true;
    if (process.env.NODE_ENV === "development" && devSample()) { // `next dev` + ?sample=1 only; constant false in production builds
      import("@/lib/mock/sample-trades").then((m) => { if (alive) setState({ data: m.buildPersonaStats("believer"), ready: true, sample: true }); }).catch(() => {});
      return () => { alive = false; };
    }
    setState({ data: profileStatsFrom([], ""), ready: false, sample: false });
    if (!isAddr(wallet) || IS_STATIC_PREVIEW) return () => { alive = false; };
    loadWalletTrades(wallet.toLowerCase())
      .then((t) => { if (alive) setState({ data: profileStatsFrom(t, ""), ready: true, sample: false }); })
      .catch((e) => {
        console.warn("[disciple] profile stats: trade index read failed", (e as Error).message);
        if (alive) setState({ data: profileStatsFrom([], ""), ready: true, sample: false });
      });
    return () => { alive = false; };
  }, [wallet]);
  return state;
}
