"use client";

import { useMemo, useState } from "react";
import {
  ACHIEVEMENT_CATEGORIES, achievementIconPath, evaluateAchievements,
  type AchievementCategory, type AchievementView,
} from "@/lib/achievements";
import { ACHIEVEMENT_RARITY } from "@/lib/config";
import { SAMPLE_DATA_LABEL, buildPersonaStats } from "@/lib/mock/sample-trades";
import { prestigeFromPoints } from "@/lib/prestige";
import { withBase } from "@/lib/base-path";

function rewardPreview(a: AchievementView) {
  const bits: string[] = [];
  if (a.reward.points) bits.push(`+${a.reward.points} pts`);
  if (a.reward.skin) bits.push(a.reward.skin);
  if (a.reward.trail) bits.push(a.reward.trail);
  if (a.reward.frame) bits.push(a.reward.frame);
  return bits.join(" · ") || "—";
}

export default function AchievementsGrid() {
  const [cat, setCat] = useState<AchievementCategory | "all">("all");
  const data = useMemo(() => buildPersonaStats("believer"), []);
  const views = useMemo(() => evaluateAchievements(data), [data]);
  const pass = prestigeFromPoints(data.points);
  const filtered = views.filter((v) => (cat === "all" ? true : v.category === cat));
  const unlocked = views.filter((v) => v.state === "unlocked").length;

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

      <div className="ach-grid">
        {filtered.map((a) => {
          const rarity = ACHIEVEMENT_RARITY[a.rarity];
          return (
            <article key={a.id} className={`ach-card state-${a.state}`}
              style={{ borderColor: rarity.border, boxShadow: a.state === "unlocked" ? `0 0 24px ${rarity.glow}` : undefined }}>
              <div className="ach-frame" style={{ borderColor: rarity.border }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="ach-svg" src={withBase(achievementIconPath(a.id))} alt="" width={60} height={60} />
                {a.state === "locked" && <span className="ach-lock" aria-label="locked">🔒</span>}
              </div>
              <div className="ach-body">
                <div className="ach-rarity" style={{ color: rarity.border }}>{rarity.label}</div>
                <h3>{a.name}</h3>
                <p>{a.description}</p>
                <div className="ach-progress">
                  <div className="ach-bar"><div style={{ width: `${a.pct}%`, background: rarity.border }} /></div>
                  <span>{a.current}/{a.target}</span>
                </div>
                <div className="ach-reward">Reward: {rewardPreview(a)}</div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
