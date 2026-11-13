"use client";
/* Flight sound cues: the engine fires disciple:sfx {k} (ignite, fill, fail, bomb, zone, orbit); this plays a short WebAudio synth
   for each one, at the SFX volume from game settings (muted = silent). No audio files, nothing loads until the first cue. */
import { useEffect } from "react";
import { audioLevel } from "@/lib/game/settings";

type Note = { f: number; to?: number; d: number; type?: OscillatorType; at?: number; g?: number };
const CUES: Record<string, Note[]> = {
  ignite: [{ f: 180, to: 520, d: 0.18, type: "sawtooth", g: 0.25 }],
  fill: [{ f: 660, d: 0.08, type: "triangle" }, { f: 990, d: 0.12, type: "triangle", at: 0.07 }],
  fail: [{ f: 300, to: 150, d: 0.22, type: "square", g: 0.18 }],
  bomb: [{ f: 120, to: 40, d: 0.45, type: "sawtooth", g: 0.4 }],
  zone: [{ f: 520, d: 0.1, type: "sine" }, { f: 780, d: 0.16, type: "sine", at: 0.09 }],
  orbit: [{ f: 523, d: 0.16, type: "triangle" }, { f: 659, d: 0.16, type: "triangle", at: 0.12 }, { f: 784, d: 0.3, type: "triangle", at: 0.24 }],
};

export default function FlightSfx() {
  useEffect(() => {
    let ac: AudioContext | null = null;
    let last = 0;
    const on = (e: Event) => {
      const k = String((e as CustomEvent).detail?.k || "");
      const notes = CUES[k];
      const vol = audioLevel("sfx");
      if (!notes || vol <= 0) return;
      const now = performance.now();
      if (now - last < 40) return;   // rapid fills: one cue per 40ms
      last = now;
      try {
        ac = ac || new AudioContext();
        if (ac.state === "suspended") void ac.resume();
        const t0 = ac.currentTime;
        for (const n of notes) {
          const o = ac.createOscillator(), g = ac.createGain(), t = t0 + (n.at || 0);
          o.type = n.type || "sine";
          o.frequency.setValueAtTime(n.f, t);
          if (n.to) o.frequency.exponentialRampToValueAtTime(n.to, t + n.d);
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(Math.max(0.0002, (n.g ?? 0.2) * vol), t + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, t + n.d);
          o.connect(g).connect(ac.destination);
          o.start(t); o.stop(t + n.d + 0.02);
        }
      } catch { /* no audio: stay silent */ }
    };
    addEventListener("disciple:sfx", on);
    return () => { removeEventListener("disciple:sfx", on); void ac?.close(); };
  }, []);
  return null;
}
