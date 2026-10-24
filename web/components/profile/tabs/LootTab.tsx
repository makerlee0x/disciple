"use client";

import { achievementIconPath } from "@/lib/achievements";
import { withBase } from "@/lib/base-path";
import { LOOT_SLOTS, type LootPart, type LootSlot } from "@/lib/profileLoot";
import { PROFILE_COPY as C } from "@/lib/copy/profile";
import Icon from "@/components/icons/Icon";
import Pager from "../Pager";
import { RarityTag, rarityVars } from "../rarity";

/** Loot tab: slot filter chips, one page (12) of part tiles; tap a tile → loot popup. Cosmetic-only footnote. */
export default function LootTab({ rows, total, counts, filter, onFilter, page, pages, onPage, onOpen, isPrivate, owner, onSeeAchievements }: {
  rows: LootPart[]; total: number; counts: Record<LootSlot | "all", number>; filter: LootSlot | null; onFilter: (f: LootSlot | null) => void;
  page: number; pages: number; onPage: (p: number) => void; onOpen: (i: number) => void;
  isPrivate: boolean; owner: string; onSeeAchievements: () => void;
}) {
  if (!counts.all) {
    return isPrivate ? (
      <div className="pf-empty">
        <Icon name="gift" size={32} />
        <strong>{C["loot.empty.own.title"]}</strong>
        <p>{C["loot.empty.own.body"]}</p>
        <button type="button" className="ds-btn" onClick={onSeeAchievements}>{C["loot.empty.own.cta"]}</button>
      </div>
    ) : <div className="pf-empty"><Icon name="gift" size={32} /><p>{C["loot.empty.other"](owner)}</p></div>;
  }
  return (
    <div className="pf-tab-body" data-testid="tab-loot">
      <div className="pf-chips-row pf-chips-scroll" role="group">
        <button type="button" className={`pf-chip ${!filter ? "on" : ""}`} aria-pressed={!filter} onClick={() => onFilter(null)}>{C["loot.filter.all"](counts.all)}</button>
        {LOOT_SLOTS.map((s) => (
          <button key={s} type="button" className={`pf-chip ${filter === s ? "on" : ""}`} aria-pressed={filter === s} onClick={() => onFilter(s)}>{C[`loot.slot.${s}`]}</button>
        ))}
      </div>
      {total ? (
        <ul className="pf-loot-grid" data-testid="profile-loot">
          {rows.map((p, i) => {
            const v = rarityVars(p.rarity);
            return (
              <li key={p.id}>
                <button type="button" className="pf-loot-tile" style={{ borderColor: v.color }} aria-haspopup="dialog" onClick={() => onOpen(i)}>
                  <span className="pf-loot-thumb">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={withBase(achievementIconPath(p.from.id))} alt="" width={96} height={96} loading="lazy" decoding="async" />
                  </span>
                  <span className="pf-loot-tile-name">{p.name}</span>
                  <RarityTag rarity={p.rarity} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : <div className="pf-empty"><p>{C["loot.empty.slot"](C[`loot.slot.${filter!}`])}</p></div>}
      <Pager page={page} pages={pages} onPage={onPage} />
      <p className="pf-foot">{C["loot.cosmetic"]}</p>
    </div>
  );
}
