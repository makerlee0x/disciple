// Headless rocket-attitude sim (v5, full symmetric range): replays real pool swaps (public/replay.json) plus
// synthetic whale pumps, dumps, nukes, buy/sell "fights" and lateral drift / lane swings through the engine's
// actual aimFromMotion() + stepHeading(). θ = 90 − aim = degrees from straight up (+ right, − left).
// Asserts: θ ∈ [−180, 180] on one contiguous interval (never more than 180° from up), |Δ| < 3° per 60 Hz step
// at 20–144 fps, it NEVER crosses the bottom from one side to the other (no wrap, no 360° spin), flat/rising
// prices point up, a dump with no lateral speed points straight down, a dump drifting left/right points
// down-left/down-right, upright lateral lean is small, and buys into a dive pull it up gradually.
// Run: node scripts/test-heading.mjs
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, "../public/flight/engine.js"), "utf8");
const code = src.slice(src.indexOf("/*HEADING-BEGIN*/"), src.indexOf("/*HEADING-END*/"))
  .replace(/^function rocketDrawAngle.*$/m, "");
const { stepHeading, aimFromMotion, AIM_MIN, AIM_MAX, AIM_REST } = new Function(code + "return {stepHeading,aimFromMotion,AIM_MIN,AIM_MAX,AIM_REST};")();
let fail = 0; const bad = (m) => { if (fail++ < 8) console.error("FAIL " + m); };
if (AIM_MIN !== -90 || AIM_MAX !== 270 || AIM_REST !== 90) bad(`band [${AIM_MIN},${AIM_MAX}] rest ${AIM_REST}`);
const th = (aim) => 90 - aim, V0 = 140;
const fresh = () => ({ aimDisp: AIM_REST, aimVel: 0, aimTgt: AIM_REST, lastSide: 1 });
const R = JSON.parse(fs.readFileSync(path.join(dir, "../public/replay.json"), "utf8"));
let events = R.swaps.map((s) => ({ t: (s.ts - R.fromTs) / 20, side: s.side, usd: s.usd }));
const end = events.at(-1).t;
events.push({ t: end + 1, side: "buy", usd: 50000 }, { t: end + 1.3, side: "sell", usd: 900000 }, { t: end + 1.31, side: "buy", usd: 2e6 });
for (let i = 0; i < 120; i++) events.push({ t: end + 3 + i * 0.03, side: i % 2 ? "sell" : "buy", usd: 10 ** (1 + (i % 6)) });
events.push({ t: end + 8, side: "sell", usd: 5e7 });
events.sort((a, b) => a.t - b.t);
const SIM_DT = 1 / 60;
let lo = 1e9, hi = -1e9, maxD = 0, crossings = 0;
for (const fps of [30, 60, 144, 20]) {
  const st = fresh(); let t = 0, i = 0, prev = AIM_REST, acc = 0, vy = 0, kick = 0, kT = -9;
  const dt = 1 / fps;
  while (t < end + 12) {
    t += dt; let net = 0;
    while (i < events.length && events[i].t <= t) { const e = events[i++]; net += (e.side === "buy" ? 1 : -1) * e.usd; }
    if (net) { vy += Math.sign(net) * Math.min(3000, 60 * Math.log10(1 + Math.abs(net)) ** 1.5); kick = net > 0 ? Math.min(1, Math.log10(1 + net) / 6) : -1; kT = t; }
    vy *= Math.exp(-dt / 0.6);
    const k = t - kT < 1 ? kick * 40 * (1 - (t - kT)) : 0, lat = Math.sin(t * 0.7) * (Math.sin(t * 0.13) > 0 ? 1 : 0.3);   // lane swings L↔R
    acc += dt; let h = st.aimDisp, d = 0;
    while (acc >= SIM_DT - 1e-9) { acc -= SIM_DT; const p = th(prev); h = stepHeading(st, aimFromMotion(vy, lat, k, V0, st), 0, SIM_DT); const c = th(h);
      if (Math.abs(p) > 150 && Math.abs(c) > 150 && Math.sign(p) !== Math.sign(c)) crossings++;
      d = Math.max(d, Math.abs(h - prev)); prev = h; }
    lo = Math.min(lo, th(h)); hi = Math.max(hi, th(h)); maxD = Math.max(maxD, d);
    if (h < AIM_MIN || h > AIM_MAX || d >= 3 || !Number.isFinite(h)) bad(`fps=${fps} t=${t.toFixed(2)} aim=${h} d=${d}`);
  }
}
if (crossings) bad(`${crossings} wrap(s) across straight-down`);
if (!(lo < -100 && hi > 100)) bad(`replay never used both sides: θ ∈ [${lo}, ${hi}]`);
const settle = (vy, lat, n = 300, st = fresh(), fight = 0) => { let h = 0; for (let k = 0; k < n; k++) h = stepHeading(st, aimFromMotion(vy, lat, fight, V0, st), 0, SIM_DT); return th(h); };
const rows = [];
const want = (name, v, a, b) => { rows.push(`${name} ${v.toFixed(1)}°`); if (!(v >= a && v <= b)) bad(`${name}: θ=${v.toFixed(1)} not in [${a}, ${b}]`); };
want("flat", settle(0, 0), -1, 1);
want("climb", settle(900, 0), -1, 1);
want("flat drift right", settle(0, 1), 4, 10);
want("flat drift left", settle(0, -1), -10, -4);
want("dump, no lateral → straight down", settle(-1e5, 0), 175, 180);
{ const st = fresh(); st.lastSide = -1; want("dump, no lateral (last side left) → straight down", settle(-1e5, 0, 300, st), -180, -175); }
want("dump drifting right → down-right", settle(-1e5, 1), 135, 160);
want("dump drifting left → down-left", settle(-1e5, -1), -160, -135);
want("mild dip right", settle(-60, 0.5), 10, 60);
want("mild dip left", settle(-60, -0.5), -60, -10);
// side lock: dump down-right, then lateral swings hard left while still dumping → must NOT cross the bottom
{ const st = fresh(); settle(-1e5, 1, 300, st); let prev = th(st.aimDisp), worst = 0;
  for (let k = 0; k < 600; k++) { const c = th(stepHeading(st, aimFromMotion(-1e5, k % 120 < 60 ? -1 : 1, 0, V0, st), 0, SIM_DT)); if (Math.sign(c) !== Math.sign(prev) && Math.abs(c) > 90) bad(`side lock: ${prev} → ${c}`); worst = Math.max(worst, Math.abs(c)); prev = c; }
  if (worst > 180) bad(`>180° from up: ${worst}`);
  // recovery: price flattens → swings back UP the same way, then a left dump tips left
  const up = settle(0, -1, 300, st); const left = settle(-1e5, -1, 300, st);
  rows.push(`side-lock ok; recover ${up.toFixed(1)}° → left dump ${left.toFixed(1)}°`);
  if (!(Math.abs(up) < 12 && left < -135)) bad(`recover/left: ${up} ${left}`); }
// momentum battle: steady dive, then buys push back (fight +40°) → nose rises gradually, never jumps
{ const st = fresh(); const dive = settle(-140, 0.5, 240, st); let prev = st.aimDisp, maxStep = 0, h = 0;
  for (let k = 0; k < 90; k++) { h = stepHeading(st, aimFromMotion(-140, 0.5, 40, V0, st), 0, SIM_DT); maxStep = Math.max(maxStep, Math.abs(h - prev)); prev = h; }
  if (!(Math.abs(th(h)) < Math.abs(dive) - 25)) bad(`pull-up: dive ${dive.toFixed(1)} → ${th(h).toFixed(1)}`);
  if (maxStep >= 3) bad(`pull-up step ${maxStep}`);
  rows.push(`pull-up ${dive.toFixed(1)}° → ${th(h).toFixed(1)}° (max ${maxStep.toFixed(2)}°/step)`); }
// garbage input + tab stalls
for (const v of [NaN, Infinity, -Infinity, undefined]) { const a = aimFromMotion(v, v, v, v, fresh()); if (!(a >= AIM_MIN && a <= AIM_MAX)) bad(`aimFromMotion(${v})=${a}`); }
for (const big of [0.05, 0.25, 1]) { const st = fresh();
  const h = stepHeading(st, 400, 0, big), h2 = stepHeading(st, -400, 0, big);
  if (h < AIM_MIN || h > AIM_MAX || h2 < AIM_MIN || h2 > AIM_MAX || h - AIM_REST > 110 * big + 1e-6) bad(`bigDt=${big} h=${h} h2=${h2}`); }
console.log(rows.join("\n"));
console.log(`replay θ range [${lo.toFixed(1)}, ${hi.toFixed(1)}]° from up (left −, right +), max Δ/step ${maxD.toFixed(2)}°, bottom crossings ${crossings}`);
if (fail) { console.error(`${fail} violations`); process.exit(1); } else console.log("PASS");
