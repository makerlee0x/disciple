// 3D flight view (Three.js WebGPURenderer, WebGL 2 fallback) — lee said go Nov 11 2026.
//   1. drawing path + quality preset picks (pure: lib/flight/view3d/detect.ts)
//   2. frame governor: lowers resolution, then drops 3D frames — never anything else
//   3. the engine only HANDS the 3D view finished events + a snapshot; the trade / submit path never touches it
//   4. what the 3D path no longer draws in 2D (rings, rays, flat rocket, 2D sky/clouds), and what it keeps (HUD overlays)
//   5. no takeoff / countdown / ignition on the game page; flight sounds on the Sound effects channel
//   Run: npx tsx scripts/test-webgpu-flight-view.mjs
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url"; import { execSync } from "node:child_process";
const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
const rd = (f) => fs.readFileSync(path.join(web, f), "utf8");
const D = await import(path.join(web, "lib/flight/view3d/detect.ts"));

console.log("— 1. drawing path and quality");
ok(D.wants3D("?coin=0xabc", "main") === true, "3D on by default on the main-thread renderer");
ok(D.wants3D("?view=2d", "main") === false && D.wants3D("view=off", "main") === false, "?view=2d / off → the 2D flight");
ok(D.wants3D("", "worker") === false, "worker rendering keeps 2D (3D needs the page's main thread)");
ok(D.forcedBackend("?renderer=webgl") === "webgl" && D.forcedBackend("") === null && D.forcedBackend("?renderer=webgpu") === null, "?renderer=webgl forces the WebGL 2 path; nothing else forces");
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";
const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0 Safari/537.36";
ok(D.pickQuality({ userAgent: iphone, innerWidth: 390, innerHeight: 844 }) === "lite", "iPhone → lite preset");
ok(D.pickQuality({ userAgent: android, innerWidth: 412, innerHeight: 915 }) === "lite", "Android phone → lite preset");
ok(D.pickQuality({ uaMobile: true, userAgent: mac }) === "lite", "userAgentData.mobile → lite");
ok(D.pickQuality({ userAgent: mac, innerWidth: 1440, innerHeight: 900 }) === "full", "desktop → full preset");
ok(D.pickQuality({ userAgent: mac, innerWidth: 700, innerHeight: 900 }) === "lite", "narrow window (≤760, the phone HUD width) → lite");
ok(D.pickQuality({ userAgent: mac, innerWidth: 1440, innerHeight: 900, hardwareConcurrency: 2 }) === "lite", "2-core device → lite");
ok(D.pickQuality({ search: "?gfx=full", userAgent: iphone }) === "full" && D.pickQuality({ search: "gfx=lite", userAgent: mac }) === "lite", "?gfx=lite|full overrides");
const L = D.PRESETS.lite, F = D.PRESETS.full;
ok(L.maxPixelRatio < F.maxPixelRatio && L.bgScale < F.bgScale && !L.antialias, "lite: lower resolution, smaller sky backdrop, no MSAA");
ok(["clouds", "stars", "fire", "smoke", "sparks", "debris", "exhaust", "trail"].every((k) => L[k] < F[k]), "lite: fewer clouds, stars and particles of every kind");
ok(await D.hasWebGPU(undefined) === false, "no navigator.gpu → WebGL 2");
ok(await D.hasWebGPU({ requestAdapter: async () => null }) === false, "navigator.gpu with no adapter (blocklisted GPU / acceleration off) → WebGL 2");
ok(await D.hasWebGPU({ requestAdapter: async () => { throw new Error("x"); } }) === false, "requestAdapter throws → WebGL 2");
ok(await D.hasWebGPU({ requestAdapter: () => new Promise(() => {}) }, 30) === false, "requestAdapter hangs → WebGL 2 after the timeout");
ok(await D.hasWebGPU({ requestAdapter: async () => ({}) }) === true, "an adapter → WebGPU");

console.log("— 2. frame governor");
{ const g = D.govInit(F, 2); const acts = []; for (let i = 0; i < 2000; i++) { const a = D.govStep(g, F, 30); if (a) acts.push(a); }
  ok(acts[0] === "down" && acts.includes("skip") && g.ratio === F.minPixelRatio && g.skip === 1, `slow 3D frames: resolution steps down to ${F.minPixelRatio}, then 3D frames are dropped (${acts.join(",")})`);
  const b = []; for (let i = 0; i < 3000; i++) { const a = D.govStep(g, F, 0.5); if (a) b.push(a); }
  ok(b[0] === "unskip" && b.includes("up"), "cheap frames again: stops dropping, then sharpens back up"); }
{ const g = D.govInit(L, 3); ok(g.ratio === L.maxPixelRatio, "phone at devicePixelRatio 3 starts at the lite cap (1.25), not 3"); }

console.log("— 3. trades never go through the 3D view");
const eng = rd("public/flight/engine.js");
const block = (a, b) => { const i = eng.indexOf(a), j = eng.indexOf(b, i); if (!(i > 0 && j > i)) throw new Error("engine block " + a); return eng.slice(i, j); };
// the same blocks on origin/main (when git has it) must be byte-identical: Boost and Dump use the exact same sending code
let mainEng = null; try { mainEng = execSync("git show origin/main:web/public/flight/engine.js", { cwd: web, encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] }); } catch { /* no git / no origin */ }
const MAIN_BLOCK = (a, b) => { if (!mainEng) return eng.slice(eng.indexOf(a), eng.indexOf(b, eng.indexOf(a))); const i = mainEng.indexOf(a), j = mainEng.indexOf(b, i); return mainEng.slice(i, j); };
const tradePath = block("function trade(side,opt){", "function baConfirm(");
const submitPath = block("function submit(side,usd,force,opt,pct){", "function tradeNote(");
ok(!/F3EV|v3\(|v3Drop|__flight3d|sfx\(/.test(tradePath) && !/F3EV|v3\(|v3Drop|__flight3d|sfx\(/.test(submitPath) && tradePath === MAIN_BLOCK("function trade(side,opt){", "function baConfirm(") && submitPath === MAIN_BLOCK("function submit(side,usd,force,opt,pct){", "function tradeNote("), "trade() and submit() have no 3D / sound calls (same sending code as main)");
const shoot = eng.match(/addEventListener\('disciple:shoot',[\s\S]*?\}\);/);
ok(shoot && !/F3|v3|__flight3d/.test(shoot[0]), "the BOOST / DUMP 'disciple:shoot' listener has no 3D calls");
ok(/function F3EV\(e\)\{ const F=v3\(\); if\(F\) try\{ F\.ev\(e\); \}catch\(_\)\{\} \}/.test(eng), "events to the 3D view are fire-and-forget (try/catch, no await, no return value used)");
const idx = (re) => eng.search(re);
ok(idx(/sfx\('explode',\{tier:b\.tier\}\)/) > idx(/function detonate\(b\)\{/) && idx(/F3EV\(\{k:'boom'/) > idx(/function detonate\(b\)\{/), "hull blasts come from detonate() — after the sell already happened");
const fc = rd("components/FlightCanvas.tsx");
ok(/import\("@\/lib\/flight\/view3d"\)/.test(fc) && !/from "@\/lib\/flight\/view3d"/.test(fc) && !/from "three/.test(fc), "Three.js loads in its own chunk, after the engine starts (dynamic import, not awaited by boot)");
const idx3 = rd("lib/flight/view3d/index.ts");
ok(/import\("three\/webgpu"\)/.test(idx3) && /import\("three"\)/.test(idx3) && /WebGLRenderer/.test(idx3) && /WebGPURenderer/.test(idx3), "WebGPURenderer when WebGPU is there, WebGLRenderer (WebGL 2) otherwise");
ok(/isWebGPUBackend/.test(idx3) && /falling back to WebGL 2/.test(idx3), "a WebGPU device that does not start falls back to WebGL 2");
ok(/fail\(e\)/.test(idx3) && /handle\.ready = false/.test(idx3), "any 3D error turns the layer off → the engine draws the 2D flight again");

console.log("— 4. what the 3D path draws");
const r3 = block("function render3(dt,F3){", "function render(dt){");
ok(!/drawClouds|drawSpeedLines|drawWarpSpeed|drawTickTrail|drawBombs\(|drawRocket\(|drawRocketBody/.test(r3), "3D path: no 2D clouds, speed lines, warp rays, line contrail, 2D blast rings or flat rocket");
ok(/drawBg\(\)/.test(r3) && /ctx=B;/.test(r3) && /ctx=CTX_MAIN/.test(r3), "the tier sky plates are drawn into the 3D view's backdrop canvas (same art, behind the 3D layer)");
ok(["drawLevels", "drawEntryLine", "drawFx", "drawPendingGhosts", "drawTrampWalls", "drawBombScreen", "drawPnlTag", "drawHud", "drawChartMap", "cardPublish"].every((f) => r3.includes(f + "(")), "HUD and gameplay overlays stay on the 2D canvas (levels, entry line, orbs, pending ghosts, tramps/walls, bomb labels, PnL tag, HUD, chart)");
ok(/const V3W=typeof window!=='undefined'&&window\.__flight3dWant===true;/.test(eng) && /V3W\?\{alpha:true\}:\{alpha:false,desynchronized:true\}/.test(eng), "the 2D canvas is transparent only when the 3D layer is mounted; otherwise exactly as before");
const sc = rd("lib/flight/view3d/scene.ts");
ok(/hullPoint\(\)/.test(sc) && /scorch/.test(sc) && /this\.stut/.test(sc) && /debris/.test(sc), "hits: fireball on the hull, scorch, debris, stutter and knock");
ok(/hyper \* 700 \* dt/.test(sc) && /starAmt = Math\.max\(smooth\(2\.6, 4\.2, V\.band\), hyper\)/.test(sc), "hyperspeed: clouds and stars rush past (the world moves, nothing radiates from the rocket)");
ok(/V\.H \* 0\.82 - V\.y/.test(sc), "big-sell drop never pushes the rocket out of the flight lane");
ok(/ROCKET_H = 150/.test(rd("lib/flight/view3d/rocket.ts")) && /H \/ 2 \/ TANH/.test(sc), "same framing: flight plane maps 1:1 to screen px, rocket 150 px tall at the engine's nozzle point");

console.log("— 5. no takeoff on the game page; sounds");
const all = [eng, fc, idx3, sc, rd("lib/game/sfx.ts"), rd("components/flight/FlightSfx.tsx")].join("\n");
ok(!/takeoff=1|countdown|3-2-1|ignition/i.test(all.replace(/snipeCountdown|SnipeCountdown|SNIPE_COUNTDOWN|snipe countdown|countdown chip|launch countdown/gi, "")), "no takeoff / 3-2-1 / ignition in the flight engine, 3D view or sounds");
ok(/<FlightSfx \/>/.test(fc), "FlightSfx is mounted on the flight");
const sfx = rd("lib/game/sfx.ts");
ok(/"fly" \| "boost" \| "explode" \| "tier" \| "hit" \| "ascend" \| "drop"/.test(sfx), "sounds: flying, boost, explosions by size, new tier, hit, ascension, drop");
for (const k of ["fly", "boost", "explode", "tier", "drop"]) ok(new RegExp(`sfx\\('${k}'`).test(eng), `engine sends '${k}'`);
ok(rd("lib/game/i18n.ts").includes("Music and sound effects play during a flight."), "Sound tab note says sound effects are in");

console.log(bad ? `\n${bad} FAILED` : "\nall ok");
process.exit(bad ? 1 : 0);
