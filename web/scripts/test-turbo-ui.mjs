// TURBO game-side tests (GAME). SITE's adapter/maths has its own suite (test:turbo, scripts/test-turbo.mts); this one checks
// what the screens rely on: liq incl. fees (long/short), after-fees PnL, partial close, TP/SL triggers (pure + via the
// practice adapter), beep thresholds, presets persistence, heads-up, jetstream + big-win rules.   Run: node scripts/test-turbo-ui.mjs
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
const dir = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "turbo-ui-"));
for (const f of ["types", "math", "fuel", "mockAdapter", "gameFx", "prefs"]) {
  const src = fs.readFileSync(path.join(dir, `../lib/turbo/${f}.ts`), "utf8").replace(/from "\.\/(\w+)"/g, 'from "./$1.mjs"');
  fs.writeFileSync(path.join(tmp, f + ".mjs"), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText);
}
const imp = (f) => import(pathToFileURL(path.join(tmp, f + ".mjs")).href);
const M = await imp("math"), { createMockAdapter } = await imp("mockAdapter"), { createFuelStore } = await imp("fuel");
const G = await imp("gameFx"), P = await imp("prefs");
let fail = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fail++; console.error("FAIL " + m); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const origWarn = console.warn; console.warn = () => {};

// 1) wipeout price includes fees + funding: at liq, PnL after fees = −80% of the bet (long + short), and fees pull it closer
for (const side of ["long", "short"]) for (const lev of [100, 250, 500, 1000]) {
  const C = 10, N = C * lev, E = 67_000, bps = 1, open = M.feeUsd(N, bps), funding = -0.002;
  const liq = M.liquidationPrice({ side, collateralUsd: C, sizeUsd: N, entry: E, openFeeUsd: open, fundingUsd: funding, feeBps: bps, liqLossFrac: 0.8 });
  const b = M.pnlBreakdown({ side, sizeUsd: N, entry: E, price: liq, openFeeUsd: open, fundingUsd: funding, feeBps: bps });
  ok(near(b.pnlAfterFeesUsd, -0.8 * C, 1e-9), `${side} ${lev}× after-fees PnL at wipeout ${b.pnlAfterFeesUsd}`);
  const noFee = M.liquidationPrice({ side, collateralUsd: C, sizeUsd: N, entry: E, openFeeUsd: 0, fundingUsd: 0, feeBps: 0, liqLossFrac: 0.8 });
  ok(side === "long" ? liq > noFee && liq < E : liq < noFee && liq > E, `${side} ${lev}× fees move wipeout closer`);
  ok(M.isLiquidated(side, liq, liq) && G.isLiquidated(side, liq, liq), `${side} at liq counts as wiped`);
}
// 2) after-fees PnL = price PnL − open − close(at price) + funding
{
  const b = M.pnlBreakdown({ side: "long", sizeUsd: 1000, entry: 100, price: 101, openFeeUsd: 0.1, fundingUsd: -0.01, feeBps: 1 });
  ok(near(b.pnlUsd, 10) && near(b.closeFeeUsdEst, 0.101) && near(b.pnlAfterFeesUsd, 10 - 0.1 - 0.101 - 0.01), `after fees long ${b.pnlAfterFeesUsd}`);
  const s = M.pnlBreakdown({ side: "short", sizeUsd: 1000, entry: 100, price: 101, openFeeUsd: 0.1, fundingUsd: 0.01, feeBps: 1 });
  ok(near(s.pnlAfterFeesUsd, -10 - 0.1 - 0.101 + 0.01), `after fees short ${s.pnlAfterFeesUsd}`);
}
// 3) practice adapter end-to-end: open → fill → partial closes → close; fuel adds up
const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const mk = (o = {}) => { const fuel = createFuelStore({ storage: mem(), initialUsd: 0 }); return createMockAdapter({ autoStart: false, fillDelayMs: 1500, fuel, seed: 7, ...o }); };
{
  const a = mk(), ev = [];
  a.onEvent((e) => ev.push(e));
  await a.addFuel(100);
  ok((await a.getFuel()).usd === 100, "add fuel");
  const { id } = await a.open({ market: "BTC", side: "long", collateralUsd: 10, leverage: 100 });
  ok(ev[0]?.type === "pending" && (await a.getFuel()).usd === 90, "pending + bet taken from fuel");
  a.setPrice("BTC", 67_000); a.flushFills();
  ok(ev.some((e) => e.type === "filled"), "filled");
  a.setPrice("BTC", 67_067);  // +0.1% → +$1 per $1000 notional
  const [p0] = await a.getPositions();
  await a.close(id, 25);
  const pc = ev.find((e) => e.type === "partial-closed");
  const exp = M.closeSlice({ side: "long", sizeUsd: p0.sizeUsd, entry: p0.entry, price: 67_067, openFeeUsd: p0.openFeeUsd, fundingUsd: p0.fundingUsd, feeBps: 1, collateralUsd: p0.collateralUsd }, 0.25);
  ok(pc && pc.pct === 25 && near(pc.returnedUsd, exp.returnedUsd, 1e-3), `25% returns ${pc?.returnedUsd} vs ${exp.returnedUsd}`);
  const [p1] = await a.getPositions();
  ok(near(p1.collateralUsd, 7.5, 1e-6) && near(p1.sizeUsd, p0.sizeUsd * 0.75, 1e-6), `75% left (${p1.collateralUsd}, ${p1.sizeUsd})`);
  await a.close(id, 50);
  const [p2] = await a.getPositions();
  ok(near(p2.collateralUsd, 3.75, 1e-6), `50% of the rest left ${p2.collateralUsd}`);
  await a.close(id, 100);
  ok(ev.at(-1).type === "closed" && ev.at(-1).reason === "manual" && (await a.getPositions()).length === 0, "close all");
  const back = ev.filter((e) => e.returnedUsd != null).reduce((s, e) => s + e.returnedUsd, 0);
  ok(near((await a.getFuel()).usd, 90 + back, 1e-2), "fuel = what's left + everything returned");
  a.dispose();
}
// 4) TP / SL / wipeout triggers (pure: wipe > SL > TP) and via the adapter (close reasons)
{
  const o = { liqPrice: 95, tpPrice: 110, slPrice: 97 };
  ok(G.trigger("long", 111, o) === "tp" && G.trigger("long", 96, o) === "sl" && G.trigger("long", 94, o) === "liq" && G.trigger("long", 100, o) === null, "long triggers");
  const s = { liqPrice: 105, tpPrice: 90, slPrice: 103 };
  ok(G.trigger("short", 89, s) === "tp" && G.trigger("short", 104, s) === "sl" && G.trigger("short", 106, s) === "liq", "short triggers");
  ok(G.tpSlProblem("long", 100, 95, 99) === "tp-side" && G.tpSlProblem("long", 100, 95, 0, 101) === "sl-side" && G.tpSlProblem("long", 100, 95, 0, 94) === "sl-past-wipeout" && G.tpSlProblem("long", 100, 95, 110, 97) === "", "tp/sl validation long");
  ok(G.tpSlProblem("short", 100, 105, 101) === "tp-side" && G.tpSlProblem("short", 100, 105, 90, 106) === "sl-past-wipeout", "tp/sl validation short");
  for (const [side, tp, sl, move, want] of [["long", 67_100, 66_990, 67_120, "tp"], ["long", 67_100, 66_990, 66_980, "sl"], ["short", 66_900, 67_010, 66_880, "tp"], ["short", 66_900, 67_010, 67_020, "sl"]]) {
    const a = mk(), ev = []; a.onEvent((e) => ev.push(e)); await a.addFuel(50);
    a.setPrice("BTC", 67_000);
    await a.open({ market: "BTC", side, collateralUsd: 10, leverage: 100, tpPrice: tp, slPrice: sl }); a.flushFills();
    a.setPrice("BTC", move);
    const c = ev.find((e) => e.type === "closed");
    ok(c?.reason === want, `${side} ${want} closes with reason ${c?.reason}`);
    a.dispose();
  }
  const a = mk(), ev = []; a.onEvent((e) => ev.push(e)); await a.addFuel(50); a.setPrice("BTC", 67_000);
  await a.open({ market: "BTC", side: "long", collateralUsd: 10, leverage: 1000 }); a.flushFills();
  const [p] = await a.getPositions(); a.setPrice("BTC", p.liqPrice - 1);
  const l = ev.find((e) => e.type === "liquidated");
  ok(l && (l.returnedUsd ?? 0) === 0, "1000× long wiped out below its wipeout price");
  a.dispose();
  const hi = mk({ feeBps: 5 }); await hi.addFuel(50);
  let msg = ""; try { await hi.open({ market: "BTC", side: "long", collateralUsd: 10, leverage: 1000 }); } catch (e) { msg = e.message; }
  ok(/Fees would wipe this out/.test(msg), `5 bp × 1000× refused: "${msg}"`);
  hi.dispose();
}
// 5) danger: distance, heat and beeps at 20 / 10 / 5 % (once per crossing, re-armed with hysteresis)
{
  ok(near(G.wipeoutDistance(100, 90, 100), 1) && near(G.wipeoutDistance(100, 90, 90), 0) && near(G.wipeoutDistance(100, 110, 108), 0.2), "distance");
  ok(G.beepLevel(0.25) === 0 && G.beepLevel(0.2) === 1 && G.beepLevel(0.1) === 2 && G.beepLevel(0.05) === 3 && G.beepLevel(0.15) === 1, "beep levels");
  let armed = 0; const out = [];
  for (const d of [0.5, 0.3, 0.19, 0.18, 0.12, 0.09, 0.11, 0.09, 0.04, 0.05, 0.5, 0.19]) { const r = G.nextBeep(armed, d); armed = r.armed; out.push(r.beep); }
  ok(JSON.stringify(out) === JSON.stringify([0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 1]), `beep sequence ${out}`);
  ok(G.heatOf(1) === 0 && G.heatOf(0) === 1 && near(G.heatOf(0.3), 0.7), "heat");
}
// 6) presets persist (default 100×, editable, clamped), heads-up once, jetstream curve, big-win rule
{
  const s = mem();
  const d = P.loadPrefs(s);
  ok(d.lev.join() === "100,250,500,1000" && d.levSel === 0 && d.bets.join() === "10,25,50,100" && !d.tpsl && !d.muted, "defaults");
  let p = P.setLevPreset(d, 1, "300"); p = P.setLevPreset(p, 3, 5000); p = P.setLevPreset(p, 2, "abc"); p = P.setBetPreset(p, 0, 15);
  p = { ...p, levSel: 1, betSel: 2, tpsl: true, muted: true, market: "ETH" };
  P.savePrefs(s, p);
  const r = P.loadPrefs(s);
  ok(r.lev.join() === "100,300,500,1000" && r.bets[0] === 15 && r.levSel === 1 && r.betSel === 2 && r.tpsl && r.muted && r.market === "ETH", `persisted ${JSON.stringify(r)}`);
  s.setItem(P.TURBO_PREFS_KEY, "{bad json"); ok(P.loadPrefs(s).levSel === 0, "corrupt → defaults");
  s.setItem(P.TURBO_PREFS_KEY, JSON.stringify({ v: 1, lev: [0, -5, 1e9, 7], levSel: 9 })); const c = P.loadPrefs(s);
  ok(c.lev.every((x) => x >= P.MIN_LEV && x <= P.MAX_LEV) && c.levSel === 0, `sanitized ${c.lev}`);
  ok(P.needsHeadsUp(d, 1000) && !P.needsHeadsUp(d, 500) && !P.needsHeadsUp({ ...d, seen1000: true }, 1000), "heads-up once");
  ok(near(G.jetOf(1000), 1) && near(G.jetOf(100), 2 / 3) && G.jetOf(1000) > G.jetOf(500), "jetstream grows with leverage");
  ok(G.isBigWin(6, 10) && !G.isBigWin(4, 10) && !G.isBigWin(20, 100), "big win");
}
console.warn = origWarn;
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`turbo ui: ${n - fail}/${n} passed`);
process.exit(fail ? 1 : 0);
