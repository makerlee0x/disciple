// game/orb-hit-whole-rocket — storm orb and reward orb hits any part of the drawn rocket (tip, wing, body, tail).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url)), web = path.join(dir, "..");
let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
const eng = fs.readFileSync(path.join(web, "public/flight/engine.js"), "utf8");
const i = eng.indexOf("/* @orb-hit"), j = eng.indexOf("/* @orb-hit-end */", i);
if (!(i >= 0 && j > i)) throw new Error("missing @orb-hit block");
const block = eng.slice(i, j + "/* @orb-hit-end */".length);

const ORB = {
  halo: { pts: 5, r: 14 },
  mult: { pts: 5, r: 16 },
  storm: { pts: 25, r: 22 },
  void: { pts: 10, r: 22 },
};
const S = { x: 400, ry: 500, heading: 0, camX: null, sway: 0, bob: 0 };
function nozzleXY() { return [S.x, S.ry]; }
const IMG = { rocket: { naturalWidth: 0, naturalHeight: 0 } };
const F = new Function("S", "ORB", "IMG", "nozzleXY", block + "\nreturn {rocketHits,orbHitsRocket,rocketGeom,hitPoly};")(S, ORB, IMG, nozzleXY);

const g = F.rocketGeom();
ok(g.w === 55 && g.h === 150 && Math.abs(g.pivotY - 144) < 1e-9 && g.nx === 400 && g.ny === 500, `geom: w=${g.w} h=${g.h} pivotY=${g.pivotY} nozzle=(${g.nx},${g.ny})`);
ok(/orbHitsRocket\(m\)/.test(eng) && /orbHitsRocket\(o\)/.test(eng) && !/Math\.abs\(m\.x-S\.x\)<50&&Math\.abs\(m\.y-S\.ry\)<40/.test(eng) && !/Math\.abs\(o\.x-S\.x\)<50&&Math\.abs\(o\.y-S\.ry\)<40/.test(eng), "engine collision uses rocketHits for motes and storm/void orbs; old 50×40 box is gone");

const tip = { x: S.x, y: S.ry - g.pivotY };
const wing = { x: S.x - g.w / 2, y: S.ry + (-g.pivotY + g.h * 0.42) };
const miss = { x: S.x + 200, y: S.ry };
const oldHit = (x, y) => Math.abs(x - S.x) < 50 && Math.abs(y - S.ry) < 40;

ok(!oldHit(tip.x, tip.y), "sanity: the old 50×40 box misses the tip");
ok(F.rocketHits(tip.x, tip.y, 0) && F.orbHitsRocket({ x: tip.x, y: tip.y, k: "halo" }), "hit at tip (reward orb)");
ok(F.orbHitsRocket({ x: tip.x, y: tip.y, k: "storm" }), "hit at tip (storm orb)");
ok(F.rocketHits(wing.x, wing.y, 0) && F.orbHitsRocket({ x: wing.x, y: wing.y, k: "halo" }), "hit at wing tip (reward orb)");
ok(F.orbHitsRocket({ x: wing.x, y: wing.y, k: "storm" }), "hit at wing tip (storm orb)");
ok(!F.rocketHits(miss.x, miss.y, 22) && !F.orbHitsRocket({ x: miss.x, y: miss.y, k: "halo" }) && !F.orbHitsRocket({ x: miss.x, y: miss.y, k: "storm" }), "miss clear of the rocket (reward + storm)");

// a point beside the nozzle that the old box would count, but is clear of the hull
const beside = { x: S.x + 45, y: S.ry };
ok(oldHit(beside.x, beside.y) && !F.rocketHits(beside.x, beside.y, 0), "point beside the tail: old box hits, shape test misses (no radius)");

// storm's larger radius can reach a little farther than a halo
const justOut = { x: wing.x - 16, y: wing.y };
ok(!F.orbHitsRocket({ ...justOut, k: "halo" }) && F.orbHitsRocket({ ...justOut, k: "storm" }), "storm orb radius 22 reaches a little past a halo (14)");

// tilted 90° (nose right): tip is to the right of the nozzle
S.heading = Math.PI / 2;
const tipR = { x: S.x + g.pivotY, y: S.ry };
const wingR = { x: S.x + (g.pivotY - g.h * 0.42), y: S.ry - g.w / 2 };
ok(F.rocketHits(tipR.x, tipR.y, 0), "tilted: hit at tip");
ok(F.rocketHits(wingR.x, wingR.y, 0), "tilted: hit at wing tip");
ok(!F.rocketHits(S.x, S.ry - 200, 14), "tilted: miss well above the rocket");
S.heading = 0;

// frame-time cost of the per-frame collision step (two orbs typical, plus a denser set)
function oldStep(orbs) {
  let n = 0;
  for (const o of orbs) if (Math.abs(o.x - S.x) < 50 && Math.abs(o.y - S.ry) < 40) n++;
  return n;
}
function newStep(orbs) {
  let n = 0;
  for (const o of orbs) if (F.orbHitsRocket(o)) n++;
  return n;
}
function bench(fn, orbs, warmup, iters) {
  for (let i = 0; i < warmup; i++) fn(orbs);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn(orbs);
  return Number(process.hrtime.bigint() - t0) / iters; // ns / call
}
const typical = [
  { x: tip.x, y: tip.y, k: "halo" },
  { x: S.x + 80, y: S.ry - 80, k: "storm" },
];
const dense = [];
for (let i = 0; i < 20; i++) dense.push({ x: S.x + (i - 10) * 12, y: S.ry - i * 8, k: i % 2 ? "storm" : "halo" });
const WARM = 20000, ITERS = 200000;
const typOld = bench(oldStep, typical, WARM, ITERS), typNew = bench(newStep, typical, WARM, ITERS);
const denOld = bench(oldStep, dense, WARM, ITERS), denNew = bench(newStep, dense, WARM, ITERS);
const fmt = (ns) => `${(ns / 1000).toFixed(3)} µs`;
console.log(`timing typical (2 orbs): old ${fmt(typOld)}  new ${fmt(typNew)}`);
console.log(`timing dense (20 orbs):  old ${fmt(denOld)}  new ${fmt(denNew)}`);
ok(typNew < 50e3, `new typical step stays cheap (${fmt(typNew)})`);

if (bad) { console.error(`\n${bad} orb-hit check(s) FAILED`); process.exit(1); }
console.log("orb-hit checks passed");
console.log(JSON.stringify({ typical_ns: { old: typOld, new: typNew }, dense_ns: { old: denOld, new: denNew } }));
