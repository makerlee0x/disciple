// Headless rocket-attitude sim (v3, candle model): replays real pool swaps (public/replay.json) plus
// synthetic whale pumps, dumps, nukes and buy/sell "fights" through the engine's actual aimFromMotion() +
// stepHeading(), and asserts: aim ∈ [AIM_MIN, AIM_MAX] = [−60°, 90°] (never past vertical, never beyond a
// 60° nose-down dive → no flip, no wrap), |Δ| < 3° per 60 Hz sim step at 20–144 fps, a hard pump stands it
// vertical (>84°), a fast dump dives it nose-down (<−45°), and buys into a dive pull it up gradually.
// Run: node scripts/test-heading.mjs
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, "../public/flight/engine.js"), "utf8");
const code = src.slice(src.indexOf("/*HEADING-BEGIN*/"), src.indexOf("/*HEADING-END*/"))
  .replace(/^function rocketDrawAngle.*$/m, "");
const { stepHeading, aimFromMotion, AIM_MIN, AIM_MAX, AIM_REST } = new Function(code + "return {stepHeading,aimFromMotion,AIM_MIN,AIM_MAX,AIM_REST};")();
let fail = 0; const bad = (m) => { if (fail++ < 8) console.error("FAIL " + m); };
if (AIM_MIN < -60 || AIM_MAX > 90) bad(`band [${AIM_MIN},${AIM_MAX}] too wide`);
const R = JSON.parse(fs.readFileSync(path.join(dir, "../public/replay.json"), "utf8"));
let events = R.swaps.map((s) => ({ t: (s.ts - R.fromTs) / 20, side: s.side, usd: s.usd }));
const end = events.at(-1).t;
events.push({ t: end + 1, side: "buy", usd: 50000 }, { t: end + 1.3, side: "sell", usd: 900000 }, { t: end + 1.31, side: "buy", usd: 2e6 });
for (let i = 0; i < 120; i++) events.push({ t: end + 3 + i * 0.03, side: i % 2 ? "sell" : "buy", usd: 10 ** (1 + (i % 6)) });
events.push({ t: end + 8, side: "sell", usd: 5e7 });
events.sort((a, b) => a.t - b.t);
const SIM_DT = 1 / 60;
let lo = 1e9, hi = -1e9, maxD = 0, climbMax = 0, dropMin = 1e9;
for (const fps of [30, 60, 144, 20]) {
  const st = { aimDisp: AIM_REST, aimVel: 0, aimTgt: AIM_REST }; let t = 0, i = 0, prev = AIM_REST, acc = 0, vy = 0, kick = 0, kT = -9;
  const dt = 1 / fps;
  while (t < end + 12) {
    t += dt; let net = 0;
    while (i < events.length && events[i].t <= t) { const e = events[i++]; net += (e.side === "buy" ? 1 : -1) * e.usd; }
    if (net) { vy += Math.sign(net) * Math.min(3000, 60 * Math.log10(1 + Math.abs(net)) ** 1.5); kick = net > 0 ? Math.min(1, Math.log10(1 + net) / 6) : -1; kT = t; }
    vy *= Math.exp(-dt / 0.6);
    const k = t - kT < 1 ? kick * 40 * (1 - (t - kT)) : 0, fwdN = 0.5 + 0.5 * Math.sin(t * 0.3);
    acc += dt; let h = st.aimDisp, d = 0;
    while (acc >= SIM_DT - 1e-9) { acc -= SIM_DT; h = stepHeading(st, aimFromMotion(vy, fwdN, k), Math.sin(t) * 6, SIM_DT); d = Math.max(d, Math.abs(h - prev)); prev = h; }
    lo = Math.min(lo, h); hi = Math.max(hi, h); maxD = Math.max(maxD, d);
    if (h < AIM_MIN || h > AIM_MAX || d >= 3 || !Number.isFinite(h)) bad(`fps=${fps} t=${t.toFixed(2)} h=${h} d=${d}`);
  }
}
// steady climbs must stand the rocket up; steady drops must keep the nose up while sinking
for (const [vy, want] of [[600, "climb"], [2000, "climb"], [-600, "drop"], [-1e6, "drop"], [0, "rest"]]) {
  const st = { aimDisp: AIM_REST, aimVel: 0, aimTgt: AIM_REST }; let h = 0; for (let k = 0; k < 240; k++) h = stepHeading(st, aimFromMotion(vy, 0.3, 0), 0, SIM_DT);
  if (want === "climb") { climbMax = Math.max(climbMax, h); if (h < 84) bad(`climb vy=${vy} aim=${h.toFixed(1)} (not nose-up)`); }
  if (want === "drop") { dropMin = Math.min(dropMin, h); if (vy <= -600 && h > -45) bad(`dump vy=${vy} aim=${h.toFixed(1)} (not nose-down)`); }
}
// momentum battle: steady dive, then buys push back (fight +40°) → nose rises gradually, never jumps
{ const st = { aimDisp: AIM_REST, aimVel: 0, aimTgt: AIM_REST }; let h = 0, prev = 0, maxStep = 0;
  for (let k = 0; k < 240; k++) h = stepHeading(st, aimFromMotion(-900, 0.5, 0), 0, SIM_DT);
  const dive = h; prev = h;
  for (let k = 0; k < 90; k++) { h = stepHeading(st, aimFromMotion(-900, 0.5, 40), 0, SIM_DT); maxStep = Math.max(maxStep, Math.abs(h - prev)); prev = h; }
  if (!(h > dive + 25)) bad(`pull-up: dive ${dive.toFixed(1)} → ${h.toFixed(1)}`);
  if (maxStep >= 3) bad(`pull-up step ${maxStep}`);
  console.log(`pull-up: dive ${dive.toFixed(1)}° → ${h.toFixed(1)}° after 1.5 s of buys (max ${maxStep.toFixed(2)}°/step)`); }
// garbage input + tab stalls
for (const v of [NaN, Infinity, -Infinity, undefined]) { const a = aimFromMotion(v, v, v); if (!(a >= AIM_MIN && a <= AIM_MAX)) bad(`aimFromMotion(${v})=${a}`); }
for (const big of [0.05, 0.25, 1]) { const st = { aimDisp: AIM_REST, aimVel: 0, aimTgt: AIM_REST };
  const h = stepHeading(st, 200, 0, big), h2 = stepHeading(st, -200, 0, big);
  if (h < AIM_MIN || h > AIM_MAX || h2 < AIM_MIN || h2 > AIM_MAX || h - AIM_REST > 110 * big + 1e-6) bad(`bigDt=${big} h=${h} h2=${h2}`); }
console.log(`aim range [${lo.toFixed(2)}, ${hi.toFixed(2)}]° above horizontal (= ${(90 - hi).toFixed(1)}–${(90 - lo).toFixed(1)}° from vertical), max Δ/step ${maxD.toFixed(2)}°, steady climb ${climbMax.toFixed(1)}°, steady drop ${dropMin.toFixed(1)}° (band [${AIM_MIN}, ${AIM_MAX}], <3°/step)`);
if (fail) { console.error(`${fail} violations`); process.exit(1); } else console.log("PASS");
