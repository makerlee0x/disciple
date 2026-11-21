"use client";
/**
 * The rocket in your hand (iPhone app, maker 2026-11-14 option 1). Inside the app, with Vibration on and a Taptic Engine:
 *  - a continuous Core Haptics rumble that follows the engine (disciple:thrust {v, climb, pending}, ~10×/s): stronger and
 *    sharper on a hard climb or a boost in flight, a low soft hum while coasting, near silent while sinking
 *  - one-shot patterns over it for the big moments (engine sound cues): a heavy thud + shudder on a bomb, a rising three-step
 *    tick crossing a zone, a build and two cracks at orbit, a whip on a trick, a snap on a fill
 *  - Turbo Duel and Royale mount it too: their engines send disciple:thrust while you race and {off: true} when the race stops
 * Everything else (browser, Android, haptics off) keeps the existing lib/game/haptics path. Stops when the tab hides.
 */
import { useEffect } from "react";
import { useGameSettings } from "@/lib/game/settings";
import { setRichHaptics } from "@/lib/game/haptics";
import { nativePattern, nativeRumble, nativeRumbleStop, nativeRumbleSupported } from "@/lib/native";

/** Pure: thrust reading → rumble level (tested in scripts/test-rumble.mts). Kept low: it should feel like an engine, not a buzzer. */
export function rumbleLevel(d: { v: number; climb: number; pending?: number }): { intensity: number; sharpness: number } {
  const v = Math.max(0, Math.min(1, d.v || 0)), climb = Math.max(-1, Math.min(1, d.climb || 0)), p = d.pending ? 1 : 0;
  const intensity = climb < -0.2 ? 0.05 : Math.min(0.75, 0.1 + 0.32 * v + 0.28 * Math.max(0, climb) + 0.12 * p);
  const sharpness = Math.min(0.9, 0.15 + 0.35 * Math.max(0, climb) + 0.2 * p);
  return { intensity: +intensity.toFixed(3), sharpness: +sharpness.toFixed(3) };
}

const CUE: Record<string, string> = { bomb: "bomb", zone: "zone", orbit: "orbit", trick: "trick", fill: "fill" };

export default function NativeRumble() {
  const { haptics } = useGameSettings();
  useEffect(() => {
    if (!haptics) return;
    let live = true, on = false, last = { intensity: -1, sharpness: -1 };
    const onThrust = (e: Event) => {
      if (!on) return;
      const d = (e as CustomEvent).detail || {};
      if (d.off) { if (last.intensity !== 0) nativeRumble(0, 0); last = { intensity: 0, sharpness: 0 }; return; }
      const l = rumbleLevel(d);
      if (Math.abs(l.intensity - last.intensity) < 0.02 && Math.abs(l.sharpness - last.sharpness) < 0.03) return;
      last = l; nativeRumble(l.intensity, l.sharpness);
    };
    const onSfx = (e: Event) => {
      if (!on) return;
      const d = (e as CustomEvent<{ k?: string; up?: boolean }>).detail || {};
      const k = d.k === "zone" && d.up === false ? "" : CUE[d.k || ""];
      if (k) nativePattern(k);
    };
    const onStyle = () => { if (on) nativePattern("stylefill"); };
    const setOn = (v: boolean) => {
      on = v; setRichHaptics(v); dispatchEvent(new CustomEvent("disciple:rumble", { detail: { on: v } }));
      if (!v) { nativeRumbleStop(); last = { intensity: -1, sharpness: -1 }; }
    };
    const onVis = () => setOn(live && document.visibilityState === "visible");
    void nativeRumbleSupported().then((ok) => {
      if (!ok || !live) return;
      addEventListener("disciple:thrust", onThrust); addEventListener("disciple:sfx", onSfx); addEventListener("disciple:stylefill", onStyle);
      document.addEventListener("visibilitychange", onVis);
      onVis();
    });
    return () => {
      live = false; setOn(false);
      removeEventListener("disciple:thrust", onThrust); removeEventListener("disciple:sfx", onSfx); removeEventListener("disciple:stylefill", onStyle);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [haptics]);
  return null;
}
