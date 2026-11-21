"use client";
/** Client side of /api/streaks (lib/server/streaks): load the streaks, claim the daily drop, mark today's play. */
import { useCallback, useEffect, useState } from "react";
import { IS_STATIC_PREVIEW } from "./base-path";
import { connectedAddress } from "./walletState";
import { privyAccessToken } from "./aa/sessionState";
import { dayIndex, type DropReward, type PlayMode, type Streak } from "./streaks";
import type { TrackState } from "./season/track";
import { XP_CHANGED_EVENT } from "./xpClient";

export type StreaksData = {
  aboard: Streak; checkin: Streak; flight: Streak; paid: number;
  drop: DropReward & { claimed: boolean };
  track: TrackState & { season: number; endsAt: number };
};
export const STREAKS_CHANGED_EVENT = "disciple:streaks-changed";
const PLAY_KEY = "disciple.played.v1";

async function authed(): Promise<Record<string, string> | null> {
  const t = await privyAccessToken().catch(() => null);
  return t ? { authorization: `Bearer ${t}` } : null;
}

export async function fetchStreaks(wallet: string | null): Promise<StreaksData | null> {
  if (IS_STATIC_PREVIEW || !wallet) return null;
  const h = await authed(); if (!h) return null;
  try {
    const r = await fetch(`/api/streaks?wallet=${wallet.toLowerCase()}`, { headers: h, cache: "no-store" });
    return r.ok ? ((await r.json()) as StreaksData) : null;
  } catch { return null; }
}

/** The signed-in pilot's streaks: loads, and again on STREAKS_CHANGED_EVENT (a claim, a play). */
export function useStreaks(wallet: string | null) {
  const [d, setD] = useState<StreaksData | null>(null);
  const load = useCallback(() => { void fetchStreaks(wallet).then(setD); }, [wallet]);
  useEffect(() => {
    setD(null); load();
    addEventListener(STREAKS_CHANGED_EVENT, load);
    return () => removeEventListener(STREAKS_CHANGED_EVENT, load);
  }, [load]);
  return { data: d, reload: load };
}

export type ClaimResult = DropReward & { ok: true; paid: boolean } | { ok: false; reason: string };
export async function claimDailyDrop(wallet: string): Promise<ClaimResult> {
  const h = await authed(); if (!h) return { ok: false, reason: "Sign in first" };
  try {
    const r = await fetch("/api/streaks", { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ wallet: wallet.toLowerCase(), op: "claim" }) });
    const j = (await r.json().catch(() => null)) as ClaimResult | null;
    if (!j?.ok) return { ok: false, reason: (j && !j.ok && j.reason) || "Try again in a moment" };
    dispatchEvent(new Event(XP_CHANGED_EVENT)); dispatchEvent(new Event(STREAKS_CHANGED_EVENT));
    return j;
  } catch { return { ok: false, reason: "Try again in a moment" }; }
}

/**
 * A match finished on this device: today counts for the flight streak. Signed-in pilots only, one ping a UTC day per
 * browser (the server keeps a member a day anyway). Fire and forget: a game screen never waits on it.
 */
export function markPlayed(mode: PlayMode) {
  if (IS_STATIC_PREVIEW) return;
  const wallet = connectedAddress(); if (!wallet) return;
  const day = String(dayIndex(Date.now())), key = `${PLAY_KEY}:${wallet.toLowerCase()}`;
  try { if (localStorage.getItem(key) === day) return; } catch { /* private mode: send it */ }
  void (async () => {
    const h = await authed(); if (!h) return;
    const r = await fetch("/api/streaks", { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ wallet: wallet.toLowerCase(), op: "play", mode }) }).catch(() => null);
    if (!r?.ok) return;
    try { localStorage.setItem(key, day); } catch { /* fine */ }
    dispatchEvent(new Event(STREAKS_CHANGED_EVENT));
  })();
}
