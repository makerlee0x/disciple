// Headless rocket-heading sim: replays real pool swaps (public/replay.json) plus synthetic
// whale buys, dumps and nukes through the engine's actual stepHeading() and asserts
// heading ∈ [-15, 88]° and |Δ| < 3° per 60 Hz sim step (display rate 20–144 fps).  Run: node scripts/test-heading.mjs
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, "../public/flight/engine.js"), "utf8");
const code = src.slice(src.indexOf("/*HEADING-BEGIN*/"), src.indexOf("/*HEADING-END*/"))
  .replace(/^function rocketDrawAngle.*$/m, "");
const { stepHeading, AIM_MIN, AIM_MAX } = new Function(code + "return {stepHeading,AIM_MIN,AIM_MAX};")();
const climb = (u) => Math.min(88, Math.max(15, 15 + 22 * Math.log10(1 + Math.max(0, u))));
const R = JSON.parse(fs.readFileSync(path.join(dir, "../public/replay.json"), "utf8"));
let events = R.swaps.map((s) => ({ t: (s.ts - R.fromTs) / 20, side: s.side, usd: s.usd })); // 20× speed
const end = events.at(-1).t;
// stress: whale buy → nuke dump same frame, alternating spam, atom-sized sell
events.push({ t: end + 1, side: "buy", usd: 50000 }, { t: end + 1.3, side: "sell", usd: 900000 },
  { t: end + 1.31, side: "buy", usd: 2e6 });
for (let i = 0; i < 120; i++) events.push({ t: end + 3 + i * 0.03, side: i % 2 ? "sell" : "buy", usd: 10 ** (1 + (i % 6)) });
events.push({ t: end + 8, side: "sell", usd: 5e7 });
events.sort((a, b) => a.t - b.t);
const SIM_DT = 1 / 60;
let fail = 0, lo = 1e9, hi = -1e9, maxD = 0;
for (const fps of [30, 60, 144, 20]) {
  const st = { aimDisp: 0, aimVel: 0, aimTgt: 0 }; let aimDeg = 0, thrustT = -99, t = 0, i = 0, prev = 0, acc = 0;
  const dt = 1 / fps;
  while (t < end + 12) {
    t += dt; let net = 0, any = false;
    while (i < events.length && events[i].t <= t) { const e = events[i++]; net += (e.side === "buy" ? 1 : -1) * e.usd; any = true; }
    if (any && net) { const d = climb(Math.abs(net)); aimDeg = net > 0 ? d : -Math.min(15, d * 0.25); thrustT = t; }
    const since = t - thrustT; let show = aimDeg;
    if (since > 0.12) { const u = Math.min(1, (since - 0.12)); show *= 1 - u * u * (3 - 2 * u); }
    const bank = Math.sin(t * 0.7) * 0.38 * 57.3 * (since > 1 ? 1 : 0.15);
    // engine runs the heading in a fixed 60 Hz sim regardless of display rate (see frame()/simStep)
    acc += dt; let h = st.aimDisp, d = 0;
    while (acc >= SIM_DT - 1e-9) { acc -= SIM_DT; h = stepHeading(st, show, bank, SIM_DT); d = Math.max(d, Math.abs(h - prev)); prev = h; }
    lo = Math.min(lo, h); hi = Math.max(hi, h); maxD = Math.max(maxD, d);
    if (h < -15 || h > 88 || d >= 3 || !Number.isFinite(h)) { if (fail++ < 5) console.error(`FAIL fps=${fps} t=${t.toFixed(2)} h=${h} d=${d}`); }
  }
}
// robustness: a single huge dt (tab stall) must substep, stay clamped, and respect the rate cap
for (const big of [0.05, 0.25, 1]) { const st = { aimDisp: 0, aimVel: 0, aimTgt: 0 };
  const h = stepHeading(st, 88, 0, big); if (h < -15 || h > 88 || h > 110 * big + 1e-6 || !Number.isFinite(h)) { fail++; console.error(`FAIL bigDt=${big} h=${h}`); }
  const h2 = stepHeading(st, -90, 0, big); if (h2 < -15 || h2 > 88) { fail++; console.error(`FAIL bigDt=${big} h2=${h2}`); } }
console.log(`heading range [${lo.toFixed(2)}, ${hi.toFixed(2)}]°, max per-sim-step (1/60 s) Δ ${maxD.toFixed(2)}° (limits [${AIM_MIN}, ${AIM_MAX}], <3°)`);
if (fail) { console.error(`${fail} violations`); process.exit(1); } else console.log("PASS");
