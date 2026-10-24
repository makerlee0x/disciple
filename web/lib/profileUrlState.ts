"use client";
/**
 * Profile tab / page / popup state in the URL (?tab=loot&page=2&loot=<id>) so it's shareable and Back works.
 * Reads window.location directly (no useSearchParams, so the statically rendered /u/[username] pages need no Suspense).
 */
import { useCallback, useEffect, useState } from "react";

export const PROFILE_TABS = ["rockets", "loot", "achievements", "activity"] as const;
export type ProfileTab = (typeof PROFILE_TABS)[number];
export type ProfileUrlState = { tab: ProfileTab; page: number; loot: string | null; filter: string | null };

function read(): ProfileUrlState {
  const q = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const t = q.get("tab") as ProfileTab | null;
  const page = Math.max(1, Math.min(999, parseInt(q.get("page") || "1", 10) || 1));
  const loot = q.get("loot");
  const filter = q.get("slot");
  return { tab: t && PROFILE_TABS.includes(t) ? t : "rockets", page, loot: loot && /^[a-z0-9_:-]{1,64}$/.test(loot) ? loot : null, filter: filter && /^[a-z]{1,16}$/.test(filter) ? filter : null };
}

export function useProfileUrlState() {
  const [s, setS] = useState<ProfileUrlState>({ tab: "rockets", page: 1, loot: null, filter: null });
  useEffect(() => {
    setS(read());
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
