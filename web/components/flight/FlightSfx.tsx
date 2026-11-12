"use client";
/**
 * Flight sound effects (no UI). Plays the flight engine's `disciple:sfx` events through lib/game/sfx.ts on the
 * Sound effects channel: the saved SFX on/off + volume (audioLevel("sfx"), live via `disciple:audio`).
 * Same unlock as the house radio (GameRadio): nothing plays until a pointer, key or touch has resumed the shared
 * AudioContext. Mounted by FlightCanvas, so it only runs on a flight (coin page or the simulator).
 */
import { useEffect } from "react";
import { resumeAudio } from "@/lib/game/audio";
import { audioLevel } from "@/lib/game/settings";
import { getFlightSfx, type SfxDetail } from "@/lib/game/sfx";

export default function FlightSfx() {
  useEffect(() => {
    const sfx = getFlightSfx();
    sfx.setLevel(audioLevel("sfx"));
    const onAudio = () => sfx.setLevel(audioLevel("sfx"));
    const onSfx = (e: Event) => { sfx.play((e as CustomEvent<SfxDetail>).detail); };
    const unlock = () => { if (audioLevel("sfx") > 0) void resumeAudio(); };
    const dog = window.setInterval(() => sfx.watchdog(), 500);
    window.addEventListener("disciple:audio", onAudio);
    window.addEventListener("disciple:sfx", onSfx);
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    window.addEventListener("touchstart", unlock, true);
    return () => {
      window.clearInterval(dog);
      window.removeEventListener("disciple:audio", onAudio);
      window.removeEventListener("disciple:sfx", onSfx);
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
      window.removeEventListener("touchstart", unlock, true);
      sfx.stopFly();
    };
  }, []);
  return null;
}
