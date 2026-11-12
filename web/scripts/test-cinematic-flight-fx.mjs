// game/cinematic-flight-effects — blast hits, ascension hyperspeed, big-sell drop, flight SFX.
//   Run: tsx scripts/test-cinematic-flight-fx.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (c, msg) => { if (c) console.log("ok  ", msg); else { failed++; console.log("FAIL", msg); } };
const eng = readFileSync(join(web, "public/flight/engine.js"), "utf8");
const canvas = readFileSync(join(web, "components/FlightCanvas.tsx"), "utf8");
const comp = readFileSync(join(web, "components/flight/FlightSfx.tsx"), "utf8");
const i18n = readFileSync(join(web, "lib/game/i18n.ts"), "utf8");
const create = readFileSync(join(web, "app/create/page.tsx"), "utf8");

// ---- engine wiring (static) ---------------------------------------------------------
ok(/function sfx\(k,d\)\{ try\{ dispatchEvent\(new CustomEvent\('disciple:sfx'/.test(eng), "engine only dispatches disciple:sfx (no audio in the engine / worker)");
for (const k of ["fly", "boost", "explode", "tier", "hit", "ascend", "drop"]) ok(new RegExp(`sfx\\('${k}'`).test(eng), `engine sends the ${k} sound`);
ok(/addShock\(x,y,k\);[^\n]*\n\s*sfx\('explode',\{tier:b\.tier\}\); bigSellDrop\(b\.tier\);/.test(eng), "each detonation plays an explosion sized by its bomb tier and drops the rocket on a big one");
ok(/function spawnPuff\(\)\{[^\n]*sfx\('explode',\{tier:0\}\)/.test(eng), "small sells (puffs) get the smallest explosion");
ok(/if\(ti>S\.tierShown\)\{[^}]*sfx\('tier',\{tier:ti\}\); \}/.test(eng), "the tier sound plays only on a climb into a new tier (same rule as TIER WITNESS)");
ok(/cloudThin\(c,d,sh\.R,sh\.amp\); cloudHit\(c,sh,d\); \}/.test(eng), "the shockwave reaching a cloud triggers the cloud hit");
ok(/rocketHit\(SD\.x,SD\.y,sh,f\); \} \}/.test(eng), "the shockwave reaching the rocket triggers the hull hit (wobble kept)");
ok(/S\.hullHit/.test(eng) && /drawRocket\.hc/.test(eng), "the hull flashes hot on a hit");
ok(/c\.hitT!=null&&S\.t-c\.hitT<0\.45/.test(eng), "a hit cloud flashes");
ok(/function setShake\(\)\{ \/\* camera shake removed permanently/.test(eng) && /ctx\.save\(\);   \/\/ camera is stable: no shake of any kind/.test(eng), "no camera shake added (render still has no shake)");
ok(!/takeoff|TAKEOFF|drawTakeoff|ignite\(|padSmoke|sfx\('launch'/.test(eng), "no takeoff cinematic on the game page (no countdown, rumble, ignition, smoke bank or launch sounds)");
ok(/drawBombScreen\(\); drawPnlTag\(\);/.test(eng), "nothing extra drawn over the scene at load");
ok(!/takeoff=1/.test(create), "create page does not send a confirmed launch into a takeoff");
ok(/if\(on&&!S\.graduated&&typeof cineAscend==='function'\) cineAscend\(\);/.test(eng) && /function cineAscend\(\)\{ if\(S\.confirmed&&S\.confirmed\.mcap!=null&&\(S\._preGrad\|\|warpFxOn\(\)\)\) startHyperspeed\(\); \}/.test(eng), "hyperspeed only on a live ascension (not when an ascended coin loads)");
ok(/if\(S\.gradNeedUsd!=null&&d\.graduated!==true\) S\._preGrad=true;/.test(eng), "a curve read with $ left to ascend arms the hyperspeed");
ok(/function warpFxOn\(\)\{ return \(S\.pending\|\|\[\]\)\.some\(p=>p\.state==='pending'&&p\.gradBuy\); \}/.test(eng), "the existing ascension-warp predicate is unchanged");
ok(/const hy=hyperAmt\(\);[\s\S]{0,200}if\(!warpFxOn\(\)&&hy<=0\) return;/.test(eng), "hyperspeed extends drawWarpSpeed instead of a second warp");
ok(/S\.cloudY=S\.camPx\+S\.airPx-\(S\.fallPx\|\|0\);/.test(eng) && /oy=Math\.round\(\(\(S\.cloudY\|\|0\)\*0\.06\)-\(S\.fallPx\|\|0\)\*0\.45\)/.test(eng), "big-sell fall scrolls the clouds and the sky texture");
ok(/\n  S\.ry\+=S\.drop\|\|0;/.test(eng), "big-sell dip moves the rocket on screen");
ok(/'fwd','vyS','fallPx'\]/.test(eng), "fall scroll is interpolated for high-refresh displays");
ok(!/S\.confirmed\.mcap\s*=|S\.displayAlt\s*=/.test(eng.split("@cinefx — blast hits")[1].split("function drawSpeedLines(){")[0]), "@cinefx block never touches the confirmed price or altitude");
ok(!/submitTrade|source\.submit|S\.pending\.push/.test(eng.split("@cinefx — blast hits")[1].split("function drawSpeedLines(){")[0]), "@cinefx block sends no trades");
ok(canvas.includes("<FlightSfx />") && canvas.includes('import FlightSfx from "./flight/FlightSfx"'), "FlightCanvas mounts FlightSfx (flight pages only)");
ok(/audioLevel\("sfx"\)/.test(comp) && /disciple:audio/.test(comp) && /disciple:sfx/.test(comp), "FlightSfx follows the Sound effects channel");
ok(/resumeAudio/.test(comp) && /pointerdown/.test(comp) && /keydown/.test(comp), "sound unlocks on a user gesture like the radio");
ok(!/audioLevel\("music"\)/.test(comp), "SFX never use the Music channel");

// ---- copy -------------------------------------------------------------------------
ok(i18n.includes('"audio.note": "Music and sound effects play during a flight."'), "EN Sound tab line is accurate now that sound effects play");
ok(!i18n.includes("Sound effects aren't in yet") && !i18n.includes("音效还没有加入") && !i18n.includes("효과음은 아직 없습니다") && !i18n.includes("効果音はまだありません") && !i18n.includes("aún no están"), "no language still says sound effects are missing");

// ---- engine pure helpers (extracted) -------------------------------------------------
const grab = (name) => { const m = eng.match(new RegExp(`function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n(?=function |const |S\\.|/\\*)`)); return m ? m[0] : null; };
{
  const src = ["hyperAmt", "bigSellDrop", "dropStep"].map(grab);
  ok(src.every(Boolean), "can extract the hyperspeed / drop helpers");
  if (src.every(Boolean)) {
    const sent = [];
    const S = { t: 0, hyper: null, drop: 0, dropV: 0, fallPx: 0, fallV: 0 };
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const H = 800, DROP_TIER = { 2: [0.07, 0.4], 3: [0.1, 0.65], 4: [0.14, 0.95], 5: [0.19, 1.35] }, DROP_W = 4.5, FALL_TAU = 0.35;
    const lib = new Function("S", "clamp", "H", "DROP_TIER", "DROP_W", "FALL_TAU", "sfx",
      src.join("\n") + "; return {hyperAmt,bigSellDrop,dropStep};")(S, clamp, H, DROP_TIER, DROP_W, FALL_TAU, (k, d) => sent.push({ k, ...d }));
    // hyperspeed envelope
    S.hyper = { t0: 0, dur: 2.8 };
    S.t = 0.1; const a0 = lib.hyperAmt(); S.t = 1.2; const a1 = lib.hyperAmt(); S.t = 2.75; const a2 = lib.hyperAmt(); S.t = 3; const a3 = lib.hyperAmt();
    ok(a0 > 0 && a0 < 1 && a1 === 1 && a2 > 0 && a2 < 0.2 && a3 === 0, "hyperspeed ramps in, holds, fades out, then ends");
    // drop
    ok(lib.bigSellDrop(1) === false && S.dropV === 0, "a grenade (under 5% impact) does not drop the rocket");
    const peaks = [];
    for (const tier of [2, 3, 4, 5]) {
      S.drop = S.dropV = S.fallPx = S.fallV = 0; sent.length = 0;
      ok(lib.bigSellDrop(tier) === true && sent.some((s) => s.k === "drop"), `tier ${tier} drops with the falling sound`);
      let peak = 0, peakT = 0, t = 0; const dt = 1 / 60;
      for (; t < 3; t += dt) { lib.dropStep(dt); if (S.drop > peak) { peak = S.drop; peakT = t; } }
      peaks.push(peak);
      const want = DROP_TIER[tier][0] * H, fall = DROP_TIER[tier][1] * H;
      ok(Math.abs(peak - want) / want < 0.2 && peakT < 0.35, `tier ${tier}: rocket dips ≈${Math.round(want)}px within ${peakT.toFixed(2)}s`);
      ok(Math.abs(S.drop) < 1 && S.drop >= -0.5, `tier ${tier}: dip springs back with no bounce past the anchor`);
      ok(Math.abs(S.fallPx - fall) / fall < 0.05 && S.fallV === 0, `tier ${tier}: world falls ≈${Math.round(fall)}px one way, then stops`);
    }
    ok(peaks.every((v, i) => i === 0 || v > peaks[i - 1]), "bigger sells drop further");
  }
}

// ---- SFX module (fake AudioContext) --------------------------------------------------
let started = 0, nodes = 0;
class Param { constructor(v = 0) { this.value = v; this.events = []; } setValueAtTime(v) { this.value = v; this.events.push(v); return this; } exponentialRampToValueAtTime(v) { this.events.push(v); return this; } setTargetAtTime(v) { this.value = v; this.events.push(v); return this; } cancelScheduledValues() { return this; } }
class Node { constructor() { nodes++; } connect(n) { return n; } }
class Src extends Node { constructor() { super(); this.frequency = new Param(440); this.loop = false; this.stopAt = null; } start() { started++; } stop(t) { this.stopAt = t; } }
class FakeCtx {
  constructor() { this.state = "suspended"; this.currentTime = 0; this.sampleRate = 8000; this.destination = new Node(); }
  createGain() { const n = new Node(); n.gain = new Param(1); return n; }
  createOscillator() { return new Src(); }
  createBufferSource() { return new Src(); }
  createBiquadFilter() { const n = new Node(); n.frequency = new Param(350); n.Q = new Param(1); return n; }
  createDynamicsCompressor() { return new Node(); }
  createBuffer(c, n) { const d = new Float32Array(n); return { getChannelData: () => d }; }
  resume() { this.state = "running"; return Promise.resolve(); }
}
Object.assign(globalThis, { window: globalThis, AudioContext: FakeCtx, addEventListener() {}, dispatchEvent() {} });
const audio = await import("../lib/game/audio.ts");
const sfxMod = await import("../lib/game/sfx.ts");
const { getFlightSfx, EXPLODE, tierFreq, flyGain, SFX_GAP } = sfxMod;
const fx = getFlightSfx();
ok(fx === getFlightSfx(), "one SFX player per page");
fx.setLevel(0.7);
ok(fx.play({ k: "explode", tier: 3 }) === false && started === 0, "no sound before a user gesture (context still suspended)");
await audio.resumeAudio();
ok(audio.getAudioContext().state === "running", "a gesture resumes the shared context");
ok(fx.play({ k: "explode", tier: 3 }) === true && started > 0, "after the gesture, an explosion plays");
const ctx = audio.getAudioContext();
ok(fx.play({ k: "explode", tier: 3 }) === false, "the same sound is rate-limited within its gap");
ctx.currentTime += 1;
for (const k of ["boost", "tier", "hit", "ascend", "drop"]) { ctx.currentTime += 1; ok(fx.play({ k, tier: 4, on: "rocket", v: 0.8 }) === true, `${k} plays`); }
ok(fx.play({ k: "nope" }) === false && fx.play({ k: "launch", beat: 3 }) === false, "unknown kinds (and the removed launch sounds) are ignored");
ok(EXPLODE.length === 6 && EXPLODE.every((p, i) => i === 0 || (p.dur > EXPLODE[i - 1].dur && p.peak > EXPLODE[i - 1].peak && p.lp1 < EXPLODE[i - 1].lp1)), "explosions grow longer, louder and deeper with bomb size (puff → atom)");
ok(tierFreq(0) > 500 && tierFreq(5) > tierFreq(0) && tierFreq(20) < 1050, "tier chime climbs with the tier and stays under an octave");
ok(flyGain(1) > flyGain(0) && flyGain(0) > 0 && flyGain(1) < 0.3, "engine hum is quiet at a hover and louder at speed");
ok(Object.keys(SFX_GAP).length === 7, "every engine sound has a rate limit");
ok(fx.play({ k: "fly", v: 0.4 }) === true && fx.flyOn(), "the engine hum starts when the flight sends its level");
ctx.currentTime += 3; fx.watchdog(); ok(!fx.flyOn(), "the hum fades out if the flight stops sending (tab hidden, page left)");
fx.play({ k: "fly", v: 0.4 });
fx.setLevel(0);
ok(!fx.flyOn(), "muting Sound effects stops the hum at once");
const before = started; ctx.currentTime += 5;
ok(fx.play({ k: "explode", tier: 5 }) === false && fx.play({ k: "fly", v: 1 }) === false && started === before, "muted: nothing plays");
fx.setLevel(0.5); ctx.currentTime += 5;
ok(fx.play({ k: "explode", tier: 5 }) === true, "unmuted: sounds play again at the saved volume");
const settings = await import("../lib/game/settings.ts");
ok(settings.audioLevel("sfx", { ...settings.DEFAULT_GAME_SETTINGS, sfx: { on: false, vol: 0.9 } }) === 0, "Sound effects off = level 0 (the level FlightSfx applies)");

if (failed) { console.error(failed + " cinematic-flight-fx check(s) FAILED"); process.exit(1); }
console.log("cinematic-flight-fx checks passed");
