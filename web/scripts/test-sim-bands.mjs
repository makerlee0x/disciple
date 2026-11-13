// FREE PLAY difficulty bands (maker lee, 2026-11-13): flies three scripted pilots (lib/sim/pilots.ts: Newbie, Casual,
// Reader) through N seeded runs per difficulty and fails the build when a green rate is more than 5 points off its
// target, or when the shape of a run drifts: orbit rate, how far a run falls from its high, when the first bomb
// lands, rugs and CTO revivals on Expert, and quiet stretches (no beat in the feed for 20 s).
// Run: node scripts/test-sim-bands.mjs [seeds=200] [minutes=run length, 2]      (BANDS_JSON=path writes the table)
import fs from "node:fs";
import { loadLib } from "./lib/load-ts.mjs";
const { mods, cleanup } = await loadLib(undefined, "bands-");
const { cloneConfig, PLAYER, LAUNCH } = mods["sim/config"];
const { SimRun, fmt } = mods["sim/run"];
const { flyPilot, DIFFICULTY_BANDS, BAND_TOLERANCE } = mods["sim/pilots"];
const N = +(process.argv[2] || 200), MIN = +(process.argv[3] || PLAYER.defaultMinutes), SEC = MIN * 60;
const LABEL = { pve: "Easy", pvp: "Hard", trench: "Expert" };
let fail = 0; const bad = (m) => { fail++; console.error("FAIL " + m); };
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const pct = (x) => (x * 100).toFixed(0) + "%";
// shape targets (plan doc): orbit rate floor, median fall from the high by the end (ceiling), first bomb (≥12% drop
// inside 6 s) by/after a fraction of the run (2 min: Easy after 0:30, Hard by 0:30, Expert by 0:18), Expert rug rate
// and CTO share, and the longest quiet stretch in the feed
const SHAPE = {
  pve:    { orbit: 0.70, fallMax: 0.35, bombAfter: 0.25 },
  pvp:    { orbit: 0.50, fallMax: 0.60, bombBy: 0.25 },
  trench: { orbit: 0.30, bombBy: 0.15, rug: [0.3, 0.5], cto: [0.3, 0.7] },
};
const BEAT_GAP = 20;
const firstBomb = (r) => { let t = null; const w = []; r.on(({ trade }) => { if (!trade || t != null) return; w.push(trade); while (w.length && w[0].t < trade.t - 6) w.shift();
  let hi = 0; for (const x of w) hi = Math.max(hi, x.preMcap); if (trade.mcap < hi * 0.88) t = trade.t; }); return () => t; };
const beats = (r) => { let last = 0, gap = 0; r.on(({ event }) => { if (!event || event.kind === "react" || event.kind === "tw") return; gap = Math.max(gap, event.t - last); last = event.t; }); return () => Math.max(gap, r.t - last); };
const t0 = Date.now(), table = {};
for (const d of ["pve", "pvp", "trench"]) {
  const row = { green: {}, orbit: 0, fall: [], bomb: [], rug: 0, cto: 0, gap: [], peakAt: [], peak: [] };
  for (const pilot of ["newbie", "casual", "reader"]) { let g = 0;
    for (let i = 0; i < N; i++) { const seed = 5000 + i, r = new SimRun(cloneConfig(), d, seed, { minutes: MIN });
      const fb = pilot === "newbie" ? firstBomb(r) : null, bt = pilot === "newbie" ? beats(r) : null;
      flyPilot(r, pilot, SEC, seed); const s = r.summary(); if (s.you.total > 0) g++;
      if (pilot === "newbie") { if (s.graduatedAtS != null) row.orbit++; row.fall.push(1 - s.finalMcap / s.peakMcap); row.bomb.push(fb() ?? SEC); if (s.rug) row.rug++; if (s.cto) row.cto++;
        row.gap.push(bt()); row.peakAt.push(s.peakAtS / SEC); row.peak.push(s.peakMcap); } }
    row.green[pilot] = g / N; }
  row.orbit /= N; row.cto = row.rug ? row.cto / row.rug : 0; row.rug /= N; table[d] = row;
  const B = DIFFICULTY_BANDS[d], S = SHAPE[d];
  console.log(`${LABEL[d].padEnd(6)} ${MIN} min × ${N}: green newbie ${pct(row.green.newbie)} (want ${pct(B.newbie)}) · casual ${pct(row.green.casual)} (${pct(B.casual)}) · reader ${pct(row.green.reader)} (${pct(B.reader)})`);
  console.log(`       orbit ${pct(row.orbit)} · fall from high median ${pct(q(row.fall, 0.5))} · first bomb median ${q(row.bomb, 0.5).toFixed(0)} s · peak median ${fmt(q(row.peak, 0.5))} at ${pct(q(row.peakAt, 0.5))} of the run · rugs ${pct(row.rug)} (CTO ${pct(row.cto)}) · longest quiet ${q(row.gap, 0.5).toFixed(0)} s median, ${Math.max(...row.gap).toFixed(0)} s max`);
  for (const p of ["newbie", "casual", "reader"]) if (Math.abs(row.green[p] - B[p]) > BAND_TOLERANCE) bad(`${LABEL[d]} ${p} green ${pct(row.green[p])}, target ${pct(B[p])} ±${pct(BAND_TOLERANCE)}`);
  if (!(row.green.newbie < row.green.casual && row.green.casual < row.green.reader)) bad(`${LABEL[d]}: skill must pay (newbie < casual < reader)`);
  if (row.orbit < S.orbit - BAND_TOLERANCE) bad(`${LABEL[d]} orbit ${pct(row.orbit)} < ${pct(S.orbit)}`);
  if (S.fallMax != null && q(row.fall, 0.5) > S.fallMax) bad(`${LABEL[d]} median fall from the high ${pct(q(row.fall, 0.5))} > ${pct(S.fallMax)}`);
  if (S.bombAfter != null && q(row.bomb, 0.5) < S.bombAfter * SEC) bad(`${LABEL[d]} first bomb median ${q(row.bomb, 0.5).toFixed(0)} s, want after ${(S.bombAfter * SEC).toFixed(0)} s`);
  if (S.bombBy != null && q(row.bomb, 0.5) > S.bombBy * SEC) bad(`${LABEL[d]} first bomb median ${q(row.bomb, 0.5).toFixed(0)} s, want by ${(S.bombBy * SEC).toFixed(0)} s`);
  if (S.rug && (row.rug < S.rug[0] || row.rug > S.rug[1])) bad(`${LABEL[d]} rug rate ${pct(row.rug)}, want ${pct(S.rug[0])}–${pct(S.rug[1])}`);
  if (S.cto && row.rug && (row.cto < S.cto[0] || row.cto > S.cto[1])) bad(`${LABEL[d]} CTO revives ${pct(row.cto)} of rugs, want ${pct(S.cto[0])}–${pct(S.cto[1])}`);
  if (Math.max(...row.gap) > BEAT_GAP) bad(`${LABEL[d]}: a run went ${Math.max(...row.gap).toFixed(0)} s with no beat (max ${BEAT_GAP} s)`);
  if (d !== "pve" && !(row.green.newbie < table.pve.green.newbie)) bad(`${LABEL[d]} should be harder than Easy for a newbie`);
}
console.log(`(${((Date.now() - t0) / 1000).toFixed(1)} s wall for ${9 * N} runs; start cash $${PLAYER.startBalanceUsd}, orbit at ${fmt(LAUNCH.graduationMcapUsd)})`);
if (process.env.BANDS_JSON) fs.writeFileSync(process.env.BANDS_JSON, JSON.stringify(table, null, 1));
cleanup();
if (fail) process.exit(1); else console.log("PASS");
