"use client";

import { useEffect, useState } from "react";
import { ACHIEVEMENT_CATEGORIES, type AchievementCategory, type AchievementView } from "@/lib/achievements";
import AchievementCard from "./AchievementCard";
import { rarityRank } from "@/lib/config";
import { onWallet } from "@/lib/wallet";
import { useAchievements } from "@/lib/game/useAchievements";
import { PROFILE_COPY as C } from "@/lib/copy/profile";

const STATE_ORDER = { unlocked: 0, in_progress: 1, locked: 2 } as const;

/**
 * /achievements: the signed-in wallet's real unlocks (GET /api/achievements). V1 set only; no sample persona and no
 * season pass / prestige block (no points in V1, and nothing season-related auto-starts: season-autostart audit).
 */
export default function AchievementsGrid() {
  const [cat, setCat] = useState<AchievementCategory | "all">("all");
  const [wallet, setWallet] = useState<string | null>(null);
  useEffect(() => onWallet((a) => setWallet(a ? a.toLowerCase() : null)), []);
  const { views, unlocked, source, loading } = useAchievements(wallet);
  const [openLocked, setOpenLocked] = useState<Record<string, boolean>>({});
  const cats = ACHIEVEMENT_CATEGORIES.filter((c) => views.some((v) => v.category === c.id));

  const card = (a: AchievementView) => <AchievementCard key={a.id} a={a} />;
  const groups = cats
    .filter((c) => cat === "all" || c.id === cat)
    .map((c) => {
      const items = views.filter((v) => v.category === c.id).sort((x, y) => STATE_ORDER[x.state] - STATE_ORDER[y.state] || rarityRank(y.rarity) - rarityRank(x.rarity));
      return { ...c, items, active: items.filter((v) => v.state !== "locked"), locked: items.filter((v) => v.state === "locked") };
    })
    .filter((g) => g.items.length);

  return (
    <div className="ach-page" data-testid="achievements-grid">
      <header className="profile-head">
        <div>
          <h1>Achievements</h1>
          <div className="sub">CHOIR OF DEEDS · {unlocked}/{views.length} UNLOCKED</div>
        </div>
      </header>
      {!wallet && <p className="muted" data-testid="ach-signin">Sign in (top right) to track your achievements.</p>}
      {wallet && !loading && source === "unavailable" && <p className="muted" data-testid="ach-syncing">{C["ach.syncing"]}</p>}

      <div className="ach-filters">
        <button type="button" className={cat === "all" ? "on" : ""} onClick={() => setCat("all")}>All</button>
        {cats.map((c) => (
          <button key={c.id} type="button" className={cat === c.id ? "on" : ""} onClick={() => setCat(c.id)}>{c.label}</button>
        ))}
      </div>

      <div className="ach-groups">
        {groups.map((g) => {
          const done = g.items.filter((v) => v.state === "unlocked").length;
          const showLocked = cat !== "all" || openLocked[g.id];
          return (
            <section key={g.id} className="ach-group" aria-label={g.label}>
              <header className="ach-group-head">
                <h2>{g.label}</h2>
                <span className="ach-group-count">{done}/{g.items.length}</span>
                <div className="ach-group-bar"><div style={{ width: `${(done / g.items.length) * 100}%` }} /></div>
              </header>
              <div className="ach-grid">
                {g.active.map(card)}
                {showLocked && g.locked.map(card)}
              </div>
              {g.locked.length > 0 && cat === "all" && (
                <button type="button" className="ds-btn ach-more" onClick={() => setOpenLocked((o) => ({ ...o, [g.id]: !o[g.id] }))}>
                  {openLocked[g.id] ? "Hide locked" : `Show ${g.locked.length} locked`}
                </button>
              )}
              {g.active.length === 0 && !showLocked && <p className="muted tiny">Nothing started here yet.</p>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
