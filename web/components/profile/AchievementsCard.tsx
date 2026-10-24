"use client";

import Link from "next/link";
import { PROFILE_COPY as C } from "@/lib/copy/profile";

/**
 * Profile achievements card (lee 2026-10-24): just the progress bar, tap → /achievements.
 * Shows only what's real: the number of achievements there are. Unlock counts, prestige, points and leaderboard
 * place were SAMPLE numbers, so they're gone until the indexer serves real per-wallet progress; the bar is empty
 * (nothing verified unlocked yet) rather than a made-up fill.
 */
export default function AchievementsCard({ total, unlocked = 0 }: { total: number; unlocked?: number }) {
  const pct = total ? Math.min(1, unlocked / total) : 0;
  return (
    <Link href="/achievements" className="pf-ach-card" data-testid="profile-achievements-card">
      <span className="pf-ach-card-top">
        <strong>{C["profile.tab.achievements"]}</strong>
        <span className="pf-ach-card-cta">{C["ach.seeall"]} →</span>
      </span>
      <div className="xp-bar pf-xp" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={unlocked}>
        <div className="xp-fill" style={{ width: `${pct * 100}%` }} />
      </div>
      <span className="muted">{C["ach.card.total"](total)}</span>
    </Link>
  );
}
