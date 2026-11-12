"use client";
/**
 * Trophies tab (/achievements): pilot card, today's and this week's missions, then milestones as collectible cards by
 * rarity. Missions and XP come from /api/xp, milestones from /api/achievements (both scored by the cron).
 * Signed out, the missions still show (they're the same for everyone), with no progress.
 */
import { useEffect, useMemo, useState } from "react";
import MissionsPanel from "./MissionsPanel";
import PilotCard from "./PilotCard";
import { V1_RULES } from "@/lib/achievements";
import { achievementIconPath, rarityStyle } from "@/lib/achievements";
import { IS_STATIC_PREVIEW } from "@/lib/base-path";
import { rarityRank } from "@/lib/config";
import { milestoneXp, MILESTONE_COPY } from "@/lib/xp";
import { blankXp, usePilotWallet, useXp } from "@/lib/xpClient";

type Unlock = { id: string; unlockedAt?: number };

export default function TrophiesPage() {
  const wallet = usePilotWallet();
  const { xp } = useXp(wallet);
  const [unlocks, setUnlocks] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    if (!wallet || IS_STATIC_PREVIEW) { setUnlocks(new Map()); return; }
    let live = true;
    fetch(`/api/achievements?wallet=${wallet}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { items?: Unlock[] } | null) => { if (live && j?.items) setUnlocks(new Map(j.items.filter((i) => i.unlockedAt).map((i) => [i.id, i.unlockedAt!]))); })
      .catch(() => {});
    return () => { live = false; };
  }, [wallet]);

  const shown = xp ?? blankXp();
  const milestones = useMemo(() => [...V1_RULES].sort((a, b) => Number(unlocks.has(b.id)) - Number(unlocks.has(a.id)) || rarityRank(a.rarity) - rarityRank(b.rarity)), [unlocks]);
  const earned = milestones.filter((m) => unlocks.has(m.id)).length;

  return (
    <div className="xp-page" data-testid="trophies">
      <header className="xp-page-head">
        <h1 className="dsc3-h1">Trophies</h1>
        <p className="xp-page-sub">Missions pay XP. XP levels you up and unlocks parts in the Rocket Factory.</p>
      </header>
      <div className="xp-page-top">
        {xp ? <PilotCard xp={xp} wallet={wallet} /> : (
          <section className="dsc3-panel xp-pilot xp-pilot-empty">
            <div className="xp-pilot-body">
              <span className="dsc3-h2">Start at level 1</span>
              <p className="xp-page-sub">Sign in and boost a rocket. Your XP and level show up here.</p>
            </div>
          </section>
        )}
        <MissionsPanel xp={shown} weekly title="Today's missions" />
      </div>

      <section className="xp-milestones" aria-label="Milestones">
        <header className="xp-missions-head">
          <h2 className="dsc3-h2">Milestones</h2>
          <span className="xp-reset">{earned} of {milestones.length} earned</span>
        </header>
        <div className="xp-milestone-grid">
          {milestones.map((m) => {
            const got = unlocks.get(m.id);
            const r = rarityStyle(m.rarity);
            const copy = MILESTONE_COPY[m.id] ?? { name: m.name, desc: "" };
            return (
              <article key={m.id} className={`dsc3-tile xp-milestone${got ? " got" : ""}`} style={{ ["--rar" as string]: r.border, ["--rar-glow" as string]: r.glow }} data-testid={`milestone-${m.id}`}>
                <span className="xp-milestone-art" aria-hidden>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={achievementIconPath(m.id)} alt="" width={56} height={56} onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />
                </span>
                <span className="xp-milestone-rar">{r.label}</span>
                <h3 className="xp-milestone-name">{copy.name}</h3>
                <p className="xp-milestone-desc">{copy.desc}</p>
                <span className="xp-milestone-xp">{got ? `Earned ${new Date(got).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : `+${milestoneXp(m.id, m.rarity).toLocaleString("en-US")} XP`}</span>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
