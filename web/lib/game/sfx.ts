/**
 * App sound player: the recorded CC0 pack in public/audio/sfx and the ambience beds in public/audio/amb (see their READMEs).
 *
 *   playSfx(key, { vol, pan })  one-shot; a key with several takes (ui_tap_01..03) picks one at random
 *   setBed(name | null)         one ambience bed at a time, crossfaded; loops on its exact loop length (AAC pads the end)
 *   startLoop(name) → stop()    a held loop (the main flight's engine hum, the pending-trade blips)
 *
 * Every sound runs on one bus at the Sound effects level from Settings (lib/game/settings, `sfx`), so turning it off there
 * silences all of it. Nothing loads until the first sound, and the shared AudioContext (lib/game/audio) resumes on a tap.
 * The Duel and Royale engines (public/turbo/…) carry their own copy of this player because they run outside React.
 *
 * Website vs iPhone app (maker, 2026-11-16): the engine hum and the button/tab/sheet clicks are for the app only. On the
 * website they stay quiet (appFeel() is false): startLoop("engine_loop") is a silent handle and AppSounds skips the taps.
 */
import { getAudioContext, resumeAudio } from "./audio";
import { audioLevel } from "./settings";
import { isNativeApp } from "../native";

/** True inside the iPhone app, where the engine hum and the UI clicks play. The website skips them. */
export const appFeel = () => isNativeApp();
/** Loops that only play in the app. */
const APP_ONLY_LOOPS = new Set(["engine_loop"]);

const SFX = "/audio/sfx/", AMB = "/audio/amb/";
/** Keys with more than one take: the file names are <key>_01, <key>_02, … */
const TAKES: Record<string, number> = {
  ui_tap: 3, ui_back: 2, mode_swipe: 3, mode_snap: 2, crate_land: 2, boost_small: 3, boost_big: 2, bomb_fall: 2,
  explosion_small: 3, explosion_big: 2, champion: 2, crew_boost: 3, lever_notch: 3, pod_land: 3, weapon_break: 2,
  gun_pistol: 2, gun_machine: 2, gun_shotgun: 2, hit_marker: 2, nuke_warning: 2,
};
/** Per-key trim so the families sit together (the pack is levelled; UI is already ~6 dB under the one-shots). */
const VOL: Record<string, number> = { steer_whoosh: 0.6, xp_tick: 0.5, balance_tick: 0.5, ui_slider_tick: 0.6, tx_pending: 0.5 };
/** Loop length of each bed in seconds (public/audio/amb/README.md). */
export const BEDS: Record<string, number> = {
  amb_space_drone: 93, amb_wind_high: 58, amb_storm_wall: 72, amb_orbit_hum: 90, amb_hangar: 84, amb_mission_control: 57, amb_tension: 57,
};
/** Loops with a gapless WAV copy in sfx/loops-wav (name → loop length, 0 = the whole file). */
const LOOPS: Record<string, number> = { engine_loop: 0, tx_pending: 1.9, gun_minigun_loop: 2 };

const BED_GAIN = 0.85;   // beds sit under the music and the one-shots

let bus: GainNode | null = null;
const bufs = new Map<string, Promise<AudioBuffer | null>>();
const lastAt = new Map<string, number>();

function ctx(): AudioContext | null {
  const ac = getAudioContext();
  if (!ac) return null;
  if (!bus) {
    bus = ac.createGain(); bus.gain.value = audioLevel("sfx"); bus.connect(ac.destination);
    addEventListener("disciple:audio", (e) => {
      const d = (e as CustomEvent).detail as { sfx?: number } | undefined;
      if (bus && typeof d?.sfx === "number") bus.gain.setTargetAtTime(d.sfx, ac.currentTime, 0.05);
    });
  }
  return ac;
}

function load(url: string): Promise<AudioBuffer | null> {
  let p = bufs.get(url);
  if (!p) {
    const ac = ctx();
    if (!ac) return Promise.resolve(null);
    p = fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((a) => new Promise<AudioBuffer>((ok, no) => ac.decodeAudioData(a, ok, no)))
      .catch(() => null);
    bufs.set(url, p);
  }
  return p;
}

const fileOf = (key: string) => { const n = TAKES[key]; return n ? `${key}_${String(1 + Math.floor(Math.random() * n)).padStart(2, "0")}` : key; };

/** Fetch and decode a few sounds ahead of time (e.g. the UI family on first tap). */
export function preloadSfx(keys: string[]) {
  for (const k of keys) { const n = TAKES[k] || 0; if (n) for (let i = 1; i <= n; i++) void load(`${SFX}${k}_0${i}.m4a`); else void load(`${SFX}${k}.m4a`); }
}

/** One-shot. The same key twice within `gapMs` (default 60 ms) plays once, so several listeners can't stack it. */
export function playSfx(key: string, o: { vol?: number; pan?: number; gapMs?: number } = {}) {
  if (typeof window === "undefined" || audioLevel("sfx") <= 0) return;
  const now = performance.now(), gap = o.gapMs ?? 60;
  if (now - (lastAt.get(key) ?? -1e9) < gap) return;
  lastAt.set(key, now);
  const ac = ctx();
  if (!ac || !bus) return;
  if (ac.state === "suspended") void resumeAudio();
  void load(`${SFX}${fileOf(key)}.m4a`).then((b) => {
    if (!b || !bus) return;
    try {
      const s = ac.createBufferSource(), g = ac.createGain();
      s.buffer = b; g.gain.value = (VOL[key] ?? 1) * (o.vol ?? 1); s.connect(g);
      if (o.pan && ac.createStereoPanner) { const p = ac.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, o.pan)); g.connect(p); p.connect(bus); }
      else g.connect(bus);
      s.start();
    } catch { /* no audio device */ }
  });
}

export type LoopHandle = { set(vol: number, rate?: number): void; stop(): void };

/** A held loop from sfx/loops-wav (gapless). Starts silent; set() fades it to a level. */
export function startLoop(name: keyof typeof LOOPS | string): LoopHandle {
  if (APP_ONLY_LOOPS.has(name) && !appFeel()) return { set() {}, stop() {} };
  const ac = ctx();
  let src: AudioBufferSourceNode | null = null, g: GainNode | null = null, dead = false, want = 0, rate = 1;
  if (ac && bus) {
    void load(`${SFX}loops-wav/${name}.wav`).then((b) => {
      if (!b || dead || !bus) return;
      try {
        src = ac.createBufferSource(); g = ac.createGain();
        src.buffer = b; src.loop = true; if (LOOPS[name]) { src.loopStart = 0; src.loopEnd = LOOPS[name]; }
        src.playbackRate.value = rate; g.gain.value = 0; src.connect(g); g.connect(bus); src.start();
        g.gain.setTargetAtTime(want, ac.currentTime, 0.15);
      } catch { /* */ }
    });
  }
  return {
    set(v, r) {
      want = v; if (r) rate = r;
      if (ac && g) g.gain.setTargetAtTime(v, ac.currentTime, 0.15);
      if (ac && src && r) src.playbackRate.setTargetAtTime(r, ac.currentTime, 0.2);
    },
    stop() {
      dead = true;
      const s = src, gg = g;
      if (ac && gg) { try { gg.gain.setTargetAtTime(0, ac.currentTime, 0.12); } catch { /* */ } }
      setTimeout(() => { try { s?.stop(); } catch { /* */ } }, 700);
    },
  };
}

/* ---------- ambience beds: one at a time, 2 s crossfade ---------- */
let bed: { name: string; src: AudioBufferSourceNode | null; g: GainNode | null } | null = null;

export function setBed(name: string | null) {
  if ((bed?.name ?? null) === name) return;
  const ac = ctx();
  const old = bed;
  if (old && ac) {
    if (old.g) { try { old.g.gain.setTargetAtTime(0, ac.currentTime, 0.6); } catch { /* */ } }
    setTimeout(() => { try { old.src?.stop(); } catch { /* */ } }, 3000);
  }
  bed = null;
  if (!name || !ac || !bus || !(name in BEDS)) return;
  const me: { name: string; src: AudioBufferSourceNode | null; g: GainNode | null } = { name, src: null, g: null };
  bed = me;
  void load(`${AMB}${name}.m4a`).then((b) => {
    if (!b || bed !== me || !bus) return;
    try {
      const s = ac.createBufferSource(), g = ac.createGain();
      s.buffer = b; s.loop = true; s.loopStart = 0; s.loopEnd = Math.min(BEDS[name], b.duration);
      g.gain.value = 0; s.connect(g); g.connect(bus); s.start();
      g.gain.setTargetAtTime(BED_GAIN, ac.currentTime, 0.7);
      me.src = s; me.g = g;
    } catch { /* */ }
  });
}
