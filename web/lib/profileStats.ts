"use client";
/**
 * Real profile stats (lee, Oct 26 2026: no sample data on prod; PnL is public on profiles). The numbers are computed
 * on the server from the wallet's indexed fills (GET /api/profile/stats → lib/server/profileStats, same KV trade
 * index as the share card and trade history), so every visitor sees the same PnL, win rate and bombs dropped.
 * Season points, leaderboard rank and tramps/walls have no real source yet, so they are 0 and every achievement that
 * depends on them is left out (REAL_ACHIEVEMENT_CATEGORIES): nothing can unlock from a placeholder.
 * `next dev` + ?sample=1 swaps in the seeded persona (lib/mock/sample-trades) for local design work only.
 */
import { useEffect, useState } from "react";
import type { StatsTrade } from "@/lib/stats";
import { IS_STATIC_PREVIEW } from "@/lib/base-path";
import { devSample } from "@/lib/devSample";
import { profileStatsFrom, type ProfileStats, type PublicProfileSummary } from "@/lib/profileStatsCore";

export { REAL_ACHIEVEMENT_CATEGORIES, profileStatsFrom, statsTradeOf, type ProfileStats, type PublicProfileSummary } from "@/lib/profileStatsCore";

const isAddr = (a: string | null | undefined): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);

/** The wallet's server-computed summary + its real fills as stats trades. */
export async function loadWalletStats(wallet: string): Promise<{ summary: PublicProfileSummary | null; trades: StatsTrade[] }> {
  const r = await fetch(`/api/profile/stats?wallet=${wallet}`);
  if (!r.ok) throw new Error(`profile stats ${r.status}`);
  const j = await r.json() as { summary?: PublicProfileSummary; trades?: StatsTrade[] };
  return { summary: j.summary ?? null, trades: Array.isArray(j.trades) ? j.trades : [] };
}

type State = { data: ProfileStats; summary: PublicProfileSummary | null; ready: boolean; sample: boolean };

/**
 * Real stats for `wallet`. `ready` is false while loading or with no wallet; callers show "—" until then.
 * `data` is always a valid (all-zero) ProfileStats so the page can render the empty states right away;
 * `summary` is the server's PnL / win rate / bombs dropped (null for the dev sample or a failed read).
 */
export function useProfileStats(wallet: string | null): State {
  const [state, setState] = useState<State>(() => ({ data: profileStatsFrom([], ""), summary: null, ready: false, sample: false }));
  useEffect(() => {
    let alive = true;
    if (process.env.NODE_ENV === "development" && devSample()) { // `next dev` + ?sample=1 only; constant false in production builds
      import("@/lib/mock/sample-trades").then((m) => { if (alive) setState({ data: m.buildPersonaStats("believer"), summary: null, ready: true, sample: true }); }).catch(() => {});
      return () => { alive = false; };
    }
    setState({ data: profileStatsFrom([], ""), summary: null, ready: false, sample: false });
    if (!isAddr(wallet) || IS_STATIC_PREVIEW) return () => { alive = false; };
    loadWalletStats(wallet.toLowerCase())
      .then(({ summary, trades }) => { if (alive) setState({ data: profileStatsFrom(trades, ""), summary, ready: true, sample: false }); })
      .catch((e) => {
        console.warn("[disciple] profile stats: trade index read failed", (e as Error).message);
        if (alive) setState({ data: profileStatsFrom([], ""), summary: null, ready: true, sample: false });
      });
    return () => { alive = false; };
  }, [wallet]);
  return state;
}
