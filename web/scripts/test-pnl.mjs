// PnL consistency (maker lee): one price for what the player sees, trades at and is marked at.
//   uPnL = holdings × (mark − avgEntry); a sell moves exactly the closed uPnL into realized;
//   price up with holdings ⇒ uPnL up; flat price, no trades ⇒ uPnL and realized constant.
//   PAPER: mark = shown mcap (confirmed × sim offset). LIVE: mark = real pool price (no sim/paper offsets).
// Root cause guarded: marks used the real/confirmed mcap while the rocket + HUD showed confirmed × simF (and
// pool paper impact), so the shown mcap rose but uPnL didn't; and realized subtracted exit fee + gas, so it
// never matched the uPnL that was closed.  Uses the engine's actual shownMcap/markMcap + PoolV3Base and
// lib/pnl.ts.   Run: node scripts/test-pnl.mjs
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
const dir = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pnl-"));
for (const f of ["pnl", "config"]) {
  const src = fs.readFileSync(path.join(dir, `../lib/${f}.ts`), "utf8").replace(/from "\.\/config"/g, 'from "./config.mjs"');
  fs.writeFileSync(path.join(tmp, f + ".mjs"), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText);
}
const { applyFill, emptyPosition, view, fmtMoney, fmtPnl, fmtPct, rebase, DEFAULT_SUPPLY } = await import(pathToFileURL(path.join(tmp, "pnl.mjs")).href);
const eng = fs.readFileSync(path.join(dir, "../public/flight/engine.js"), "utf8");
const cls = eng.slice(eng.indexOf("class PoolV3Base {"), eng.indexOf("class ReplaySource"));
const markSrc = eng.slice(eng.indexOf("const isLive="), eng.indexOf("function pushMark(){"));
let ivs = [], tos = [];
const window = {}, S = { confirmed: { mcap: null }, simF: 1 };
const env = { setInterval: (f, ms) => (ivs.push({ f, ms }), ivs.length), clearInterval() {}, setTimeout: (f) => (tos.push(f), 1), window, REPLAY: undefined, S };
const build = new Function(...Object.keys(env), "let source;" + cls + markSrc + "return { PoolV3Base, shownMcap, markMcap, fillMcapEst, setSource:(s)=>{source=s;} };");
const E = build(...Object.values(env));
let fail = 0; const bad = (m) => { fail++; console.error("FAIL " + m); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const SUP = 1e9, t0 = Date.now(), GAS = 0.01;
const uv = (pos) => view(pos, E.markMcap() / SUP, SUP, t0);

// ---- PAPER (sim market): mark = shown price -------------------------------------------------------------
E.setSource({ supply: SUP, impact: () => 1 }); delete window.__discipleTrade;
S.confirmed.mcap = 10000; S.simF = 1;
let pos = applyFill(emptyPosition(), "buy", 100, E.markMcap() / SUP, GAS, t0);
const u0 = uv(pos).uPnl;
// 1) shown mcap rises (sim offset) → uPnL rises, exactly size × (mark − avgEntry)
S.simF = 1.2;
if (!(E.shownMcap() === 12000 && E.markMcap() === 12000)) bad(`paper mark ${E.markMcap()} ≠ shown ${E.shownMcap()}`);
const v1 = uv(pos);
if (!(v1.uPnl > u0)) bad(`price up but uPnL ${u0} → ${v1.uPnl}`);
if (!near(v1.uPnl, pos.size * (12000 / SUP - pos.costBasis / pos.size))) bad("uPnL ≠ size × (mark − avgEntry)");
// confirmed mcap rises too (real trades) → uPnL rises
S.confirmed.mcap = 11000; const v1b = uv(pos); if (!(v1b.uPnl > v1.uPnl)) bad("confirmed mcap up but uPnL did not rise");
console.log(`price up: uPnL ${u0.toFixed(4)} → ${v1.uPnl.toFixed(4)} → ${v1b.uPnl.toFixed(4)} (shown $10.0K → $12.0K → $13.2K)`);
// 2) sell 40% at the mark → realized += closed uPnL portion, exactly
{ const before = uv(pos), price = E.markMcap() / SUP, sellUsd = pos.size * 0.4 * price;
  const q = applyFill(pos, "sell", sellUsd, price, GAS, t0), after = view(q, price, SUP, t0);
  const closed = before.uPnl - after.uPnl, dReal = after.realized - before.realized;
  if (!near(closed, dReal)) bad(`sell: closed uPnL ${closed} ≠ Δrealized ${dReal}`);
  if (!near(closed, before.uPnl * 0.4)) bad(`sell 40%: closed ${closed} ≠ 40% of uPnL ${before.uPnl}`);
  if (!(after.fees > 0)) bad("exit fee + gas not booked");
  console.log(`sell 40%: uPnL ${before.uPnl.toFixed(4)} → ${after.uPnl.toFixed(4)}, realized +${dReal.toFixed(4)} (= closed ${closed.toFixed(4)}), exit fees ${after.fees.toFixed(4)}`);
  pos = q; }
// 3) flat price, no trades, time passes → uPnL + realized constant
{ const a = uv(pos); const later = view(pos, E.markMcap() / SUP, SUP, t0 + 36e5);
  if (a.uPnl !== later.uPnl || a.realized !== later.realized) bad(`flat: ${a.uPnl}/${a.realized} → ${later.uPnl}/${later.realized}`);
  console.log(`flat price 1 h: uPnL ${a.uPnl.toFixed(4)} / realized ${a.realized.toFixed(4)} unchanged`); }
// 4) price down → uPnL down
S.simF = 0.9; if (!(uv(pos).uPnl < view(pos, 13200 / SUP, SUP, t0).uPnl)) bad("price down but uPnL did not fall");

// ---- LIVE: mark = real pool price; flat real price ⇒ constant PnL even while the paper offset decays ----
{ window.__discipleTrade = () => {}; S.simF = 1.3; ivs = [];
  const pool = new E.PoolV3Base(); pool.supply = SUP; pool.real = 0.094; pool.L = 5e20; pool.ethUsd = 3000; pool.emit = (e) => { if (e.mcap) S.confirmed.mcap = e.mcap; };
  E.setSource(pool); S.confirmed.mcap = pool.mcap(); pool.startPaperDecay();
  let q = emptyPosition();
  for (const usd of [250, 250, 500]) { const fill = E.markMcap(); const p = pool.submitTrade("buy", usd); tos.splice(0).forEach((f) => f()); await p; q = applyFill(q, "buy", usd, fill / SUP, GAS, t0); }
  if (!(pool.paper > 1)) bad("paper impact not applied (test setup)");
  if (!near(E.markMcap(), pool.real * SUP)) bad(`live mark ${E.markMcap()} ≠ real ${pool.real * SUP} (sim/paper leaked into live)`);
  const p0 = view(q, E.markMcap() / SUP, SUP, t0).uPnl; let lo = p0, hi = p0;
  for (let i = 0; i < 480; i++) { for (const iv of ivs) iv.f(); const v = view(q, E.markMcap() / SUP, SUP, t0).uPnl; lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (hi - lo > 1e-9) bad(`live PnL drifted ${hi - lo} over 120 s of flat real price`);
  console.log(`live, flat real price 120 s (paper offset decaying, sim ×1.3 ignored): uPnL ${p0.toFixed(4)} drift ${(hi - lo).toExponential(1)}`);
  delete window.__discipleTrade; }
fs.rmSync(tmp, { recursive: true, force: true });
if (fail) process.exit(1); else console.log("PASS");

// shared formatter: $ PnL always 2 decimals, compact ≥ $1K with 2 decimals, percents 1 decimal
{ const eq = (a, b) => { if (a !== b) { console.error(`FAIL fmt: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); process.exit(1); } };
  eq(fmtPnl(0.11), "+$0.11"); eq(fmtPnl(-0.11), "−$0.11"); eq(fmtPnl(0), "+$0.00"); eq(fmtPnl(-0.001), "+$0.00");
  eq(fmtMoney(1.11), "$1.11"); eq(fmtMoney(1), "$1.00"); eq(fmtMoney(999.994), "$999.99"); eq(fmtMoney(1234), "$1.23K");
  eq(fmtMoney(4_560_000), "$4.56M"); eq(fmtMoney(7.89e9), "$7.89B"); eq(fmtPnl(-1234.5), "−$1.23K");
  eq(fmtPct(10.94), "+10.9%"); eq(fmtPct(-23.25), "−23.3%"); eq(fmtPct(0), "+0.0%");
  const eng2 = fs.readFileSync(path.join(dir, "../public/flight/engine.js"), "utf8");
  const mirror = new Function(eng2.match(/function fmtMoney\(v\)\{[^\n]*\n/)[0] + eng2.match(/function fmtPnlUsd\(v\)\{[^\n]*\n/)[0] + "return [fmtMoney, fmtPnlUsd];")();
  for (const v of [0, 0.11, -0.11, 1, 999.994, 1234, -1234.5, 4.56e6, 7.89e9]) { eq(mirror[0](v), fmtMoney(v)); eq(mirror[1](v), fmtPnl(v)); }
  console.log("ok  shared PnL formatter (2-decimal $, compact K/M/B, 1-decimal %) + engine fallback mirror"); }

// ---- audit scenarios (maker lee): mcap vs entry vs realized, 1M supply, fees separate ----
{ let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
  const S7 = DEFAULT_SUPPLY, px = (m) => m / S7, near = (a, b, tol) => Math.abs(a - b) <= tol;
  ok(S7 === 1e6, "default supply is DISCIPLE's 1M");
  let p = applyFill(emptyPosition(), "buy", 100, px(10_000), 0, 0);
  let v = view(p, px(10_000), S7, 0);
  ok(near(v.entryMcap, 10_000 / 0.99, 1), `buy $100 @ $10K: entry mcap ${v.entryMcap.toFixed(0)} (= $10K grossed up by the 1% buy fee)`);
  v = view(p, px(20_000), S7, 0);
  ok(near(v.pnlPct, 98, 0.5) && near(v.uPnl, 98, 0.5), `mcap $10K → $20K: uPnL ${fmtPnl(v.uPnl)} ${fmtPct(v.pnlPct)} (≈ +100% less the 1% fee)`);
  const gain = v.uPnl;
  p = applyFill(p, "sell", v.valueUsd * 0.5, px(20_000), 0, 0, 0.5); v = view(p, px(20_000), S7, 0);
  ok(near(p.realized, gain / 2, 0.01), `sell 50% @ $20K: realized ${fmtPnl(p.realized)} = half the gain`);
  ok(near(v.uPnl, gain / 2, 0.01), `… remaining uPnL ${fmtPnl(v.uPnl)} = the other half`);
  ok(near(v.entryMcap, 10_000 / 0.99, 1), "… entry mcap unchanged by a sell");
  ok(near(p.fees, 99 * 0.01, 0.01) && p.realized + v.uPnl === p.realized + v.uPnl, `… exit fee ${fmtMoney(p.fees)} booked separately (not in realized)`);
  v = view(p, px(15_000), S7, 0);
  ok(near(v.uPnl, p.size * (px(15_000) - p.costBasis / p.size), 1e-9) && near(v.pnlPct, 48.5, 0.5), `mcap drops to $15K: uPnL ${fmtPnl(v.uPnl)} ${fmtPct(v.pnlPct)}`);
  const realizedBefore = p.realized, closing = v.uPnl;
  p = applyFill(p, "sell", 1e9, px(15_000), 0, 0, 1); v = view(p, px(15_000), S7, 0);
  ok(p.size === 0 && v.uPnl === 0 && v.valueUsd === 0, "full sell: holdings 0, uPnL 0, value 0");
  ok(near(p.realized, realizedBefore + closing, 1e-6), `… realized total ${fmtPnl(p.realized)} = earlier realized + closed uPnL`);
  // weighted average entry
  let q = applyFill(emptyPosition(), "buy", 100, px(10_000), 0, 0); q = applyFill(q, "buy", 100, px(20_000), 0, 0);
  ok(near(view(q, px(20_000), S7, 0).entryMcap, 200 / (99 / 10_000 + 99 / 20_000), 1), `two buys $10K + $20K: weighted entry ${fmtMoney(view(q, px(20_000), S7, 0).entryMcap)} (token-weighted)`);
  // guards
  ok(JSON.stringify(applyFill(emptyPosition(), "sell", 50, px(10_000), 0, 0)) === JSON.stringify(emptyPosition()), "sell with no holdings is a no-op");
  const r = applyFill(applyFill(emptyPosition(), "buy", 10, px(10_000), 0, 0), "sell", 1000, px(10_000), 0, 0);
  ok(r.size === 0 && r.realized <= 0, "a sell bigger than the bag closes the bag only (never short)");
  // usd-sized sell at a lower fill price used to sell MORE than 50% of the tokens; frac sells exactly half
  const h = applyFill(emptyPosition(), "buy", 100, px(10_000), 0, 0), half = applyFill(h, "sell", view(h, px(10_000), S7, 0).valueUsd * 0.5, px(9_500), 0, 0, 0.5);
  ok(near(half.size, h.size / 2, 1e-6), "50% preset sells exactly half the tokens even with a worse fill price");
  // supply rebase (ledgers booked with the old 1e9 fallback) keeps $ basis and entry mcap
  const old = { ...applyFill(emptyPosition(), "buy", 100, 10_000 / 1e9, 0, 0), supply: 1e9 }, nb = rebase(old, S7);
  ok(near(view(nb, px(10_000), S7, 0).entryMcap, view(old, 10_000 / 1e9, 1e9, 0).entryMcap, 1e-6) && nb.costBasis === old.costBasis, "supply 1e9 → 1e6 rebase keeps cost basis and entry mcap");
  if (bad) { console.error(bad + " audit scenario(s) FAILED"); process.exit(1); }
  console.log("ok  audit scenarios"); }

// ---- #3 (maker lee, 2026-10): "I own $1.35K of an $8.8K mcap but I'm only up 21%?" — holdings value vs PnL % ----------
// PnL % = uPnL ÷ cost basis = mark ÷ avg-entry price − 1 (fees in the basis): it measures how far the mcap moved since YOUR
// entry, not your share of supply. The DISCIPLE curve starts at $7K (not $0), so even the very first buyer is entering at ≥$7K.
{ let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
  const S7 = DEFAULT_SUPPLY, px = (m) => m / S7;
  // the reported numbers: value $1.35K at $8.8K ⇒ 15.3% of supply; +21% ⇒ cost $1.116K ⇒ avg entry MC = 8.8K / 1.21 ≈ $7.27K
  { const tokens = 1350 / px(8800), cost = 1350 / 1.21, p = { ...emptyPosition(), size: tokens, costBasis: cost, holdStart: 1 }, v = view(p, px(8800), S7, 0);
    ok(Math.abs(v.valueUsd - 1350) < 1e-6 && Math.abs(v.pnlPct - 21) < 1e-9 && Math.abs(v.entryMcap - 8800 / 1.21) < 1e-6,
      `report: $1.35K held at $8.8K MC (${(tokens / S7 * 100).toFixed(1)}% of supply), +21% ⇔ avg entry MC ${fmtMoney(v.entryMcap)} — consistent`);
    ok(Math.abs(v.pnlPct - (8800 / v.entryMcap - 1) * 100) < 1e-9, "identity: PnL % = MCAP ÷ AVG ENTRY MC − 1 (the HUD's AVG ENTRY row explains the %)"); }
  // DISCIPLE bonding curve (x·y = k, spot = x / y; START $7,777, GRADUATION $33,333 at 72% sold; CurveMath.sol / lib/sim)
  const sC = 0.72 * S7, r = Math.sqrt(33_333 / 7_777), y0 = sC * r / (r - 1), x0 = 7_777 / S7 * y0, k = x0 * y0, FEEc = 0.01;
  const mcOf = (y) => k / y / y * S7, buyCurve = (y, usd) => { const y2 = k / (k / y + usd * (1 - FEEc)); return { tokens: y - y2, y2 }; };
  { const m1 = mcOf(y0); ok(Math.abs(m1 - 7777) < 1e-6, "curve mirror: starts at $7,777"); }
  // a launch buy of the reported cost: exact curve fill (paper path) — ledger tokens = curve tokens; uPnL ≥ −fees right after
  { const usd = 1350 / 1.21, f = buyCurve(y0, usd), fillMcap = usd * (1 - FEEc) / f.tokens * S7, post = mcOf(f.y2);
    const p = applyFill(emptyPosition(), "buy", usd, px(fillMcap), GAS, 0), v = view(p, px(post), S7, 0);
    ok(Math.abs(p.size - f.tokens) / f.tokens < 1e-12, `paper: $${usd.toFixed(0)} launch buy books exactly the curve's ${(f.tokens / 1e3).toFixed(3)}K tokens`);
    ok(v.uPnl >= -(usd * FEEc + GAS) - 1e-9, `paper: right after the buy uPnL ${fmtPnl(v.uPnl)} (${fmtPct(v.pnlPct)}) ≥ −fees (marked at the post-trade price $${post.toFixed(0)}, not net of impact)`);
    const v88 = view(p, px(8800), S7, 0);
    ok(v88.pnlPct > 0 && v88.pnlPct < 21, `even the launch buyer of that size is only ${fmtPct(v88.pnlPct)} at $8.8K (avg entry MC ${fmtMoney(v88.entryMcap)}): +21% needs a lower average entry`);
    const best = (8800 / 7777 * (1 - FEEc) - 1) * 100;
    ok(best < 25, `upper bound from a $7,777 start to $8.8K: ${best.toFixed(1)}% (1% fee) — 21% is in range, a 15% stake doesn't change %`); }
  // LIVE booking: was the PRE-trade mark (tokens overstated by ~impact/2); now mark × √(price ratio) = constant-product average
  { const usd = 1000, f = buyCurve(y0, usd), ratio = mcOf(f.y2) / 7777;
    window.__discipleTrade = () => {}; S.simF = 1; S.confirmed.mcap = 7777;
    E.setSource({ supply: S7, realMcap: () => 7777, impact: () => ratio });
    const est = E.fillMcapEst(usd, "buy"), pre = E.markMcap();
    const live = applyFill(emptyPosition(), "buy", usd, px(est), 0, 0), old = applyFill(emptyPosition(), "buy", usd, px(pre), 0, 0);
    const errNew = live.size / f.tokens - 1, errOld = old.size / f.tokens - 1;
    ok(Math.abs(errNew) < 0.002, `live: $1K buy at $7K books ${(live.size / 1e9).toFixed(4)}B vs curve ${(f.tokens / 1e9).toFixed(4)}B (${(errNew * 100).toFixed(2)}%)`);
    ok(errOld > 0.05, `… the old pre-trade booking over-credited ${(errOld * 100).toFixed(1)}% tokens (uPnL ${fmtPct(view(old, px(mcOf(f.y2)), S7, 0).pnlPct)} vs real ${fmtPct(view(live, px(mcOf(f.y2)), S7, 0).pnlPct)})`);
    delete window.__discipleTrade; }
  if (bad) { console.error(bad + " #3 scenario(s) FAILED"); process.exit(1); }
  console.log("ok  #3 holdings vs PnL % scenarios"); }
