// Auto-centre (maker lee): no steering for 1.5 s ⇒ rocket eases back to the horizontal centre over ~2–3 s,
// critically damped (no overshoot), any input cancels at once, never stuck at an edge.  Run: node scripts/test-recenter.mjs
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/flight/engine.js"), "utf8");
const sc = src.slice(src.indexOf("/*STEER-BEGIN*/"), src.indexOf("/*STEER-END*/"));
const { stepSteerAuto, steerMargin } = new Function(sc + "return {stepSteerAuto, steerMargin};")();
let fail = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fail++; };
const dt = 1 / 60;
for (const W of [1216, 1440, 1856]) {
  const m = steerMargin(W), c = W / 2;
  for (const [name, x0] of [["left edge", m], ["right edge", W - m], ["beyond edge (stale after resize)", -500], ["off-centre", c + 200]]) {
    const st = { x: x0, vx: 0 }; let t = 0, held = x0, over = 0, settle = null, prevD = Math.abs(x0 - c);
    for (; t < 1.45; t += dt) stepSteerAuto(st, 0, dt, W);
    const atIdle = st.x;
    for (; t < 8; t += dt) { stepSteerAuto(st, 0, dt, W); const d = st.x - c;
      if (Math.sign(d) !== Math.sign(atIdle - c) && Math.abs(d) > 0.5) over = Math.max(over, Math.abs(d));
      if (settle == null && Math.abs(d) < 0.02 * Math.max(1, Math.abs(atIdle - c))) settle = t - 1.5; prevD = Math.abs(d); }
    ok(Math.abs(atIdle - Math.max(m, Math.min(W - m, x0))) < 2 || x0 < m, `W${W} ${name}: holds still during the 1.5 s grace (${atIdle.toFixed(1)})`);
    ok(Math.abs(st.x - c) < 1, `W${W} ${name}: ends centred (${st.x.toFixed(1)} vs ${c})`);
    ok(settle != null && settle >= 1.2 && settle <= 3.5, `W${W} ${name}: settles in ${settle?.toFixed(2)} s (2–3 s window ±)`);
    ok(over < 1, `W${W} ${name}: no overshoot (${over.toFixed(2)} px)`);
  }
  // input cancels immediately; idle restarts the grace period
  const st = { x: c + 300, vx: 0 }; let t = 0; for (; t < 2.2; t += dt) stepSteerAuto(st, 0, dt, W);
  const before = st.x; stepSteerAuto(st, 1, dt, W); ok(st.vx > 0 && st.idle === 0, `W${W}: steering right cancels the recenter at once (vx ${st.vx.toFixed(0)})`);
  for (let k = 0; k < 30; k++) stepSteerAuto(st, 1, dt, W); ok(st.x > before, `W${W}: steering wins over the recenter`);
  const xr = st.x; for (let k = 0; k < 60; k++) stepSteerAuto(st, 0, dt, W);
  ok(Math.abs(st.vx) < 40 && st.idle < 1.5, `W${W}: after release it coasts to a stop (no immediate recenter)`);
}
if (fail) { console.error(`${fail} FAILED`); process.exit(1); } console.log("PASS");
