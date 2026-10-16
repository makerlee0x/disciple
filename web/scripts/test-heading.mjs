// Headless rocket-attitude sim (v2, upright model): replays real pool swaps (public/replay.json) plus
// synthetic whale pumps, dumps and nukes through the engine's actual aimFromMotion() + stepHeading(),
// and asserts the rocket stays upright: aim ∈ [AIM_MIN, AIM_MAX] ⊂ [55°, 90°] (≤35° from vertical, never
// past vertical → cannot flip), |Δ| < 3° per 60 Hz sim step at 20–144 fps, climbs read nose-up (>84°),
// drops read as sinking with the nose still up (≥60°).  Run: node scripts/test-heading.mjs
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, "../public/flight/engine.js"), "utf8");
const code = src.slice(src.indexOf("/*HEADING-BEGIN*/"), src.indexOf("/*HEADING-END*/"))
  .replace(/^function rocketDrawAngle.*$/m, "");
const { stepHeading, aimFromMotion, AIM_MIN, AIM_MAX, AIM_REST } = new Function(code + "return {stepHeading,aimFromMotion,AIM_MIN,AIM_MAX,AIM_REST};")();
let fail = 0; const bad = (m) => { if (fail++ < 8) console.error("FAIL " + m); };
if (AIM_MIN < 55 || AIM_MAX > 90) bad(`band [${AIM_MIN},${AIM_MAX}] too wide`);
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
    const k = t - kT < 1 ? kick * (1 - (t - kT)) : 0, fwdN = 0.5 + 0.5 * Math.sin(t * 0.3);
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
  if (want === "drop") { dropMin = Math.min(dropMin, h); if (h < 60 || h > AIM_REST - 5) bad(`drop vy=${vy} aim=${h.toFixed(1)}`); }
}
// garbage input + tab stalls
for (const v of [NaN, Infinity, -Infinity, undefined]) { const a = aimFromMotion(v, v, v); if (!(a >= AIM_MIN && a <= AIM_MAX)) bad(`aimFromMotion(${v})=${a}`); }
for (const big of [0.05, 0.25, 1]) { const st = { aimDisp: AIM_REST, aimVel: 0, aimTgt: AIM_REST };
  const h = stepHeading(st, 200, 0, big), h2 = stepHeading(st, -200, 0, big);
  if (h < AIM_MIN || h > AIM_MAX || h2 < AIM_MIN || h2 > AIM_MAX || h - AIM_REST > 110 * big + 1e-6) bad(`bigDt=${big} h=${h} h2=${h2}`); }
console.log(`aim range [${lo.toFixed(2)}, ${hi.toFixed(2)}]° above horizontal (= ${(90 - hi).toFixed(1)}–${(90 - lo).toFixed(1)}° from vertical), max Δ/step ${maxD.toFixed(2)}°, steady climb ${climbMax.toFixed(1)}°, steady drop ${dropMin.toFixed(1)}° (band [${AIM_MIN}, ${AIM_MAX}], <3°/step)`);
if (fail) { console.error(`${fail} violations`); process.exit(1); } else console.log("PASS");
