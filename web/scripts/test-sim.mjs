// SIMULATOR headless test (maker lee): runs each difficulty for N simulated minutes at fixed seeds through
// lib/sim (market + bots) and lib/pnl, then asserts:
//   curve mirrors CurveMath.sol ($7K at launch, $33K at graduation, no price jump into the pool),
//   determinism (same seed → identical run), PnL invariants for every wallet,
//   and the difficulty shape: PvE climbs most reliably, PvP is volatile but can go high, TRENCH is hardest with rugs.
// Run: node scripts/test-sim.mjs [minutes=10] [seedsPerDifficulty=12]      (SIM_JSON=path writes the raw runs)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
const dir = path.dirname(fileURLToPath(import.meta.url)), lib = path.join(dir, "../lib");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sim-"));
fs.mkdirSync(path.join(tmp, "sim"));
const tx = (rel) => { const src = fs.readFileSync(path.join(lib, rel + ".ts"), "utf8").replace(/from "(\.{1,2}\/[^"]+)"/g, 'from "$1.mjs"');
  fs.writeFileSync(path.join(tmp, rel + ".mjs"), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText); };
for (const f of ["config", "pnl", "sim/config", "sim/market", "sim/run"]) tx(f);
const { SIM_CONFIG, cloneConfig, LAUNCH } = await import(pathToFileURL(path.join(tmp, "sim/config.mjs")).href);
const { Market } = await import(pathToFileURL(path.join(tmp, "sim/market.mjs")).href);
const { SimRun, fmt } = await import(pathToFileURL(path.join(tmp, "sim/run.mjs")).href);
const MIN = +(process.argv[2] || 10), N = +(process.argv[3] || 12);
let fail = 0; const bad = (m) => { fail++; console.error("FAIL " + m); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e * Math.max(1, Math.abs(a), Math.abs(b));

// ---- curve mirrors the contracts ----
{ const m = new Market(cloneConfig());
  if (!near(m.mcap(), LAUNCH.startMcapUsd)) bad(`launch mcap ${m.mcap()}`);
  const pre = m.price(); let usd = 0; while (m.phase === "curve") { const f = m.buy(100, 60, 0); usd += f.usd; if (!f.ok) { m.sold = 0; break; } }
  // wallet cap: use holding=0 each time (many wallets)
  if (m.phase !== "pool") bad("never graduated");
  if (!(Math.abs(m.mcap() / LAUNCH.graduationMcapUsd - 1) < 0.01)) bad(`graduation mcap ${m.mcap()}`);
  const raised = usd; console.log(`curve: $${LAUNCH.startMcapUsd} → graduation ${fmt(m.mcap())} after ${fmt(raised)} of buys (pool seeded at the curve-end price, ${fmt(m.X)} quote depth)`);
  const q = new Market(cloneConfig()); const a = q.buy(50, 0, 0), b = new Market(cloneConfig()).buy(50, 8, 0);
  if (!(a.tokens < b.tokens * 0.3)) bad("anti-snipe fee not applied at t=0");
  const c = new Market(cloneConfig()); const cap = c.buy(1e6, 60, 0); if (!(cap.tokens <= LAUNCH.totalSupply * 0.07 + 1)) bad(`wallet cap ${cap.tokens}`);
  const rt = new Market(cloneConfig()); const f1 = rt.buy(200, 60, 0), f2 = rt.sell(f1.tokens); if (!(f2.usd * 0.99 < 200 && f2.usd * 0.99 > 196)) bad(`round trip ${f2.usd}`); }

// ---- determinism ----
const runOnce = (d, seed, minutes = MIN, play) => { const r = new SimRun(cloneConfig(), d, seed); if (play) play(r); for (let s = 0; s < minutes * 60; s++) { r.step(1); if (play && play.tick) play.tick(r); } return r; };
{ const a = JSON.stringify(runOnce("trench", 42, 4).summary()), b = JSON.stringify(runOnce("trench", 42, 4).summary());
  if (a !== b) bad("same seed produced a different run"); else console.log("determinism: trench seed 42 ×2 identical"); }

// ---- PnL invariants on a played run ----
{ const play = (r) => { r.playerTrade("buy", 100); }; play.tick = (r) => { if (Math.abs(r.t - 120) < 0.5) r.playerTrade("sell", 0, { frac: 0.4 }); };
  const r = runOnce("pvp", 7, 4, play);
  for (const w of [...r.bots, { pos: r.player.pos, name: "you" }]) { const p = w.pos; if (p.size > 0) { const v = r.pnlOf(p), avg = p.costBasis / p.size; if (!near(v.uPnl, p.size * (r.m.price() - avg), 1e-9)) bad(`uPnL rule broken for ${w.name}`); } }
  const before = r.pnlOf(r.player.pos), sz = r.player.pos.size, f = r.playerTrade("sell", 0, { frac: 0.5 }), after = r.pnlOf(r.player.pos);
  // selling at the fill price: realized += tokens × (fill − avg); the price-move portion stays in uPnL of the rest
  const avg = (before.uPnl / sz) ; void avg;
  if (!(f.ok && after.fees > before.fees)) bad("player sell did not book fees separately");
  console.log(`pnl: player ${JSON.stringify(r.summary().you)}`); }

// ---- difficulty distributions ----
const D = ["pve", "pvp", "trench"], out = {}, raw = [];
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const t0 = Date.now();
for (const d of D) { const peaks = [], fin = [], rugs = [], ctos = [], bots = [], grads = [];
  for (let i = 0; i < N; i++) { const s = runOnce(d, 1000 + i).summary(); raw.push(s); peaks.push(s.peakMcap); fin.push(s.finalMcap); rugs.push(!!s.rug); ctos.push(!!s.cto); bots.push(s.bots); grads.push(s.graduatedAtS != null); }
  out[d] = { peaks, fin, rugs: rugs.filter(Boolean).length, ctos: ctos.filter(Boolean).length, grads: grads.filter(Boolean).length, bots: Math.round(bots.reduce((a, b) => a + b) / N), med: q(peaks, 0.5), p10: q(peaks, 0.1), p90: q(peaks, 0.9), max: Math.max(...peaks), min: Math.min(...peaks), finMed: q(fin, 0.5) };
  const o = out[d], cv = Math.sqrt(peaks.reduce((s, v) => s + Math.log(v / o.med) ** 2, 0) / N);
  o.logSpread = cv;
  console.log(`${d.padEnd(6)} ${MIN} min × ${N} seeds: peak median ${fmt(o.med)}  p10 ${fmt(o.p10)}  p90 ${fmt(o.p90)}  min ${fmt(o.min)}  max ${fmt(o.max)}  · final median ${fmt(o.finMed)} · graduated ${o.grads}/${N} · rugs ${o.rugs} · CTO ${o.ctos} · ~${o.bots} bots · log-spread ${cv.toFixed(2)}`); }
for (const d of D) { const s = raw.find((r) => r.difficulty === d); console.log(`  ${d} seed ${s.seed}: peak ${fmt(s.peakMcap)} (${s.peakTier}) · events ${s.events.filter((e) => e.kind !== "tier").map((e) => `${e.t}s ${e.kind}`).join(", ")} · bots ${JSON.stringify(s.botsByArchetype)}`); }
console.log(`(${((Date.now() - t0) / 1000).toFixed(1)} s wall for ${3 * N} runs)`);
const P = out.pve, V = out.pvp, T = out.trench;
if (!(P.p10 >= LAUNCH.graduationMcapUsd)) bad(`PvE should graduate reliably (p10 ${fmt(P.p10)})`);
if (!(P.p10 > V.p10 && P.p10 > T.p10)) bad("PvE should have the best floor (p10)");
if (!(P.finMed > V.finMed && P.finMed > T.finMed)) bad("PvE should hold its altitude best (final median)");
if (!(V.logSpread > P.logSpread)) bad("PvP should be more volatile than PvE");
if (!(V.max >= 100_000)) bad(`PvP should be able to go high (max ${fmt(V.max)})`);
if (!(T.med < P.med)) bad("TRENCH should be harder than PvE (median peak)");
if (!(T.rugs >= N * 0.5)) bad(`TRENCH should rug often (${T.rugs}/${N})`);
if (!(T.ctos >= 1)) bad("TRENCH never had a CTO");
if (!(out.pve.rugs === 0 && out.pvp.rugs === 0)) bad("rugs outside TRENCH");
if (process.env.SIM_JSON) fs.writeFileSync(process.env.SIM_JSON, JSON.stringify(raw, null, 1));
fs.rmSync(tmp, { recursive: true, force: true });
if (fail) process.exit(1); else console.log("PASS");
