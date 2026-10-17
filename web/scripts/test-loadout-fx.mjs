// Loadout stats → COSMETIC flight visuals (public/flight/engine.js setLoadout {skin, thruster, noseCoin, accessory, stats}).
//   1. pure: stats clamp/default/round, stat→multiplier mapping (exactly 1 at 5), accessory id sanitizing
//   2. engine: boots engine.js headless (sandboxed like public/flight/replay.js; @napi-rs/canvas, seeded Math.random,
//      sim clock) and runs the SAME scripted paper trades with stats 0 / 5 / 10 / none + an unknown accessory.
//      Trade / mcap / PnL / points / steering state must be identical; stat 5 must render bit-identically to no stats;
//      0 and 10 must render differently. No server needed.
// Run: node scripts/test-loadout-fx.mjs
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { loadLib, SIM_MODULES } from "./lib/load-ts.mjs";
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(web, "public/flight/engine.js"), "utf8");
let bad = 0; const ok = (c, m) => { if (c) console.log("ok   " + m); else { bad++; console.error("FAIL " + m); } };

// ---------- 1. pure helpers, extracted verbatim from engine.js ----------
const grab = (re, what) => { const m = SRC.match(re); if (!m) { ok(false, `engine.js: ${what} not found`); return ""; } return m[0]; };
const P = new Function([grab(/const STAT_KEYS=\[[^\n]*\n/, "STAT_KEYS"), grab(/const FX_RANGE=\{[^\n]*\n/, "FX_RANGE"), grab(/function normStats\(s\)\{[^\n]*\n/, "normStats"),
  grab(/function statMul\(v,lo,hi\)\{[^\n]*\n/, "statMul"), grab(/function accId\(v\)\{[^\n]*\n/, "accId")].join("") + "return {STAT_KEYS,FX_RANGE,normStats,statMul,accId};")();
const all = (v) => Object.fromEntries(P.STAT_KEYS.map((k) => [k, v]));
ok(JSON.stringify(P.normStats(undefined)) === JSON.stringify(all(5)), "no stats → all 5");
ok(JSON.stringify(P.normStats({})) === JSON.stringify(all(5)), "empty stats → all 5");
ok(JSON.stringify(P.normStats("x")) === JSON.stringify(all(5)), "non-object stats → all 5");
const n = P.normStats({ thrust: -3, glow: 12, aura: 4.6, launch: "7", style: "fast" });
ok(n.thrust === 0 && n.glow === 10 && n.aura === 5 && n.launch === 7 && n.style === 5, "clamp 0–10, round, numeric strings, junk → 5: " + JSON.stringify(n));
ok(JSON.stringify(P.normStats({ thrust: Infinity, glow: NaN, aura: null })) === JSON.stringify(all(5)), "Infinity / NaN / null → 5");
ok(P.normStats({ handling: 9 }).style === 9 && P.normStats({ handling: 9, style: 2 }).style === 2 && !("handling" in P.normStats({ handling: 9 })), "legacy handling = alias of style (style wins when present)");
for (const k of P.STAT_KEYS) { const [lo, hi] = P.FX_RANGE[k];
  ok(P.statMul(5, lo, hi) === 1 && P.statMul(0, lo, hi) === lo && Math.abs(P.statMul(10, lo, hi) - hi) < 1e-12, `${k}: 0→${lo} 5→1 10→${hi}`);
  let mono = true; for (let v = 1; v <= 10; v++) if (!(P.statMul(v, lo, hi) > P.statMul(v - 1, lo, hi))) mono = false; ok(mono, `${k}: strictly increasing`); }
{ const [lo, hi] = P.FX_RANGE.thrust; ok(lo === 0.8 && hi === 1.35, "thrust range = 0.8x … 1.35x (spec)"); }
ok(P.accId("halo-wings") === "halo-wings", "accessory id kept");
ok(P.accId("../../etc/Passwd") === "etcpasswd", "accessory id: path chars stripped, lower-cased");
ok(P.accId("Halo Wings!.png") === "halowingspng", "accessory id: [a-z0-9-] only");
ok(P.accId("") === null && P.accId("%%%") === null && P.accId(42) === null && P.accId(null) === null, "accessory id: empty / junk / non-string → none");

// ---------- 2. headless engine ----------
const { mods, cleanup } = await loadLib([...SIM_MODULES, "flight/paperCurve"], "loadoutfx-"); const PAPER = mods["flight/paperCurve"].paperCurve(); cleanup();   // = FlightCanvas __PAPER_CURVE
function mulberry32(a) { a = a >>> 0 || 0x9e3779b9; return function () { a |= 0; a = a + 0x6d2b79f5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const imgCache = new Map();
class ImageShim {   // file-backed image (like public/flight/worker.js's shim): engine swaps IMG[n] to .bitmap in onload
  constructor() { this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; this.onload = null; this.onerror = null; this.bad = false; }
  set src(url) { this._src = url; const f = path.join(web, "public", String(url).replace(/^\/+/, ""));
    const p = imgCache.get(f) || (fs.existsSync(f) ? loadImage(fs.readFileSync(f)) : Promise.reject(new Error("404 " + url))); imgCache.set(f, p);
    p.then((bm) => { this.bitmap = bm; try { bm.complete = true; } catch (_) { /* napi Image: getter */ } this.complete = true; this.naturalWidth = bm.width; this.naturalHeight = bm.height; this.onload && this.onload(); })
      .catch(() => { this.bad = true; this.onerror && this.onerror(); }); }
  get src() { return this._src; }
}
async function boot(loadout, seed = 7) {
  const Wd = 540, Hd = 960; let clockMs = 0, timerId = 0; const timers = [];
  const addTimer = (fn, ms, rep) => { const id = ++timerId; timers.push({ id, at: clockMs + Math.max(0, +ms || 0), ms: Math.max(1, +ms || 0), fn, rep }); return id; };
  const clearTimer = (id) => { const k = timers.findIndex((t) => t.id === id); if (k >= 0) timers.splice(k, 1); };
  const runTimers = () => { for (let g = 0; g < 1000; g++) { let k = -1; for (let i = 0; i < timers.length; i++) if (timers[i].at <= clockMs && (k < 0 || timers[i].at < timers[k].at || (timers[i].at === timers[k].at && timers[i].id < timers[k].id))) k = i;
    if (k < 0) return; const t = timers[k]; if (t.rep) t.at += t.ms; else timers.splice(k, 1); t.fn(); } };
  const M = Object.create(Math); M.random = mulberry32(seed);
  class SimDate extends Date { constructor(...a) { if (a.length) super(...a); else super(1.7e12 + clockMs); } static now() { return 1.7e12 + clockMs; } }
  const listeners = {}, store = new Map([["disciple.sim", "off"], ["disciple.orbs", "on"], ["disciple.chartmap", "off"]]), fills = [];
  const mkCanvas = (w = 1, h = 1) => { const c = createCanvas(w, h); c.style = {}; c.addEventListener = () => {}; c.removeEventListener = () => {}; c.getBoundingClientRect = () => ({ left: 0, top: 0, width: c.width, height: c.height }); return c; };
  const cv = mkCanvas(Wd, Hd);
  const wrap = { clientWidth: Wd, clientHeight: Hd, style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: Wd, height: Hd }) };
  const stubEl = { style: {}, classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, removeEventListener() {}, blur() {}, textContent: "", appendChild() {} };
  const sb = {
    Math: M, Date: SimDate, performance: { now: () => clockMs }, devicePixelRatio: 1, innerWidth: Wd, innerHeight: Hd, Image: ImageShim, Path2D: undefined,
    setTimeout: (f, ms) => addTimer(f, ms, false), setInterval: (f, ms) => addTimer(f, ms, true), clearTimeout: clearTimer, clearInterval: clearTimer,
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    addEventListener: (k, f) => { (listeners[k] || (listeners[k] = [])).push(f); }, removeEventListener() {},
    dispatchEvent: (e) => { if (e.type === "disciple:paperfill") fills.push(JSON.stringify(e.detail)); (listeners[e.type] || []).slice().forEach((f) => { try { f(e); } catch (_) {} }); return true; },
    CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } }, Event: class { constructor(type) { this.type = type; } },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    fetch: () => Promise.reject(new Error("test: no network")),
    location: { search: "", href: "about:test", pathname: "/flight", origin: "" }, navigator: { userAgent: "node" },
    document: { hidden: false, head: stubEl, body: stubEl, addEventListener() {}, removeEventListener() {}, querySelector: () => null,
      getElementById: (id) => (id === "c" ? cv : id === "wrap" ? wrap : stubEl), createElement: (t) => (t === "canvas" ? mkCanvas() : { ...stubEl }) },
    Q_OVERRIDE: new URLSearchParams({ source: "mock", capture: "1", fixedDt: "60", dpr: "1", clean: "1", ticker: "TEST" }),
    __DISCIPLE_BASE_PATH__: "", __PAPER_CURVE: PAPER, __flightLoadout: loadout || null, console: { log() {}, info() {}, warn() {}, error: console.error, debug() {} },
  };
  sb.window = sb.self = sb.globalThis = sb;
  const proxy = new Proxy(sb, { has: (t, k) => k in t || !(k in globalThis), get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : globalThis[k]), set: (t, k, v) => { t[k] = v; return true; } });
  new Function("__sb", "with(__sb){\n" + SRC + "\n}")(proxy);
  const F = sb.__flight; if (!F) throw new Error("engine failed to boot");
  for (let g = 0; g < 400 && !F.assetsReady(); g++) await new Promise((r) => setTimeout(r, 10));
  if (!F.assetsReady()) throw new Error("assets never ready");
  const ctx = cv.getContext("2d");
  const hash = () => { const d = ctx.getImageData(0, 0, cv.width, cv.height).data; let h = 2166136261 >>> 0; for (let i = 0; i < d.length; i += 4) { h ^= (d[i] | d[i + 1] << 8 | d[i + 2] << 16 | d[i + 3] << 24); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
  const step = async (k = 1) => { for (let i = 0; i < k; i++) { clockMs += 1000 / 60; runTimers(); F.step(1); await null; await null; } };
  return { F, S: F.S, fills, hash, step, cv, key: (code, down) => (listeners[down ? "keydown" : "keyup"] || []).forEach((f) => f({ code, repeat: false, target: null, preventDefault() {} })) };
}
const STATE = (E) => { const S = E.S;
  return JSON.stringify({ mcap: S.confirmed.mcap, block: S.confirmed.block, balance: S.balance, simF: S.simF, simT: S.simT, simV: S.simV, hold: S.hold, alt: S.displayAlt, camAlt: S.camAlt,
    x: S.x, vx: S.vx, steer: S.steer, heading: S.heading, aimDisp: S.aimDisp, sway: S.sway, bob: S.bob, bank: S.bank, ry: S.ry, score: S.score, collected: S.collected, streak: S.streak,
    motes: (S.motes || []).length, fuelers: S.fuelers, pending: S.pending.map((p) => [p.side, p.usd, p.state]), promoLeft: S.promoLeft, ach: S.ach, fills: E.fills, t: S.t }); };
async function scripted(loadout) {   // same inputs every run: buys, steering, a sell
  const E = await boot(loadout); const hs = {}; let maxS = 0, maxLife = 0;
  const sample = () => { const Pp = E.S.particles; for (let i = 0; i < Pp.n; i++) { maxS = Math.max(maxS, Pp.a[i].s); } };
  await E.step(60); hs[60] = E.hash();
  E.F.trade("buy", { usd: 20 }); await E.step(40); sample();
  E.key("KeyD", true); await E.step(30); E.key("KeyD", false); sample();
  E.F.trade("buy", { usd: 50 }); await E.step(50); hs[180] = E.hash(); sample();
  E.key("KeyA", true); await E.step(25); E.key("KeyA", false);
  E.F.trade("sell", { usd: 10 }); await E.step(60); hs[265] = E.hash(); sample();
  for (let i = 0; i < E.S.particles.n; i++) maxLife = Math.max(maxLife, 1 / (E.S.particles.a[i].dk || 2.2));
  return { state: STATE(E), hs, maxS, maxLife, lo: E.F.getLoadout(), acc: E.F.accessoryStatus(), E };
}
const base = { skin: "chrome", thruster: "stock", noseCoin: "none" };
const r0 = await scripted({ ...base, stats: all(0) });
const r5 = await scripted({ ...base, stats: all(5) });
const rN = await scripted({ ...base });
const r10 = await scripted({ ...base, stats: all(10), accessory: "definitely-not-a-real-accessory" });
const rX = await scripted({ ...base, stats: { thrust: 99, glow: -4, aura: "x", launch: 10.4, style: 0 } });
ok(r0.state === r5.state && r5.state === r10.state && r10.state === rN.state && rX.state === rN.state, "identical trade / mcap / balance / PnL fills / points / steering state for stats 0, 5, 10, none, junk");
{ const s = JSON.parse(rN.state); ok(s.fills.length >= 2 && s.mcap > 0, `scripted trades actually filled (${s.fills.length} paper fills, mcap ${Math.round(s.mcap)}, balance ${s.balance.toFixed(2)})`); }
ok(JSON.stringify(r5.hs) === JSON.stringify(rN.hs), "stats 5 renders bit-identically to no stats " + JSON.stringify(r5.hs));
ok(r0.hs[180] !== r5.hs[180] && r10.hs[180] !== r5.hs[180] && r0.hs[180] !== r10.hs[180], "stats 0 / 10 render differently from 5 " + JSON.stringify([r0.hs[180], r10.hs[180]]));
ok(r10.maxS > r5.maxS && r0.maxS < r5.maxS, `launch: plume particle size 0:${r0.maxS.toFixed(1)} < 5:${r5.maxS.toFixed(1)} < 10:${r10.maxS.toFixed(1)}`);
ok(Math.abs(r10.maxLife * 2.2 - 1.5) < 1e-9 && Math.abs(r0.maxLife * 2.2 - 0.75) < 1e-9, "launch: plume lifetime ×1.5 at 10, ×0.75 at 0");
ok(JSON.stringify(rN.lo.stats) === JSON.stringify(all(5)) && rN.lo.accessory === null, "getLoadout: default stats 5, accessory null " + JSON.stringify(rN.lo));
ok(JSON.stringify(rX.lo.stats) === JSON.stringify({ thrust: 10, glow: 0, aura: 5, launch: 10, style: 0 }), "getLoadout returns clamped stats " + JSON.stringify(rX.lo.stats));
ok(r10.lo.accessory === "definitely-not-a-real-accessory" && r10.acc.state === "missing", "unknown accessory: kept as id, load fails → state missing, nothing drawn, no throw " + JSON.stringify(r10.acc));
// accessory that exists: write a temporary PNG under public/assets/accessories, check it draws, then remove it
{ const dir = path.join(web, "public/assets/accessories"), had = fs.existsSync(dir), f = path.join(dir, "zz-test-fx.png");
  fs.mkdirSync(dir, { recursive: true }); const c = createCanvas(32, 24), g = c.getContext("2d"); g.fillStyle = "#ff00ff"; g.fillRect(0, 0, 32, 24); fs.writeFileSync(f, c.toBuffer("image/png"));
  try { const a = await boot({ ...base, accessory: "acc-ZZ-test-fx" === "x" ? "" : "zz-test-fx" }), b = await boot({ ...base });
    await a.step(60); await b.step(60);
    ok(a.F.accessoryStatus().state === "ready", "existing accessory loads (state ready) " + JSON.stringify(a.F.accessoryStatus()));
    ok(a.hash() !== b.hash() && STATE({ ...a, fills: a.fills }) .replace(/"t":[^,}]*/, "") === STATE({ ...b, fills: b.fills }).replace(/"t":[^,}]*/, ""), "accessory draws on the rocket, sim state unchanged");
    const d = a.cv.getContext("2d").getImageData(0, 0, a.cv.width, a.cv.height).data; let mag = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 240 && d[i + 1] < 30 && d[i + 2] > 240) mag++;
    ok(mag > 50, `accessory pixels visible (${mag} magenta px)`);
    const s = a.F.setLoadout({ ...base, accessory: "" }); ok(s.accessory === null && a.F.accessoryStatus().state === "none", "clearing the accessory");
  } finally { fs.rmSync(f, { force: true }); if (!had) fs.rmSync(dir, { recursive: true, force: true }); } }
// setLoadout(null) still clears; junk never throws
{ let threw = false; try { r5.E.F.setLoadout(null); r5.E.F.setLoadout({ stats: 5, accessory: {} }); r5.E.F.setLoadout({ stats: { thrust: 10 }, accessory: 7 }); await r5.E.step(3); } catch (e) { threw = e; }
  ok(!threw, "junk loadouts never throw" + (threw ? ": " + threw.message : "")); }
if (bad) { console.error(`\n${bad} failing`); process.exit(1); } console.log("\nPASS");
