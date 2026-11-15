"use client";
/**
 * Music for the Turbo screens (Trading Duel, Turbo Royale). They have no radio card, so this plays the same house radio
 * (lib/game/radio.ts) headless: station, volume and on/off come from Settings › Sound (lib/game/settings, `music`).
 *
 * Browsers only start audio after a tap. The Duel runs in this window, so its taps unlock it directly. Royale runs in a
 * same-origin iframe whose taps never reach this window, so play.html posts {type:"disciple:unlock"} on its first tap, and
 * {type:"disciple:mute", m} when its mute button is pressed. The screen's mute button pauses the music for this visit only.
 */
import { useEffect } from "react";
import { getGameRadio } from "./radio";
import { getAudioContext, resumeAudio } from "./audio";
import { audioLevel, getGameSettings } from "./settings";

export function useTurboMusic(): void {
  useEffect(() => {
    const radio = getGameRadio();
    const s = getGameSettings();
    radio.setStation(s.radio.station);
    radio.setShuffle(true);   // a different track each match, not always the first one on the station
    let unlocked = getAudioContext()?.state === "running";
    let last = audioLevel("music");

    const apply = () => {
      const level = audioLevel("music");
      if (last <= 0 && level > 0) radio.clearPause();
      last = level;
      radio.setLevel(level);
      if (level <= 0) radio.stop();
      else if (unlocked && !radio.isPaused()) radio.start();
    };
    const unlock = () => {
      void resumeAudio().then(() => {
        if (getAudioContext()?.state === "running") unlocked = true;
        apply();
      });
    };
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== location.origin || !e.data || typeof e.data !== "object") return;
      const d = e.data as { type?: string; m?: boolean };
      if (d.type === "disciple:unlock") unlock();
      else if (d.type === "disciple:mute") { if (d.m) radio.pause(); else { radio.clearPause(); unlock(); } }
    };

    apply();
    addEventListener("disciple:audio", apply);
    addEventListener("pointerdown", unlock, true);
    addEventListener("keydown", unlock, true);
    addEventListener("message", onMsg);
    return () => {
      removeEventListener("disciple:audio", apply);
      removeEventListener("pointerdown", unlock, true);
      removeEventListener("keydown", unlock, true);
      removeEventListener("message", onMsg);
      radio.stop();
      radio.setShuffle(getGameSettings().radio.shuffle);
    };
  }, []);
}
