/**
 * Audio plug-in point for the GAME. There is no sound system yet (no SFX or music assets in the repo); this module is
 * the seam a future one plugs into:
 *   - useAudioLevel("sfx" | "music") → effective 0..1 gain (0 when muted) from the ESC settings menu, live-updating;
 *   - audioLevel() (lib/game/settings) for non-React code; `disciple:audio` {sfx, music} event for the flight engine;
 *   - previewBlip(vol): the one sound that exists today, a short WebAudio tick the settings menu plays when the
 *     SFX volume changes, so the slider gives feedback.
 */
import { audioLevel, useGameSettings } from "./settings";

export function useAudioLevel(ch: "sfx" | "music"): number {
  return audioLevel(ch, useGameSettings());
}

let ac: AudioContext | null = null;
export function previewBlip(vol: number) {
  if (typeof window === "undefined" || !(vol > 0)) return;
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ac = ac || new AC();
    const t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
    o.type = "triangle"; o.frequency.setValueAtTime(880, t); o.frequency.exponentialRampToValueAtTime(1320, t + 0.06);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25 * vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g).connect(ac.destination); o.start(t); o.stop(t + 0.14);
  } catch { /* autoplay policy / no audio device */ }
}
