// In-game house radio: music-channel mute/volume, playlist loop, one player instance.
//   Run: tsx scripts/test-in-game-radio.mjs
import { existsSync, statSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (c, msg) => { if (c) console.log("ok  ", msg); else { failed++; console.log("FAIL", msg); } };

// ---- source / assets ----------------------------------------------------------------
const canvas = readFileSync(join(web, "components/FlightCanvas.tsx"), "utf8");
const menu = readFileSync(join(web, "components/flight/SettingsMenu.tsx"), "utf8");
const hook = readFileSync(join(web, "components/flight/GameRadio.tsx"), "utf8");
const i18n = readFileSync(join(web, "lib/game/i18n.ts"), "utf8");
ok(canvas.includes("<GameRadio"), "FlightCanvas mounts GameRadio (coin + sim flight only)");
ok(!/app\/page\.tsx/.test(canvas), "radio is not wired through the landing page component");
ok(/audioLevel\("music"\)/.test(hook) && /disciple:audio/.test(hook), "GameRadio follows the existing music channel");
ok(/resumeAudio/.test(hook) && /pointerdown/.test(hook), "playback waits for a user gesture (or an already-running context)");
ok(!/setGameSettings/.test(hook), "radio does not add its own mute or volume control");
ok(menu.includes("audio-${ch}-toggle") && menu.includes("audio.music") && menu.includes("audio-${ch}-vol"), "settings still use the existing Music toggle and slider");
ok(i18n.includes("Music plays during a flight. Sound effects aren't in yet."), "EN audio.note no longer says sounds don't ship");

const files = [
  "candlelit-nocturne.m4a", "cavernous-reverb.m4a", "golden-hour-basement.m4a",
  "open-sky.m4a", "stadium-chaos.m4a", "sun-bleached-groove.m4a", "voice-memo-loop.m4a",
];
const dir = join(web, "public/audio/radio/house");
for (const f of files) {
  const p = join(dir, f);
  ok(existsSync(p) && statSync(p).size > 100_000, `asset present: ${f}`);
}

// ---- helpers ------------------------------------------------------------------------
const { nextTrackIndex, radioShouldPlay, STATIONS, HOUSE_STATION, DEFAULT_STATION_ID, stationOf } = await import("../lib/game/stations.ts");
ok(DEFAULT_STATION_ID === "house" && stationOf("missing").id === "house", "unknown station ids fall back to house");
ok(HOUSE_STATION.tracks.length === 7 && STATIONS.house === HOUSE_STATION, "V1 ships one station, house, with 7 tracks");
ok(nextTrackIndex(0, 7) === 1 && nextTrackIndex(6, 7) === 0, "playlist index wraps: last track → first");
ok(radioShouldPlay(0.5, false) === false, "no play before unlock, even if music is on");
ok(radioShouldPlay(0, true) === false, "no play when music level is 0 (muted or volume 0)");
ok(radioShouldPlay(0.5, true) === true, "play when unlocked and music has level");

// ---- player with stubs --------------------------------------------------------------
const made = [];
class FakeAudio {
  constructor() {
    this._src = ""; this.currentTime = 0; this.duration = 180; this.paused = true;
    this.preload = "auto"; this.crossOrigin = ""; this.loop = false; this._l = {};
    made.push(this);
  }
  set src(v) { this._src = v; }
  get src() { return this._src; }
  getAttribute(n) { return n === "src" ? this._src : null; }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  load() {}
  addEventListener(t, f) { (this._l[t] ||= []).push(f); }
  removeEventListener() {}
  emit(t) { (this._l[t] || []).forEach((f) => f()); }
}
class FakeParam {
  constructor(v = 0) { this.value = v; }
  cancelScheduledValues() {}
  setValueAtTime(v) { this.value = v; }
  setTargetAtTime(v) { this.value = v; }
  linearRampToValueAtTime(v) { this.value = v; }
}
class FakeGain { constructor() { this.gain = new FakeParam(1); } connect() { return this; } }
class FakeSource { connect() { return this; } }
class FakeCtx {
  constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
  createGain() { return new FakeGain(); }
  createMediaElementSource() { return new FakeSource(); }
  resume() { this.state = "running"; return Promise.resolve(); }
}

const prev = { Audio: globalThis.Audio, window: globalThis.window, AudioContext: globalThis.AudioContext };
globalThis.Audio = FakeAudio;
globalThis.AudioContext = FakeCtx;
globalThis.window = Object.assign(globalThis, {
  Audio: FakeAudio,
  AudioContext: FakeCtx,
  location: { href: "https://disciple.test/" },
  addEventListener() {},
  setTimeout: globalThis.setTimeout.bind(globalThis),
});

const audioMod = await import("../lib/game/audio.ts");
// Point the shared context at a fresh fake for this process.
const { getGameRadio, resetGameRadioForTests, CROSSFADE_SEC, GameRadio } = await import("../lib/game/radio.ts");

// getAudioContext will use window.AudioContext — first call creates one.
ok(typeof CROSSFADE_SEC === "number" && CROSSFADE_SEC > 0 && CROSSFADE_SEC <= 2, `crossfade is a short overlap (${CROSSFADE_SEC}s), not a hard cut`);

const a = getGameRadio();
const b = getGameRadio();
ok(a === b, "getGameRadio is a singleton (no dual radio instances)");

a.setLevel(0.4);
a.start();
ok(a.status().playing === true && a.status().level === 0.4, "start with music level applies volume and plays");
ok(a.audioElementCount() === 2 && made.length === 2, "exactly two audio elements (current + next for crossfade)");
ok(made.some((el) => !el.paused), "at least one element is playing after start");
ok(made[0].src.includes("/audio/radio/house/candlelit-nocturne.m4a"), "first track is Candlelit Nocturne");

a.setLevel(0.15);
ok(a.status().level === 0.15, "volume slider change is applied immediately");

a.setLevel(0);
a.stop();
ok(a.status().playing === false && made.every((el) => el.paused), "mute (level 0) stops playback on both decks");

a.setLevel(0.5);
a.start();
ok(a.status().playing === true && made.some((el) => !el.paused), "turning music back on starts playback again");

resetGameRadioForTests();
made.length = 0;
const loop = getGameRadio();
loop.setLevel(1);
loop.start();
ok(loop.status().index === 0, "fresh radio starts at track 0");
// 6 ended events should land on the last track (index 6), 7th wraps to 0
for (let i = 0; i < 6; i++) {
  const el = made.find((x) => !x.paused) || made[0];
  el.emit("ended");
}
ok(loop.status().index === 6, "sixth advance is the last house track");
(made.find((x) => !x.paused) || made[0]).emit("ended");
ok(loop.status().index === 0, "seventh advance wraps to the first track");

const again = getGameRadio();
ok(again === loop, "after a loop the singleton is still a single instance");
ok(made.length === 2, "still only two audio elements after looping (no extra instances)");

resetGameRadioForTests();

if (failed) { console.error(failed + " in-game-radio check(s) FAILED"); process.exit(1); }
console.log("in-game-radio checks passed");
