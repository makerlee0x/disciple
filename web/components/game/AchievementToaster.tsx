"use client";
/**
 * Unlock toasts for the signed-in wallet's REAL achievements. Polls SITE's /api/achievements/feed (lib/game/achievementsClient
 * watchUnlocks) and broadcasts window 'disciple:achievement'. Game routes (/coin, /flight): the engine draws the toast on the
 * canvas HUD (public/flight/engine.js @achtoast). Everywhere else: this renders a small DOM toast. ?achtoast=<id> previews one
 * (QA / screenshots; display only, nothing is unlocked or stored).
 */
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { achievementDisplay, achievementIconPath, rarityStyle } from "@/lib/achievements";
import { withBase } from "@/lib/base-path";
import { onWallet } from "@/lib/wallet";
import { isCollapsibleRoute } from "@/components/Sidebar";
import { ACHIEVEMENT_EVENT, dispatchUnlock, unlockFromRow, watchUnlocks, type AchievementUnlock } from "@/lib/game/achievementsClient";

const SHOW_MS = 5000;

export default function AchievementToaster() {
  const pathname = usePathname() || "";
  const inGame = isCollapsibleRoute(pathname);
  const [wallet, setWallet] = useState<string | null>(null);
  const [queue, setQueue] = useState<AchievementUnlock[]>([]);

  useEffect(() => onWallet((a) => setWallet(a ? a.toLowerCase() : null)), []);
  useEffect(() => {
    if (!wallet) return;
    return watchUnlocks(wallet, (row) => {
      const u = unlockFromRow(row, achievementDisplay);
      dispatchUnlock({ ...u, color: rarityStyle(u.rarity)?.border ?? u.color });
    });
  }, [wallet]);
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent<AchievementUnlock>).detail; if (d?.id) setQueue((q) => (q.some((x) => x.id === d.id) ? q : [...q, d])); };
    window.addEventListener(ACHIEVEMENT_EVENT, on);
    return () => window.removeEventListener(ACHIEVEMENT_EVENT, on);
  }, []);
  // QA preview: ?achtoast=nuke_ach (display only).
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("achtoast");
    if (!id) return;
    const t = window.setTimeout(() => {
      const u = unlockFromRow({ id, wallet: wallet || "0x0000000000000000000000000000000000000000", unlockedAt: Date.now() }, achievementDisplay);
      dispatchUnlock({ ...u, color: rarityStyle(u.rarity)?.border ?? u.color });
    }, 600);
    return () => window.clearTimeout(t);
  }, [wallet]);
  const head = queue[0];
  useEffect(() => {
    if (!head) return;
    const t = window.setTimeout(() => setQueue((q) => q.slice(1)), inGame ? 0 : SHOW_MS);
    return () => window.clearTimeout(t);
  }, [head, inGame]);

  if (!head || inGame) return null;
  const r = rarityStyle(head.rarity);
  return (
    <div role="status" aria-live="polite" data-testid="ach-toast"
      style={{ position: "fixed", top: 72, right: 16, zIndex: 60, display: "flex", gap: 12, alignItems: "center", maxWidth: 340,
        padding: "10px 14px", borderRadius: 12, background: "rgba(11,12,14,.94)", border: `1px solid ${r?.border ?? "#DE9A73"}`,
        boxShadow: `0 0 24px ${r?.glow ?? "rgba(222,154,115,.35)"}`, color: "#fff7df" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={withBase(achievementIconPath(head.id))} alt="" width={40} height={40}
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11, letterSpacing: ".08em", color: r?.border ?? "#ffe7a3" }}>ACHIEVEMENT · {r?.label ?? head.rarity}</div>
        <div style={{ fontWeight: 700 }}>{head.name}</div>
        {head.description && <div style={{ fontSize: 12, opacity: 0.8 }}>{head.description}</div>}
      </div>
    </div>
  );
}
