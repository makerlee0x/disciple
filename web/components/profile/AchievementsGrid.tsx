"use client";

import { useMemo, useState } from "react";
import {
  ACHIEVEMENT_CATEGORIES, evaluateAchievements, type AchievementCategory, type AchievementView,
} from "@/lib/achievements";
import AchievementCard from "./AchievementCard";
import { rarityRank } from "@/lib/config";
import { SAMPLE_DATA_LABEL, buildPersonaStats } from "@/lib/mock/sample-trades";
import { prestigeFromPoints } from "@/lib/prestige";

const STATE_ORDER = { unlocked: 0, in_progress: 1, locked: 2 } as const;

export default function AchievementsGrid() {
  const [cat, setCat] = useState<AchievementCategory | "all">("all");
  const data = useMemo(() => buildPersonaStats("believer"), []);
  const views = useMemo(() => evaluateAchievements(data), [data]);
  const pass = prestigeFromPoints(data.points);
  const [openLocked, setOpenLocked] = useState<Record<string, boolean>>({});
  const unlocked = views.filter((v) => v.state === "unlocked").length;

  const card = (a: AchievementView) => <AchievementCard key={a.id} a={a} />;
  const groups = ACHIEVEMENT_CATEGORIES
    .filter((c) => cat === "all" || c.id === cat)
    .map((c) => {
      const items = views.filter((v) => v.category === c.id).sort((x, y) => STATE_ORDER[x.state] - STATE_ORDER[y.state] || rarityRank(y.rarity) - rarityRank(x.rarity));
      return { ...c, items, active: items.filter((v) => v.state !== "locked"), locked: items.filter((v) => v.state === "locked") };
    })
    .filter((g) => g.items.length);

  return (
    <div className="ach-page">
      <header className="profile-head">
        <div>
          <h1>Achievements</h1>
          <div className="sub">CHOIR OF DEEDS · {unlocked}/{views.length} UNLOCKED</div>
        </div>
      </header>
      <span className="tag mock">{SAMPLE_DATA_LABEL}</span>

      <section className="season-pass">
        <div className="pass-meta">
          <div>
            <div className="pass-name">Prestige {pass.prestige} · {pass.prestigeName}</div>
            <div className="muted">Level {pass.level} / {pass.maxLevel} · max level → next prestige</div>
          </div>
          <div className="pass-xp">{pass.into.toLocaleString()} / {pass.need.toLocaleString()} pts → {pass.nextLabel}</div>
        </div>
        <div className="pass-track">
          <div className="pass-fill" style={{ width: `${(pass.level / pass.maxLevel) * 100}%` }} />
          <div className="pass-markers">
            {[1, 10, 20, 30, 40, 50].map((lv) => (
              <span key={lv} style={{ left: `${(lv / pass.maxLevel) * 100}%` }} className={pass.level >= lv ? "on" : ""}>{lv}</span>
            ))}
          </div>
        </div>
      </section>

      <div className="ach-filters">
        <button type="button" className={cat === "all" ? "on" : ""} onClick={() => setCat("all")}>All</button>
        {ACHIEVEMENT_CATEGORIES.map((c) => (
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
