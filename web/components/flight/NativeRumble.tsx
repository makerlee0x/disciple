"use client";
/**
 * iPhone app only (maker 2026-11-14, "make the rocket feel alive in your hand"): a looping Core Haptics engine rumble that
 * follows the thrust while you fly. The engine fires disciple:rumble {v} (0…1, a few times a second at most); this forwards it to
 * DiscipleHaptics.setLevel. Off with Vibration off, while the app is in the background, and when you leave the flight.
 * Bomb hits, zones, fills and orbit get their own Core Haptics patterns through lib/native nativeHaptic.
 */
import { useEffect } from "react";
import { coreHaptics } from "@/lib/native";
import { useGameSettings } from "@/lib/game/settings";

export default function NativeRumble() {
  const { haptics } = useGameSettings();
  useEffect(() => {
    const h = coreHaptics();
    if (!h || !haptics) return;
    let level = 0;
    const set = (v: number) => { void h.setLevel({ level: document.hidden ? 0 : v }).catch(() => {}); };
    const on = (e: Event) => { const v = Number((e as CustomEvent<{ v?: number }>).detail?.v); if (Number.isFinite(v)) { level = v; set(v); } };
    const vis = () => set(level);
    void h.start().catch(() => {});
    addEventListener("disciple:rumble", on); document.addEventListener("visibilitychange", vis);
    return () => { removeEventListener("disciple:rumble", on); document.removeEventListener("visibilitychange", vis); void h.stop().catch(() => {}); };
  }, [haptics]);
  return null;
}
