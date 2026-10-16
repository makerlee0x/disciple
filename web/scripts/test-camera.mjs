// Camera smoothness check (pure, headless): drives the engine's stepCamera() with adversarial targets —
// price gaps of 10–10^6 px, replay restarts, sim whales, NaN, tab-resume dt spikes — at 30/60/144 fps and
// asserts per-frame camera delta ≤ CAM_VMAX/fps (no jump), per-frame velocity change ≤ CAM_AMAX/fps, and
// that rocketScreenY keeps the rocket inside the chase-cam band (0.53–0.68 of screen height, anchor 0.60).  Run: node scripts/test-camera.mjs
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, "../public/flight/engine.js"), "utf8");
const code = src.slice(src.indexOf("/*CAMERA-BEGIN*/"), src.indexOf("/*CAMERA-END*/"));
const { stepCamera, rocketScreenY, CAM_VMAX, CAM_AMAX } = new Function(code + "return {stepCamera,rocketScreenY,CAM_VMAX,CAM_AMAX};")();
let fail = 0; const bad = (m) => { if (fail++ < 8) console.error("FAIL " + m); };
let worst = 0, worstV = 0, ryLo = 1, ryHi = 0;
for (const fps of [30, 60, 144]) {
  const st = {}; let target = 0, prev = null, prevV = 0; const dt = 1 / fps;
  for (let f = 0; f < fps * 120; f++) {
    const t = f * dt;
    if (f % Math.round(fps * 1.7) === 0) target += (Math.random() - 0.5) * 10 ** (1 + Math.floor(Math.random() * 6));   // gaps up to 10^6 px
    if (f % (fps * 13) === 0) target = Math.random() * 1e5;                                                           // replay restart
    target += Math.sin(t * 3) * 40 * dt;                                                                               // normal flow
    const tgt = f % 997 === 0 ? NaN : target, step = f % 503 === 0 ? 0.25 : dt;                                        // garbage / tab resume (frame() clamps dt to 0.25)
    const p = stepCamera(st, tgt, step);
    if (prev != null) { const d = Math.abs(p - prev), lim = CAM_VMAX * step + 1e-6;
      const dv = Math.abs(st.camV - prevV), vlim = CAM_AMAX * step + 1e-6;
      if (step === dt) { worst = Math.max(worst, d * (fps / 60)); worstV = Math.max(worstV, dv); }
      if (!(d <= lim) || !(dv <= vlim) || !Number.isFinite(p)) bad(`fps=${fps} f=${f} d=${d} dv=${dv}`); }
    prev = p; prevV = st.camV;
    const ry = rocketScreenY(480, (target - p), 800); if (!(ry >= 800 * 0.53 - 1e-6 && ry <= 800 * 0.68 + 1e-6)) bad(`ry=${ry}`); ryLo = Math.min(ryLo, ry / 800); ryHi = Math.max(ryHi, ry / 800);
  }
}
console.log(`max camera delta ${worst.toFixed(2)} px per 1/60 s frame (cap ${(CAM_VMAX / 60).toFixed(1)}), max Δv ${worstV.toFixed(1)} px/s per frame (cap ${(CAM_AMAX / 30).toFixed(0)} @30fps), rocket y ${ryLo.toFixed(3)}–${ryHi.toFixed(3)} H`);
// hold-to-steer through the lateral camera follow (engine: camX critically damped ω 8 on S.x; the rocket is drawn at camX)
{ const sc = src.slice(src.indexOf("/*STEER-BEGIN*/"), src.indexOf("/*STEER-END*/"));
  const { stepSteer } = new Function(sc + "return {stepSteer};")();
  for (const W of [800, 1440, 2560]) { const st = { x: W / 2, vx: 0 }; let camX = W / 2, camXV = 0, maxJ = 0; const dt = 1 / 60;
    const run = (dir, secs) => { for (let k = 0; k < secs * 60; k++) { stepSteer(st, dir, dt, W); const e = st.x - camX, w = 8, pv = camXV; camXV += (w * w * e - 2 * w * camXV) * dt; camX += camXV * dt; maxJ = Math.max(maxJ, Math.abs(camXV - pv)); } };
    run(1, 1.5); if (!(camX >= W * 0.95)) bad(`hold D 1.5 s: drawn x ${(camX / W * 100).toFixed(1)}% (W=${W})`); const r = camX;
    st.x = camX = W / 2; st.vx = camXV = 0; run(-1, 1.5); if (!(camX <= W * 0.05)) bad(`hold A 1.5 s: drawn x ${(camX / W * 100).toFixed(1)}% (W=${W})`);
    if (W === 1440) console.log(`steer: drawn rocket x after holding D 1.5 s ${(r / W * 100).toFixed(1)}% of width, after A ${(camX / W * 100).toFixed(1)}%`); } }
if (fail) { console.error(`${fail} violations`); process.exit(1); } else console.log("PASS");
