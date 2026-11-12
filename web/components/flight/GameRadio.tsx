"use client";
/**
 * Mounts the house radio on the flight canvas (coin + sim). No UI: mute and volume are the
 * existing Music controls in the ESC settings menu. Starts only after a user gesture (or if the
 * shared AudioContext is already running). Stops when music is muted or this canvas unmounts.
 */
import { useEffect } from "react";
import { getAudioContext, resumeAudio } from "@/lib/game/audio";
import { getGameRadio } from "@/lib/game/radio";
import { audioLevel } from "@/lib/game/settings";
import { radioShouldPlay } from "@/lib/game/stations";

export default function GameRadio() {
  useEffect(() => {
    const radio = getGameRadio();
    let unlocked = !!(getAudioContext() && getAudioContext()!.state === "running");

    const apply = () => {
      const level = audioLevel("music");
      radio.setLevel(level);
      if (radioShouldPlay(level, unlocked)) radio.start();
      else radio.stop();
    };

    const unlock = () => {
      void resumeAudio().then(() => {
        const ctx = getAudioContext();
        if (ctx && ctx.state === "running") unlocked = true;
        apply();
      });
    };

    apply();
    window.addEventListener("disciple:audio", apply);
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    window.addEventListener("touchstart", unlock, true);
    return () => {
      window.removeEventListener("disciple:audio", apply);
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
      window.removeEventListener("touchstart", unlock, true);
      radio.stop();
    };
  }, []);
  return null;
}
