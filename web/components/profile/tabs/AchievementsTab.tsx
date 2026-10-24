"use client";

import Link from "next/link";
import { achievementIconPath, type AchievementView } from "@/lib/achievements";
import { withBase } from "@/lib/base-path";
import { PROFILE_COPY as C } from "@/lib/copy/profile";
import { SAMPLE_DATA_LABEL } from "@/lib/mock/sample-trades";
import Icon from "@/components/icons/Icon";
import Pager from "../Pager";
import { RarityTag, rarityVars } from "../rarity";

/** Achievements tab: the only home of points / prestige progress, then one page (12) of achievements; tap → popup. */
export default function AchievementsTab({ rows, unlocked, total, prestige, nextRank, leaderboardRank, page, pages, onPage, onOpen, isPrivate, owner }: {
  rows: AchievementView[]; unlocked: number; total: number;
  prestige: { prestige: number; prestigeName: string; level: number; maxLevel: number; progress: number };
  nextRank: { points: number; label: string } | null; leaderboardRank: number;
  page: number; pages: number; onPage: (p: number) => void; onOpen: (i: number) => void; isPrivate: boolean; owner: string;
}) {
  return (
    <div className="pf-tab-body" data-testid="tab-achievements">
      <section className="pf-ach-summary">
        <strong>{C["ach.summary"](unlocked, total)}</strong>
        <span>{C["ach.prestige"](prestige.prestige, prestige.prestigeName)} · {C["ach.level"](prestige.level, prestige.maxLevel)}</span>
        <div className="xp-bar pf-xp"><div className="xp-fill" style={{ width: `${prestige.progress * 100}%` }} /></div>
        <span className="muted">
          {nextRank ? `${C["ach.nextrank"](nextRank.points.toLocaleString(), nextRank.label)} · ` : ""}{C["ach.leaderboard"](leaderboardRank)}
        </span>
        <span className="tag mock" title={SAMPLE_DATA_LABEL}>{C["profile.sample"]}</span>
      </section>
      {!unlocked && <p className="muted">{isPrivate ? C["ach.empty.own"] : C["ach.empty.other"](owner)}</p>}
      <ul className="pf-ach-grid">
        {rows.map((a, i) => {
          const v = rarityVars(a.rarity);
          return (
            <li key={a.id}>
              <button type="button" className={`pf-ach-tile state-${a.state}`} style={{ borderColor: a.state === "locked" ? undefined : v.color }} aria-haspopup="dialog" onClick={() => onOpen(i)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={withBase(achievementIconPath(a.id))} alt="" width={48} height={48} loading="lazy" decoding="async" />
                <span className="pf-ach-text">
                  <strong>{a.name}</strong>
                  <RarityTag rarity={a.rarity} />
                  <span className="ach-bar"><span style={{ width: `${a.pct}%`, background: v.color }} /></span>
                </span>
                {a.state === "locked" && <Icon name="lock" size={14} />}
              </button>
            </li>
          );
        })}
      </ul>
      <Pager page={page} pages={pages} onPage={onPage} />
      <Link href="/achievements" className="pf-link">{C["ach.seeall"]} ›</Link>
    </div>
  );
}
