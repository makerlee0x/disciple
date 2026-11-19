/**
 * Menu music for the iPhone app (maker, 2026-11-19): one looping song under the lobby, Hangar, market and the other menus.
 * App only: on the website (isNativeApp() false) nothing loads or plays.
 *
 *   - Level: Settings › Sound › Music volume. Off when Music is off, or when Settings › Menu music (`menuMusic`) is off.
 *     Every settings change fires `disciple:audio` (lib/game/settings broadcast), which re-applies the level.
 *   - Fades out on every game screen (a flight, the Duel, Climb, Royale) and whenever the house radio is playing, so it never
 *     stacks with flight or match music. Fades back in on a menu.
 *   - Stops when the app goes to the background (visibilitychange) and picks up where it was when the app comes back.
 *   - Seamless: the track is the radio's "Voice Memo Loop" (public/audio/radio/house/voice-memo-loop.m4a, no second copy).
 *     It plays from the top once, then loops LOOP_A → LOOP_B forever. Those two points are where the song repeats itself
 *     (matched on the spectrum, 0.90 similarity), and the seam is a 2 s equal-power crossfade between two players, so it
 *     never gaps or clicks and the song's fade-out at 3:00 is never reached.
 */
import { getAudioContext, resumeAudio } from "./audio";
import { getGameSettings, type GameSettings } from "./settings";
import { getGameRadio } from "./radio";
import { isNativeApp } from "../native";

export const MENU_TRACK = { url: "/audio/radio/house/voice-memo-loop.m4a", loopA: 49.45, loopB: 162.61, xfade: 2 };
/** Under the UI clicks and the ambience beds. */
const MENU_GAIN = 0.8;
const FADE_IN = 0.6, FADE_OUT = 0.25;   // setTargetAtTime time constants, seconds

/** Where the song is `t` seconds after starting at `from`, following the loop. */
export function menuPos(from: number, t: number): number {
  const { loopA: A, loopB: B, xfade: X } = MENU_TRACK;
  let p = from + t;
  if (p >= B - X) p = A - X + ((p - (B - X)) % (B - A));
  return p;
}

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

type Seg = { src: AudioBufferSourceNode; g: GainNode; off: number; at: number };
type Player = { master: GainNode; segs: Seg[]; timer: ReturnType<typeof setTimeout> | 0 };

const CURVE_N = 64;
const curveIn = new Float32Array(CURVE_N).map((_, i) => Math.sin((i / (CURVE_N - 1)) * Math.PI / 2));
const curveOut = new Float32Array(CURVE_N).map((_, i) => Math.cos((i / (CURVE_N - 1)) * Math.PI / 2));

/**
 * Start the menu music controller. Call once (components/MenuMusic in the root layout), then setPath() on every route
 * change. Returns a stop function.
 */
export function startMenuMusic(): { setPath(path: string): void; stop(): void } {
  if (typeof window === "undefined" || !isNativeApp()) return { setPath() {}, stop() {} };
  const radio = getGameRadio();
  const { loopA: A, loopB: B, xfade: X } = MENU_TRACK;
  let path = location.pathname, player: Player | null = null, starting = false, offset = 0, dead = false;

  const want = () => {
    if (dead || document.visibilityState === "hidden" || isGameRoute(path) || radio.status().running) return 0;
    return menuMusicLevel();
  };

  /** One pass of the song from `off`, starting at context time `at`, that hands over to the next pass at the seam. */
  const seg = (ac: AudioContext, b: AudioBuffer, p: Player, off: number, at: number, fadeIn: boolean) => {
    const src = ac.createBufferSource(), g = ac.createGain();
    src.buffer = b; src.connect(g); g.connect(p.master);
    if (fadeIn) { g.gain.value = 0; g.gain.setValueCurveAtTime(curveIn, at, X); } else g.gain.value = 1;
    src.start(at, off);
    const seam = at + (B - X - off);   // when this pass reaches the crossfade
    g.gain.setValueCurveAtTime(curveOut, seam, X);
    src.stop(seam + X + 0.05);
    const me: Seg = { src, g, off, at };
    p.segs.push(me);
    src.onended = () => { p.segs = p.segs.filter((x) => x !== me); try { src.disconnect(); g.disconnect(); } catch { /* */ } };
    // build the next pass a few seconds before the seam (timers are fine here: in the background the music is stopped)
    p.timer = setTimeout(() => { if (player === p) seg(ac, b, p, A - X, seam, true); }, Math.max(0, (seam - ac.currentTime - 3) * 1000));
  };

  const halt = (fade: number) => {
    const p = player; player = null;
    if (!p) return;
    const ac = p.master.context as AudioContext;
    if (p.timer) clearTimeout(p.timer);
    // remember where the song was, so coming back from the background picks up there instead of from the top
    const now = ac.currentTime, cur = p.segs.filter((x) => x.at <= now).pop();
    if (cur) offset = menuPos(cur.off, now - cur.at);
    try { p.master.gain.setTargetAtTime(0, ac.currentTime, fade); } catch { /* */ }
    const segs = p.segs.slice();
    setTimeout(() => { for (const x of segs) { try { x.src.stop(); } catch { /* */ } } try { p.master.disconnect(); } catch { /* */ } }, fade * 5000 + 50);
  };

  const apply = () => {
    const level = want();
    const ac = getAudioContext();
    if (!ac) return;
    if (level <= 0) { halt(FADE_OUT); return; }
    if (player) { player.master.gain.setTargetAtTime(level, ac.currentTime, 0.15); return; }
    if (starting || ac.state !== "running") return;   // the first tap resumes the context (AppSounds), then unlock() retries
    starting = true;
    void load(ac).then((b) => {
      starting = false;
      if (!b || player || want() <= 0 || b.duration < B) return;
      try {
        const master = ac.createGain();
        master.gain.value = 0; master.connect(ac.destination);
        const p: Player = { master, segs: [], timer: 0 };
        player = p;
        const off = offset >= B - X ? A : Math.max(0, offset);
        seg(ac, b, p, off, ac.currentTime + 0.05, false);
        master.gain.setTargetAtTime(want(), ac.currentTime, FADE_IN);
      } catch { player = null; /* no audio device */ }
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
