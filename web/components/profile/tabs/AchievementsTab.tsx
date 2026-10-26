"use client";

import Link from "next/link";
import { achievementIconPath, type AchievementView } from "@/lib/achievements";
import { withBase } from "@/lib/base-path";
import { PROFILE_COPY as C } from "@/lib/copy/profile";
import Icon from "@/components/icons/Icon";
import Pager from "../Pager";
import { RarityTag, rarityVars } from "../rarity";

/**
 * Achievements tab: real per-wallet unlocks (V1 set), then one page (12) of achievements; tap → popup.
 * Points / prestige / season-pass progress are not shown: V1 has no points and no season is running (season audit).
 */
export default function AchievementsTab({ rows, unlocked, total, syncing, page, pages, onPage, onOpen, isPrivate, owner }: {
  rows: AchievementView[]; unlocked: number; total: number; syncing?: boolean;
  page: number; pages: number; onPage: (p: number) => void; onOpen: (i: number) => void; isPrivate: boolean; owner: string;
}) {
  return (
    <div className="pf-tab-body" data-testid="tab-achievements">
      <section className="pf-ach-summary">
        <strong>{C["ach.summary"](unlocked, total)}</strong>
        {syncing && <span className="muted" data-testid="ach-syncing">{C["ach.syncing"]}</span>}
      </section>
      {!unlocked && !syncing && <p className="muted">{isPrivate ? C["ach.empty.own"] : C["ach.empty.other"](owner)}</p>}
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
