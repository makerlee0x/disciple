"use client";

import { useMemo, useState } from "react";
import {
  ACHIEVEMENT_CATEGORIES, evaluateAchievements, seasonPassProgress,
  type AchievementCategory, type AchievementView,
} from "@/lib/achievements";
import { ACHIEVEMENT_RARITY } from "@/lib/config";
import { PERSONAS, SAMPLE_DATA_LABEL, buildPersonaStats, type PersonaId } from "@/lib/mock/sample-trades";

function rewardPreview(a: AchievementView) {
  const bits: string[] = [];
  if (a.reward.points) bits.push(`+${a.reward.points} pts`);
  if (a.reward.skin) bits.push(a.reward.skin);
  if (a.reward.trail) bits.push(a.reward.trail);
  if (a.reward.frame) bits.push(a.reward.frame);
  return bits.join(" · ") || "—";
}

export default function AchievementsGrid() {
  const [persona, setPersona] = useState<PersonaId>("believer");
  const [cat, setCat] = useState<AchievementCategory | "all">("all");
  const data = useMemo(() => buildPersonaStats(persona), [persona]);
  const views = useMemo(() => evaluateAchievements(data), [data]);
  const pass = seasonPassProgress(data.points);
  const filtered = views.filter((v) => (cat === "all" ? true : v.category === cat));
  const unlocked = views.filter((v) => v.state === "unlocked").length;

  return (
    <div className="ach-page">
      <header className="profile-head">
        <div>
          <h1>Achievements</h1>
          <div className="sub">CHOIR OF DEEDS · {unlocked}/{views.length} UNLOCKED</div>
        </div>
        <div className="persona-switch" role="tablist" aria-label="Sample persona">
          {(Object.keys(PERSONAS) as PersonaId[]).map((id) => (
            <button key={id} type="button" role="tab" aria-selected={persona === id}
              className={persona === id ? "on" : ""} onClick={() => setPersona(id)}>
              {PERSONAS[id].label}
            </button>
          ))}
        </div>
      </header>
      <span className="tag mock">{SAMPLE_DATA_LABEL}</span>

      <section className="season-pass">
        <div className="pass-meta">
          <div>
            <div className="pass-name">{pass.seasonName}</div>
            <div className="muted">Season pass · Level {pass.level} / {pass.maxLevel}</div>
          </div>
          <div className="pass-xp">{pass.into.toLocaleString()} / {pass.need.toLocaleString()} XP</div>
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
                <div className="ach-icon">{a.state === "locked" ? "🔒" : a.state === "unlocked" ? "🏆" : "✨"}</div>
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
