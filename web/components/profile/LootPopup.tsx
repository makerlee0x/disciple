"use client";

import { useEffect, useState } from "react";
import { ACHIEVEMENT_CATEGORIES, achievementIconPath, rewardPreview, type AchievementView } from "@/lib/achievements";
import type { LootPart } from "@/lib/profileLoot";
import { withBase } from "@/lib/base-path";
import { PROFILE_COPY as C } from "@/lib/copy/profile";
import Icon from "@/components/icons/Icon";
import Sheet from "./Sheet";
import { RarityPips, rarityVars } from "./rarity";

export type LootItem = { kind: "part"; part: LootPart } | { kind: "ach"; a: AchievementView };
export const lootItemId = (i: LootItem) => (i.kind === "part" ? i.part.id : i.a.id);

/**
 * Loot popup: a part (or an achievement) with its rarity as colour + label + pips. 720px modal on desktop, bottom
 * sheet on mobile (Sheet). Desktop steps through the current page with ‹ › and ← / →. View-only: no equip yet.
 */
export default function LootPopup({ items, index, onIndex, onClose }: {
  items: LootItem[]; index: number | null; onIndex: (i: number) => void; onClose: () => void;
}) {
  const item = index == null ? null : items[index] ?? null;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (index == null) return;
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input,textarea,select")) return;
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      if (e.key === "ArrowRight" && index < items.length - 1) onIndex(index + 1);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [index, items.length, onIndex]);
  useEffect(() => setCopied(false), [index]);
  if (!item || index == null) return null;

  const a = item.kind === "part" ? item.part.from : item.a;
  const rarity = item.kind === "part" ? item.part.rarity : item.a.rarity;
  const v = rarityVars(rarity);
  const slot = item.kind === "part" ? C[`loot.slot.${item.part.slot}`] : ACHIEVEMENT_CATEGORIES.find((c) => c.id === item.a.category)?.label ?? "";
  const name = item.kind === "part" ? item.part.name : item.a.name;
  const share = () => {
    try { navigator.clipboard?.writeText(window.location.href); setCopied(true); } catch { /* no clipboard */ }
  };

  return (
    <Sheet open onClose={onClose} label={name} className="pf-loot-sheet" testId="loot-popup">
      <div className="pf-loot-pop">
        <div className="pf-loot-art-col">
          <div className="pf-loot-stage" style={{ borderColor: v.color, boxShadow: `0 0 32px ${v.glow}` }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={withBase(achievementIconPath(a.id))} alt="" width={200} height={200} decoding="async" />
            {item.kind === "ach" && item.a.state === "locked" && <span className="ach-lock" aria-label="locked"><Icon name="lock" size={18} /></span>}
          </div>
          {items.length > 1 && (
            <div className="pf-loot-step">
              <button type="button" className="ds-btn pf-icon-btn" aria-label={C["loot.popup.prev.aria"]} disabled={index <= 0} onClick={() => onIndex(index - 1)}><Icon name="chevron-left" size={16} /></button>
              <span className="pf-mono">{C["loot.popup.position"](index + 1, items.length)}</span>
              <button type="button" className="ds-btn pf-icon-btn" aria-label={C["loot.popup.next.aria"]} disabled={index >= items.length - 1} onClick={() => onIndex(index + 1)}><Icon name="chevron-right" size={16} /></button>
            </div>
          )}
        </div>
        <div className="pf-loot-info">
          <div className="pf-loot-eyebrow-row">
            <span className={`pf-loot-eyebrow rarity-${v.label.toLowerCase()}`} style={{ color: v.color }}>
              <RarityPips rarity={rarity} /> {C["loot.popup.eyebrow"](v.label, slot)}
            </span>
            <button type="button" className="ds-btn pf-icon-btn" aria-label={C["loot.popup.close.aria"]} onClick={onClose}><Icon name="close" size={16} /></button>
          </div>
          <h2 className="pf-loot-name">{name}</h2>
          {item.kind === "ach" ? (
            <>
              <p className="pf-loot-flavour">{a.description}</p>
              <div className="ach-progress">
                <div className="ach-bar"><div style={{ width: `${a.pct}%`, background: v.color }} /></div>
                <span>{a.current}/{a.target}</span>
              </div>
              <div className="ach-reward">Reward: {rewardPreview(a)}</div>
            </>
          ) : (
            <p className="pf-loot-source"><Icon name="achievement" size={14} /> {C["loot.popup.source.achievement"](a.name)}</p>
          )}
          <div className="pf-loot-actions">
            <button type="button" className="ds-btn pf-icon-btn" aria-label={C["loot.popup.share.aria"]} onClick={share}><Icon name="share" size={16} /></button>
            {copied && <span className="muted tiny" role="status">Copied</span>}
          </div>
        </div>
      </div>
    </Sheet>
  );
}
