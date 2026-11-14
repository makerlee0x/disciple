"use client";
/**
 * Flight HUD mode: Pilot (the default: one trade bar, one crew feed, big bombs only) or Pro (the trader view: loadout panel,
 * chart, full position card, every bomb banner). One switch for the canvas and the DOM cards.
 *
 * Saved per browser in localStorage `disciple.hud` ('pilot' | 'pro'). The engine owns the canvas side (public/flight/engine.js
 * S.pro): disciple:hudmode {pro} sets it, and the engine answers disciple:hudstate {pro}. React reads the same key and event.
 */
import { useEffect, useState } from "react";
import { PRO_HUD_ENABLED } from "@/lib/features";

export type HudMode = "pilot" | "pro";
export const HUD_KEY = "disciple.hud";

/** Pro hidden for launch (lib/features PRO_HUD_ENABLED): forget a saved 'pro' before the engine reads the key at boot. */
if (!PRO_HUD_ENABLED && typeof localStorage !== "undefined") { try { if (localStorage.getItem(HUD_KEY) === "pro") localStorage.setItem(HUD_KEY, "pilot"); } catch { /* private mode */ } }

export function readHudMode(): HudMode {
  if (!PRO_HUD_ENABLED) return "pilot";
  try { return typeof localStorage !== "undefined" && localStorage.getItem(HUD_KEY) === "pro" ? "pro" : "pilot"; } catch { return "pilot"; }
}

export function setHudMode(mode: HudMode) {
  if (!PRO_HUD_ENABLED) mode = "pilot";
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
    // Pro hidden: if the engine still answers pro (an old saved choice), switch it back to Pilot
    const h = (e: Event) => { const d = (e as CustomEvent<{ pro?: boolean }>).detail; if (!d || typeof d.pro !== "boolean") return;
      if (d.pro && !PRO_HUD_ENABLED) { setHudMode("pilot"); return; } setMode(d.pro ? "pro" : "pilot"); };
    addEventListener("disciple:hudstate", h);
    return () => removeEventListener("disciple:hudstate", h);
  }, []);
  return mode;
}
