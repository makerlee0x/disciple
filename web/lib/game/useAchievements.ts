"use client";
/** React hook over lib/game/achievementsClient: real per-wallet achievement views (V1 set), refreshed on unlock. */
import { useEffect, useMemo, useState } from "react";
import type { AchievementView } from "@/lib/achievements";
import { ACHIEVEMENT_EVENT, fetchAchievements, realAchievementViews, type AchievementUnlock, type AchievementsResult } from "./achievementsClient";

const ORDER = { unlocked: 0, in_progress: 1, locked: 2 } as const;

export function useAchievements(wallet: string | null | undefined): {
  views: AchievementView[]; unlocked: number; source: AchievementsResult["source"]; loading: boolean;
} {
  const w = (wallet || "").toLowerCase();
  const [res, setRes] = useState<AchievementsResult | null>(null);
  const [bump, setBump] = useState(0);
  useEffect(() => {
    if (!w) { setRes(null); return; }
    const ac = new AbortController();
    fetchAchievements(w, { signal: ac.signal }).then((r) => { if (!ac.signal.aborted) setRes(r); });
    return () => ac.abort();
  }, [w, bump]);
  // A toast for this wallet → refetch so the grid/profile flip the card without a reload.
  useEffect(() => {
    if (!w) return;
    const on = (e: Event) => { const d = (e as CustomEvent<AchievementUnlock>).detail; if (d?.wallet === w) setBump((b) => b + 1); };
    window.addEventListener(ACHIEVEMENT_EVENT, on);
    return () => window.removeEventListener(ACHIEVEMENT_EVENT, on);
  }, [w]);
  const views = useMemo(
    () => realAchievementViews(res ?? { items: [] }).sort((x, y) => ORDER[x.state] - ORDER[y.state]),
    [res],
  );
  return { views, unlocked: views.filter((v) => v.state === "unlocked").length, source: res?.source ?? "unavailable", loading: !!w && !res };
}
