/**
 * Menu music for the iPhone app (maker, 2026-11-19): one looping song under the lobby, Hangar, market and the other menus.
 * App only: on the website (isNativeApp() false) nothing loads or plays.
 *
 *   - Level: Settings › Sound › Music volume. Off when Music is off, or when Settings › Menu music (`menuMusic`) is off.
 *     Every settings change fires `disciple:audio` (lib/game/settings broadcast), which re-applies the level.
 *   - Fades out on every game screen (a flight, the Duel, Climb, Royale) and whenever the house radio is playing, so it never
 *     stacks with flight or match music. Fades back in on a menu.
 *   - Stops when the app goes to the background (visibilitychange) and picks up where it was when the app comes back.
 *   - Gapless: decoded once into an AudioBufferSourceNode with loop = true on the exact loop points below (an AAC file pads
 *     its start and end, so the points skip the padding).
 *
 * The track lives in public/audio/music (see its README for the loop points and loudness).
 */
import { getAudioContext, resumeAudio } from "./audio";
import { getGameSettings, type GameSettings } from "./settings";
import { getGameRadio } from "./radio";
import { isNativeApp } from "../native";

export const MENU_TRACK = { url: "/audio/music/menu_loop.m4a", loopStart: 0, loopEnd: 0 /* 0 = whole file */ };
/** Under the UI clicks and the ambience beds. */
const MENU_GAIN = 0.8;
const FADE_IN = 0.6, FADE_OUT = 0.25;   // setTargetAtTime time constants, seconds

/** Screens where the game runs its own sound (flight radio, Duel/Royale/Climb engines). Menu music stays off there. */
export function isGameRoute(path: string): boolean {
  return /^\/(coin|flight|fly|duel|vs|d|turbo)(\/|$)/.test(path);
}

export function menuMusicLevel(s: GameSettings = getGameSettings()): number {
  return s.menuMusic && s.music.on ? s.music.vol * MENU_GAIN : 0;
}

let buf: Promise<AudioBuffer | null> | null = null;
function load(ac: AudioContext): Promise<AudioBuffer | null> {
  if (!buf) {
    buf = fetch(MENU_TRACK.url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((a) => new Promise<AudioBuffer>((ok, no) => ac.decodeAudioData(a, ok, no)))
      .catch(() => { buf = null; return null; });
  }
  return buf;
}

type Player = { src: AudioBufferSourceNode; g: GainNode };

/**
 * Start the menu music controller. Call once (components/MenuMusic in the root layout), then setPath() on every route
 * change. Returns a stop function.
 */
export function startMenuMusic(): { setPath(path: string): void; stop(): void } {
  if (typeof window === "undefined" || !isNativeApp()) return { setPath() {}, stop() {} };
  const radio = getGameRadio();
  let path = location.pathname, player: Player | null = null, starting = false, offset = 0, startedAt = 0, dead = false;

  const want = () => {
    if (dead || document.visibilityState === "hidden" || isGameRoute(path) || radio.status().running) return 0;
    return menuMusicLevel();
  };

  const halt = (fade: number) => {
    const p = player; player = null;
    if (!p) return;
    const ac = p.g.context as AudioContext;
    // remember where the loop was, so coming back from the background picks up there instead of from the top
    const len = p.src.buffer ? (MENU_TRACK.loopEnd || p.src.buffer.duration) - MENU_TRACK.loopStart : 0;
    if (len > 0) offset = MENU_TRACK.loopStart + ((offset - MENU_TRACK.loopStart + ac.currentTime - startedAt) % len);
    try { p.g.gain.setTargetAtTime(0, ac.currentTime, fade); } catch { /* */ }
    setTimeout(() => { try { p.src.stop(); p.src.disconnect(); p.g.disconnect(); } catch { /* */ } }, fade * 5000 + 50);
  };

  const apply = () => {
    const level = want();
    const ac = getAudioContext();
    if (!ac) return;
    if (level <= 0) { halt(FADE_OUT); return; }
    if (player) { player.g.gain.setTargetAtTime(level, ac.currentTime, 0.15); return; }
    if (starting || ac.state !== "running") return;   // the first tap resumes the context (AppSounds), then unlock() retries
    starting = true;
    void load(ac).then((b) => {
      starting = false;
      if (!b || player || want() <= 0) return;
      try {
        const src = ac.createBufferSource(), g = ac.createGain();
        src.buffer = b; src.loop = true;
        if (MENU_TRACK.loopEnd > 0) { src.loopStart = MENU_TRACK.loopStart; src.loopEnd = Math.min(MENU_TRACK.loopEnd, b.duration); }
        g.gain.value = 0; src.connect(g); g.connect(ac.destination);
        const at = Math.min(Math.max(offset, MENU_TRACK.loopStart), b.duration - 0.05);
        src.start(0, at);
        offset = at; startedAt = ac.currentTime;
        g.gain.setTargetAtTime(want(), ac.currentTime, FADE_IN);
        player = { src, g };
      } catch { /* no audio device */ }
    });
  };

  const unlock = () => { void resumeAudio().then(apply); };
  // back from the background: iOS may have suspended the context, so try to wake it (a tap does it if this is refused)
  const onVis = () => { if (document.visibilityState === "visible") unlock(); else apply(); };
  const offRadio = radio.subscribe(apply);
  addEventListener("disciple:audio", apply);
  document.addEventListener("visibilitychange", onVis);
  addEventListener("pointerdown", unlock, true);
  apply();

  return {
    setPath(p: string) { path = p; apply(); },
    stop() {
      dead = true; halt(FADE_OUT); offRadio();
      removeEventListener("disciple:audio", apply);
      document.removeEventListener("visibilitychange", onVis);
      removeEventListener("pointerdown", unlock, true);
    },
  };
}
