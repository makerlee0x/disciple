"use client";
/**
 * Profile tab / page / popup state in the URL (?tab=loot&page=2&loot=<id>) so it's shareable and Back works.
 * Reads window.location directly (no useSearchParams, so the statically rendered /u/[username] pages need no Suspense).
 */
import { useCallback, useEffect, useState } from "react";
import { LOOT_ENABLED } from "./features";

/** Every tab the profile knows, in display order. */
export const ALL_PROFILE_TABS = ["rockets", "loot", "achievements", "activity"] as const;
export type ProfileTab = (typeof ALL_PROFILE_TABS)[number];
/** Tabs shown right now: Loot only behind LOOT_ENABLED (lib/features). */
export const PROFILE_TABS: readonly ProfileTab[] = ALL_PROFILE_TABS.filter((t) => t !== "loot" || LOOT_ENABLED);
export type ProfileUrlState = { tab: ProfileTab; page: number; loot: string | null; filter: string | null };

function read(): ProfileUrlState {
  const q = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const t = q.get("tab") as ProfileTab | null;
  const page = Math.max(1, Math.min(999, parseInt(q.get("page") || "1", 10) || 1));
  const loot = q.get("loot");
  const filter = LOOT_ENABLED ? q.get("slot") : null; // ?slot= is the Loot filter

  return { tab: t && PROFILE_TABS.includes(t) ? t : "rockets", page, loot: loot && /^[a-z0-9_:-]{1,64}$/.test(loot) ? loot : null, filter: filter && /^[a-z]{1,16}$/.test(filter) ? filter : null };
}

export function useProfileUrlState() {
  const [s, setS] = useState<ProfileUrlState>({ tab: "rockets", page: 1, loot: null, filter: null });
  useEffect(() => {
    const s0 = read();
    setS(s0);
    // A deep link to a hidden / unknown tab (e.g. ?tab=loot while Loot is off) lands on Rockets: drop its params too.
    const q = new URLSearchParams(window.location.search);
    const t = q.get("tab");
    if (t && t !== s0.tab) {
      q.delete("tab"); q.delete("page"); q.delete("loot"); q.delete("slot");
      window.history.replaceState(null, "", `${window.location.pathname}${q.toString() ? `?${q}` : ""}${window.location.hash}`);
    }
    const pop = () => setS(read());
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  const update = useCallback((patch: Partial<ProfileUrlState>, mode: "push" | "replace" = "push") => {
    setS((prev) => {
      const next = { ...prev, ...patch };
      const q = new URLSearchParams(window.location.search);
      const put = (k: string, v: string | null) => (v ? q.set(k, v) : q.delete(k));
      put("tab", next.tab === "rockets" ? null : next.tab);
      put("page", next.page > 1 ? String(next.page) : null);
      put("loot", next.loot);
      put("slot", next.filter);
      const url = `${window.location.pathname}${q.toString() ? `?${q}` : ""}${window.location.hash}`;
      if (mode === "push") window.history.pushState(null, "", url); else window.history.replaceState(null, "", url);
      return next;
    });
  }, []);
  return [s, update] as const;
}
