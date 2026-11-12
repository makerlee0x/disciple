/**
 * Audio plug-in point for the GAME.
 *   - useAudioLevel("sfx" | "music") → effective 0..1 gain (0 when muted) from the ESC settings menu, live-updating;
 *   - audioLevel() (lib/game/settings) for non-React code; `disciple:audio` {sfx, music} event for the flight engine;
 *   - getAudioContext() / resumeAudio(): one shared AudioContext (radio + the SFX preview blip), resumed after a
 *     user gesture because browsers block autoplay with sound;
 *   - previewBlip(vol): a short WebAudio tick the settings menu plays when the SFX volume changes;
 *   - music channel: the house radio (lib/game/radio.ts), mounted on the flight canvas.
 */
import { audioLevel, useGameSettings } from "./settings";

export function useAudioLevel(ch: "sfx" | "music"): number {
  return audioLevel(ch, useGameSettings());
}

let ac: AudioContext | null = null;

/** One AudioContext for the page. Created lazily; may be suspended until resumeAudio() after a user gesture. */
export function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ac) return ac;
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ac = new AC();
    return ac;
  } catch {
    return null;
  }
}

/** Resume the shared context (call from a user gesture, or right after one). Safe to call often. */
export function resumeAudio(): Promise<void> {
  const ctx = getAudioContext();
  if (!ctx || ctx.state === "closed") return Promise.resolve();
  if (ctx.state === "suspended") return ctx.resume().then(() => undefined).catch(() => undefined);
  return Promise.resolve();
}

export function previewBlip(vol: number) {
  if (typeof window === "undefined" || !(vol > 0)) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    void resumeAudio();
    const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "triangle"; o.frequency.setValueAtTime(880, t); o.frequency.exponentialRampToValueAtTime(1320, t + 0.06);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25 * vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.14);
  } catch { /* autoplay policy / no audio device */ }
}
