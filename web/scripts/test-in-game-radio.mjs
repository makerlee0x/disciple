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
ok(/setGameSettings/.test(hook) && /music: \{ \.\.\.g\.music, vol:/.test(hook) && /music: \{ \.\.\.g\.music, on:/.test(hook),
  "player volume and mute write the existing Music channel, not a second volume");
ok(!/SETTINGS_KEY|disciple:audio-radio|sfx:/.test(hook), "player does not introduce a separate audio storage key");
ok(/useDomCard\("radio"/.test(hook) && /data-card="radio"/.test(hook), "mini player is a DOM card (useDomCard + data-card=radio)");
ok(/right: 16/.test(hook) && /bottom: 16/.test(hook), "default position is bottom right of the screen");
ok(/title="Minimize"/.test(hook) && /Show Radio/.test(hook) && /▸ RADIO/.test(hook), "phone minimize / restore uses Minimize and Show Radio / RADIO");
ok(/Previous track/.test(hook) && /Next track/.test(hook) && /Music volume/.test(hook), "control labels are plain English; volume still uses the Music setting name");
ok(!/data-testid="radio-track"/.test(hook) && !/st\.trackTitle/.test(hook), "the player does not show a track name");
ok(/--radio-vol/.test(hook) && /linear-gradient/.test(hook), "the volume track is filled up to the current Music level");
const layout = readFileSync(join(web, "lib/game/cardLayout.ts"), "utf8");
const chrome = readFileSync(join(web, "components/flight/CardChrome.tsx"), "utf8");
ok(/FLOAT_CARDS[\s\S]*radio/.test(layout) && /radio: "Radio"/.test(layout), "radio is a FLOAT_CARD titled Radio in cardLayout.ts");
ok(/FLOAT_CARDS\.includes/.test(chrome) && /radio: '\[data-card="radio"\]'/.test(chrome), "CardChrome reuses ⠿ / – / × for radio and keeps it out of the slot snap flow");
ok(/startDrag\(id\)/.test(chrome) && /pillMoved/.test(chrome) && /id === "radio"/.test(chrome), "the Radio restore pill reuses CardChrome drag (other pills stay click-to-restore)");
ok(menu.includes("audio-${ch}-toggle") && menu.includes("audio.music") && menu.includes("audio-${ch}-vol"), "settings still use the existing Music toggle and slider");
ok(i18n.includes('"audio.note": "Music plays during a flight.",') && !i18n.includes("Sound effects aren't in yet"), "EN audio.note no longer says sounds don't ship (flight SFX are live)");

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
  setAttribute() {}
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
made.length = 0;

// ---- skip / pause / shuffle / repeat / station picker --------------------------------
const { shuffledOrder, identityOrder, stepTrack, stationList } = await import("../lib/game/stations.ts");
ok(stationList().length === 1 && stationList()[0].id === "house" && stationList()[0].label === "House",
  "the station picker reads STATIONS: one station today, labeled House");
ok(HOUSE_STATION.tracks.every((tr) => typeof tr.title === "string" && tr.title.length > 0), "every house track has a title");

const shuf = shuffledOrder(7, () => 0.99, 2);
ok(shuf.length === 7 && new Set(shuf).size === 7 && shuf[0] === 2, "shuffle is a permutation and can keep the current track first");
ok(JSON.stringify(identityOrder(3)) === "[0,1,2]", "identity order is 0..n-1");
ok(stepTrack([2, 0, 1], 2, 1) === 0 && stepTrack([2, 0, 1], 2, -1) === 1, "prev/next walk the current (possibly shuffled) order and wrap");

const { sanitizeGameSettings, DEFAULT_GAME_SETTINGS } = await import("../lib/game/settings.ts");
ok(DEFAULT_GAME_SETTINGS.radio.shuffle === false && DEFAULT_GAME_SETTINGS.radio.repeat === "station" && DEFAULT_GAME_SETTINGS.radio.station === "house",
  "shuffle and repeat persist with the existing game settings (default: no shuffle, station loop)");
const dirty = sanitizeGameSettings({ radio: { station: "nope", shuffle: 1, repeat: "off" } });
ok(dirty.radio.station === "house" && dirty.radio.shuffle === false && dirty.radio.repeat === "station",
  "unknown station / bad shuffle / a repeat-off mode fall back to house, off, and the station loop");
ok(sanitizeGameSettings({ radio: { shuffle: true, repeat: "one" } }).radio.shuffle === true
  && sanitizeGameSettings({ radio: { shuffle: true, repeat: "one" } }).radio.repeat === "one",
  "saved shuffle on and Repeat one are kept");

const p = getGameRadio();
p.setLevel(0.5);
p.start();
ok(p.status().trackIndex === 0 && p.status().trackTitle === "Candlelit Nocturne", "fresh player starts on the first house track");
p.skip(1);
ok(p.status().trackIndex === 1 && p.status().trackTitle === "Cavernous Reverb" && made.some((el) => !el.paused),
  "next skips to the following track in the station and keeps playing");
p.skip(-1);
ok(p.status().trackIndex === 0, "previous goes back one track");
p.skip(-1);
ok(p.status().trackIndex === 6, "previous wraps from the first track to the last");

p.pause();
ok(p.status().paused === true && p.status().playing === false && made.every((el) => el.paused),
  "pause stops both decks without needing the Music setting flipped off");
ok(p.status().level === 0.5, "pause leaves the music level untouched");
p.start();
ok(p.status().playing === false && p.isPaused() === true, "start() is a no-op while the session is paused");
p.clearPause();
p.start();
ok(p.status().playing === true && p.status().paused === false && made.some((el) => !el.paused),
  "clearPause + start resumes playback (the hook does this when Music is turned on)");

p.setShuffle(true);
ok(p.status().shuffle === true && p.status().trackIndex === 6, "turning shuffle on keeps the current track (last, after wrap) and randomizes the rest");
resetGameRadioForTests();
made.length = 0;
const s = getGameRadio();
s.setLevel(1);
s.start();
s.setShuffle(true);
const first = s.status().trackIndex;
const walk = [first];
for (let i = 0; i < 6; i++) { s.skip(1); walk.push(s.status().trackIndex); }
s.skip(1);
ok(new Set(walk).size === 7, "one shuffle pass visits all 7 house tracks");
ok(s.status().trackIndex === first, "after every track has played, shuffle wraps and still loops");

s.setRepeat("one");
ok(s.status().repeat === "one" && made.some((el) => el.loop === true), "Repeat one sets the current deck to loop this track");
const held = s.status().trackIndex;
(made.find((x) => !x.paused) || made[0]).emit("ended");
ok(s.status().trackIndex === held, "when Repeat one is on, the track does not advance at the end");
s.skip(1);
ok(s.status().trackIndex !== held, "previous/next still skip to another track while Repeat one is on");
s.setRepeat("station");
ok(s.status().repeat === "station", "repeat control toggles back to the default station loop");

// Minimize must not stop playback: the hook only calls stop() on unmount, not when the card is hidden.
ok(/radio\.stop\(\)/.test(hook) && /removeEventListener\("touchstart"/.test(hook), "stop() is only in the unmount cleanup (minimize hides the panel, music keeps playing)");
ok(/hidePanel \? "none"/.test(hook) && !/if \(min\)[\s\S]{0,40}stop\(/.test(hook), "minimizing sets display:none and does not call stop");

resetGameRadioForTests();

if (failed) { console.error(failed + " in-game-radio check(s) FAILED"); process.exit(1); }
console.log("in-game-radio checks passed");
