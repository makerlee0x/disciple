"use client";
/**
 * Keeps the lobby's rockets fresh: one /api/home read right after mount and every 30 s while the tab is visible,
 * re-broadcast as "dsc:home-data" (what Lobby and RocketGrid listen for). The page's server snapshot can be a degraded
 * build (images and crew missing when a KV read timed out while it rendered), and the signed-in lobby has no other
 * poller, so without this the cards kept the letter placeholder (maker 2026-11-19). One poll per page, however many use it.
 */
import { useEffect } from "react";
import { withBase } from "@/lib/base-path";
import type { HomeData } from "@/lib/home/trending";

const POLL_MS = 30_000;
let users = 0, iv: number | null = null, lastAt = 0;

async function tick() {
  if (typeof document !== "undefined" && document.hidden) return;
  if (Date.now() - lastAt < 5_000) return;   // another poller (HomeHero) or user just read it
  lastAt = Date.now();
  try {
    const r = await fetch(withBase("/api/home"), { cache: "no-store" });
    if (!r.ok) return;
    const d = (await r.json()) as HomeData;
    if (d?.coins?.length) window.dispatchEvent(new CustomEvent("dsc:home-data", { detail: d }));
  } catch { /* keep the last numbers */ }
}

export function useHomePoll() {
  useEffect(() => {
    users++;
    if (users === 1) { void tick(); iv = window.setInterval(() => void tick(), POLL_MS); }
    return () => { users--; if (!users && iv != null) { window.clearInterval(iv); iv = null; } };
  }, []);
}
