// PnL regression: with a flat REAL price and no new trades, the player's PnL must stay constant.
// Root cause guarded here: pool sources apply the player's paper impact as a decaying offset
// (source.paper, τ20 s). Fills were booked at the bumped price and marks followed the decaying offset,
// so PnL bled after the player stopped buying. Fills + marks now use source.realMcap().
// Uses the engine's actual PoolV3Base + markMcap and the app's lib/pnl.ts ledger.   Run: node scripts/test-pnl.mjs
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
const dir = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pnl-"));
for (const f of ["pnl", "config"]) {
  const src = fs.readFileSync(path.join(dir, `../lib/${f}.ts`), "utf8").replace(/from "\.\/config"/g, 'from "./config.mjs"');
  fs.writeFileSync(path.join(tmp, f + ".mjs"), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText);
}
const { applyFill, emptyPosition, view } = await import(pathToFileURL(path.join(tmp, "pnl.mjs")).href);
const eng = fs.readFileSync(path.join(dir, "../public/flight/engine.js"), "utf8");
const cls = eng.slice(eng.indexOf("class PoolV3Base {"), eng.indexOf("class ReplaySource"));
const mark = eng.slice(eng.indexOf("function markMcap(){"), eng.indexOf("function pushMark(){"));
// fake timers so paper decay can be stepped deterministically
let ivs = [], tos = [];
const env = { setInterval: (f, ms) => (ivs.push({ f, ms }), ivs.length), clearInterval() {}, setTimeout: (f) => (tos.push(f), 1), window: {}, REPLAY: undefined, S: { confirmed: { mcap: null } } };
const make = new Function(...Object.keys(env), "source", cls + mark + "return { PoolV3Base, markMcap: () => markMcap() };");
let fail = 0; const bad = (m) => { fail++; console.error("FAIL " + m); };
const S = env.S; let source;
const api = make(...Object.values(env), undefined);
// re-bind with a live source reference
const bind = new Function(...Object.keys(env), cls + mark + "return (src)=>{ source=src; return { PoolV3Base, markMcap }; };");
const pool = new (api.PoolV3Base)(); pool.supply = 1e9; pool.real = 0.094; pool.L = 5e20; pool.ethUsd = 3000; pool.emit = (e) => { if (e.mcap) S.confirmed.mcap = e.mcap; };
const { markMcap } = bind(...Object.values(env))(pool);
pool.startPaperDecay();
let pos = emptyPosition(); const t0 = Date.now();
for (const usd of [250, 250, 500]) {                                            // player buys, paper impact bumps the mark
  const fillAt = markMcap(); const p = pool.submitTrade("buy", usd); tos.splice(0).forEach((f) => f()); await p;
  pos = applyFill(pos, "buy", usd, fillAt / pool.supply, 0.01, t0);
}
if (!(pool.paper > 1)) bad("paper impact not applied (test setup)");
const pnlAt = () => view(pos, markMcap() / pool.supply, pool.supply, t0).uPnl;
const p0 = pnlAt(); let lo = p0, hi = p0;
for (let i = 0; i < 4 * 120; i++) { for (const iv of ivs) iv.f(); const v = pnlAt(); lo = Math.min(lo, v); hi = Math.max(hi, v); }   // 120 s, flat real price
const drift = hi - lo;
if (drift > 1e-9) bad(`PnL drifted ${drift} over 120 s of flat real price`);
// the old behaviour (fill + mark on the paper-bumped mcap) must show the bleed this test guards against
{ const p2 = new (api.PoolV3Base)(); p2.supply = 1e9; p2.real = 0.094; p2.L = 5e20; p2.ethUsd = 3000; p2.emit = () => {}; ivs = []; p2.startPaperDecay();
  let q = emptyPosition(); for (const usd of [250, 250, 500]) { const pr = p2.submitTrade("buy", usd); tos.splice(0).forEach((f) => f()); await pr; q = applyFill(q, "buy", usd, p2.mcap() / p2.supply, 0.01, t0); }
  const a = view(q, p2.mcap() / p2.supply, p2.supply, t0).uPnl; for (let i = 0; i < 480; i++) for (const iv of ivs) iv.f(); const b = view(q, p2.mcap() / p2.supply, p2.supply, t0).uPnl;
  console.log(`old marking (paper-bumped price): PnL ${a.toFixed(4)} → ${b.toFixed(4)} after 120 s flat  (bleed ${(b - a).toFixed(4)})`);
  if (!(b < a - 1e-6)) bad("could not reproduce the old bleed (test is not guarding anything)"); }
// ledger alone: same price, time passing → uPnl constant (hold bonus must not leak into PnL)
{ let q = applyFill(emptyPosition(), "buy", 1000, 0.1, 0.01, t0); const a = view(q, 0.1, 1e9, t0).uPnl, b = view(q, 0.1, 1e9, t0 + 48 * 3.6e6).uPnl; if (a !== b) bad(`ledger uPnl changed with time ${a} → ${b}`); }
console.log(`flat real price, no new trades: PnL ${p0.toFixed(4)} stays within ${drift.toExponential(1)} over 120 s (paper offset decayed ${((pool.paper - 1) * 100).toFixed(3)}% left)`);
fs.rmSync(tmp, { recursive: true, force: true });
if (fail) process.exit(1); else console.log("PASS");
