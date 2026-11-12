"use client";
/**
 * Flight HUD mode: Pilot (the default: one trade bar, one crew feed, big bombs only) or Pro (the trader view: loadout panel,
 * chart, full position card, every bomb banner). One switch for the canvas and the DOM cards.
 *
 * Saved per browser in localStorage `disciple.hud` ('pilot' | 'pro'). The engine owns the canvas side (public/flight/engine.js
 * S.pro): disciple:hudmode {pro} sets it, and the engine answers disciple:hudstate {pro}. React reads the same key and event.
 */
import { useEffect, useState } from "react";

export type HudMode = "pilot" | "pro";
export const HUD_KEY = "disciple.hud";

export function readHudMode(): HudMode {
  try { return typeof localStorage !== "undefined" && localStorage.getItem(HUD_KEY) === "pro" ? "pro" : "pilot"; } catch { return "pilot"; }
}

export function setHudMode(mode: HudMode) {
  try { localStorage.setItem(HUD_KEY, mode); } catch { /* private mode: the session still switches */ }
  if (typeof window === "undefined") return;
  dispatchEvent(new CustomEvent("disciple:hudmode", { detail: { pro: mode === "pro" } }));
  // React listeners hear the same answer the engine sends, even while the engine is still booting
  dispatchEvent(new CustomEvent("disciple:hudstate", { detail: { pro: mode === "pro" } }));
}

export function useHudMode(): HudMode {
  const [mode, setMode] = useState<HudMode>("pilot");
  useEffect(() => {
    setMode(readHudMode());
    const h = (e: Event) => { const d = (e as CustomEvent<{ pro?: boolean }>).detail; if (d && typeof d.pro === "boolean") setMode(d.pro ? "pro" : "pilot"); };
    addEventListener("disciple:hudstate", h);
    return () => removeEventListener("disciple:hudstate", h);
  }, []);
  return mode;
}
