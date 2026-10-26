/**
 * Profile stats from indexed trades (pure: no React, no fetch), shared by the server route
 * (app/api/profile/stats) and the client hook (lib/profileStats). lee, Oct 26 2026: PnL is public on profiles,
 * so every player's realized PnL, win rate and bombs dropped come from the KV trade index, not from the
 * per-browser PnlHud ledger (lib/pnl.ts is GAME's and is not used here).
 *
 * Bombs dropped (agreed with GAME, Oct 26 2026): every sell by the wallet whose price impact is at or above the
 * lowest bomb tier, the grenade (BOMB_PCT.GRENADE = 2% = 200 bps). Each sell counts once, whatever its tier.
 * Note: in lib/config BOMB_TIERS[0] is PUFF (min 0) and BOMB_TIERS[1] is GRENADE, so the threshold is read from
 * BOMB_PCT.GRENADE by name, never by index. lib/config mirrors public/flight/engine.js (lib/flight/bombTier.ts too;
 * test:gamechat checks that parity), so an engine change to the grenade threshold must land in lib/config as well.
 *
 * impactBps per fill: the trade index does not store it yet (site/achievements-server adds it). Until it lands we
 * estimate it from the fill's own pre/post price (lib/home/trending prePriceOf); a fill whose pre-price can't be
 * derived counts as 0 impact (never a bomb). Once `impactBps` is on the fill it is used as is.
 */
import type { Address } from "viem";
import { computeStats, type PlayerStats, type StatsTrade } from "@/lib/stats";
import { deriveIdentity, type DerivedIdentity } from "@/lib/identity";
import { evaluateAchievements, topBadgesFromAchievements, type AchievementCategory, type AchievementView } from "@/lib/achievements";
import { BOMB_PCT } from "@/lib/config";
import { playerUsd, type Fill } from "@/lib/trades";
import { prePriceOf } from "@/lib/home/trending";

export type ProfileStats = PlayerStats & { identity: DerivedIdentity; achievements: AchievementView[] };

/** Achievement categories whose progress comes only from real fills. Seasonal (points / rank) and Tramps & Walls are out until they have a source. */
export const REAL_ACHIEVEMENT_CATEGORIES: ReadonlySet<AchievementCategory> = new Set(["flight", "crew", "bombs", "conviction", "launcher", "trencher"]);

/** Lowest bomb tier (grenade) in basis points. A sell at or above this is one bomb dropped. */
export const BOMB_MIN_IMPACT_BPS = BOMB_PCT.GRENADE * 100;

type FillWithImpact = Fill & { impactBps?: number };

/** Price impact of one fill in bps: the indexed value when present (site/achievements-server), else estimated from pre/post price. */
export function impactBpsOf(f: FillWithImpact): number {
  if (typeof f.impactBps === "number" && Number.isFinite(f.impactBps)) return Math.abs(f.impactBps);
  const after = f.priceUsd > 0 ? f.priceUsd : 0;
  const before = prePriceOf(f);
  return before && before > 0 && after > 0 ? Math.abs(after / before - 1) * 1e4 : 0;
}

/** One indexed fill → the stats engine's trade shape (player-side $, price before/after, impact, mcap after). */
export function statsTradeOf(f: FillWithImpact, meta: { ticker: string; name: string }): StatsTrade {
  const after = f.priceUsd > 0 ? f.priceUsd : 0;
  const before = prePriceOf(f) ?? after;
  const usd = playerUsd(f) || (Number.isFinite(f.usd) && f.usd > 0 ? f.usd : 0);
  return {
    token: f.coin.toLowerCase() as Address, ticker: meta.ticker, name: meta.name, side: f.side, usd,
    priceBefore: before, priceAfter: after, impactBps: impactBpsOf(f), mcapAfter: f.mcapUsd || 0, ts: f.ts,
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

/** The three public profile numbers. `closedTrades` 0 ⇒ win rate has no meaning (show "—"). */
export interface PublicProfileSummary {
  realizedPnlUsd: number;
  winRate: number;
  closedTrades: number;
  bombsDropped: number;
  trades: number;
  /** "indexed" once every sell carries impactBps from the index, else "estimated" (pre/post price). */
  impactSource: "indexed" | "estimated";
}

export function publicSummaryOf(trades: StatsTrade[], fills: FillWithImpact[]): PublicProfileSummary {
  const s = profileStatsFrom(trades, "");
  const sells = trades.filter((t) => t.side === "sell");
  return {
    realizedPnlUsd: s.metrics.realizedPnl,
    winRate: s.metrics.closedTrades ? (s.kpis.find((k) => k.key === "wr")?.total ?? 0) / 100 : 0,
    closedTrades: s.metrics.closedTrades,
    bombsDropped: sells.filter((t) => t.impactBps >= BOMB_MIN_IMPACT_BPS).length,
    trades: trades.length,
    impactSource: fills.some((f) => f.side === "sell" && typeof f.impactBps !== "number") ? "estimated" : "indexed",
  };
}
