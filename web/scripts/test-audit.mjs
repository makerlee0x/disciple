// Gameplay audit guards (maker lee, 2026-10): mock mcap stays plausible (no runaway to $90M), mock supply = 1M,
// sell presets default 10/25/50/100 (INITIALS removed) with migration of old defaults / "init" slots (custom values kept),
// engine refuses sells with no tokens.   Run: node scripts/test-audit.mjs
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
const dir = path.dirname(fileURLToPath(import.meta.url));
let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
const eng = fs.readFileSync(path.join(dir, "../public/flight/engine.js"), "utf8");
// 0) tramps/walls: no fee share anywhere in GAME copy/code (TrampWallManager rev2 pays range orders no LP yield)
{ const rd = (f) => fs.readFileSync(path.join(dir, "..", f), "utf8");
  const files = ["components/trampwalls/TrampWallPanel.tsx", "lib/trampwalls/adapter.ts", "lib/trampwalls/mock.ts", "lib/trampwalls/onchain.ts", "lib/sim/twAdapter.ts", "public/flight/engine.js", "../docs/tramps-walls.md"];
  const claim = /0\.11 ?%|11 bps|hook donation|fees\/day|estFeeShare|estSharePct|feesEarnedUsd|FeesDonated|HOOK_DONATION|pendingFees|claimFees|LPDonation/i;
  const hits = files.filter((f) => claim.test(rd(f).replace(/^.*No fee share.*$/gm, "")));
  ok(!hits.length, `no tramp/wall fee-share promise or fee read in ${files.length} GAME files${hits.length ? " (found in " + hits.join(", ") + ")" : ""}`); }
// 0b) tramp/wall points: 1 pt per $1 of FILLED size (config TRAMP_WALL_POINTS_PER_USD), only after a keeper close
{ const rd = (f) => fs.readFileSync(path.join(dir, "..", f), "utf8"), ad = rd("lib/trampwalls/adapter.ts"), oc = rd("lib/trampwalls/onchain.ts"), mk = rd("lib/trampwalls/mock.ts");
  ok(/export const TRAMP_WALL_POINTS_PER_USD = \d/.test(rd("lib/config.ts")) && /Math\.floor\(filledSizeUsd \* TRAMP_WALL_POINTS_PER_USD/.test(ad) && !/tramp: 250|perKUsd/.test(ad), "adapter: points = floor($ × TRAMP_WALL_POINTS_PER_USD), flat 250/300 gone");
  ok(/const status = active \? "active" : cancelled \? "cancelled" : "filled";/.test(oc) && /pointsEarned: pointsEarned\(\{ status, sizeUsd \}\)/.test(oc), "onchain: crossed-but-not-pulled stays active, cancelled ≠ filled, points only when filled");
  ok((mk.match(/pointsFor\(/g) || []).length === 1 && /function mockMarkFilled[\s\S]*pointsFor\(t\.sizeUsd\)/.test(mk), "mock: points only in mockMarkFilled (the keeper stand-in)"); }
// 1) mock market: bounded growth, supply defined
{ let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const cls = eng.slice(eng.indexOf("class MockReplaySource {"), eng.indexOf("\n  emitDepth()")) + "\n emitDepth(){} }";
  let T = 0; const M = new Function("Q", "randn", "performance", "Math", cls + ";return MockReplaySource;")(
    new URLSearchParams(""), () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(6.2831853 * rnd()), { now: () => T }, Object.assign(Object.create(Math), { random: rnd }));
  ok(new M().supply === 1e6, "mock supply is 1M (was commented out ⇒ undefined)");
  const run = (turbo, mins) => { const xs = []; for (let r = 0; r < 12; r++) { const m = new M(); m.emit = () => {}; m.turbo = turbo; m.seedDepth(); T = 0; for (let i = 0; i < mins * 600; i++) { T += 100; m.onBlock(); } xs.push(m.mcap); } xs.sort((a, b) => a - b); return xs; };
  const n = run(false, 120), t = run(true, 60);
  ok(n[11] < 400_000, `mock 2 h: max $${Math.round(n[11]).toLocaleString()} (< $400K; was median ≈$200K and unbounded)`);
  ok(t[11] < 8e6, `mock 1 h of turbo: max $${Math.round(t[11]).toLocaleString()} (< $8M; was ≈$20M and climbing)`);
}
// 2) sell presets + migration
{ const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"));
  fs.writeFileSync(path.join(tmp, "s.mjs"), ts.transpileModule(fs.readFileSync(path.join(dir, "../lib/trade/swapSettings.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText);
  const S = await import(pathToFileURL(path.join(tmp, "s.mjs")).href);
  const sv = (x) => JSON.stringify(S.sanitize(x).sells);
  ok(JSON.stringify(S.DEFAULT_SELLS) === "[10,25,50,100]", "default sells 10/25/50/100");
  // sell sizes are FIXED at 10/25/50/100% since v4 (GAME trade-ui-fixes): every older save → the fixed sizes
  ok(sv({ sells: [12, 33, 77, "init"] }) === "[10,25,50,100]", "v1 saved defaults 12/33/77/INITIALS → fixed sizes");
  ok(sv({ v: 2, sells: [25, 50, 100, "init"] }) === "[10,25,50,100]", "v2 saved defaults 25/50/100/INITIALS → fixed sizes");
  ok(sv({ v: 2, sells: [20, "init", 90, "init"] }) === "[10,25,50,100]", "custom sell slots → fixed sizes (one custom sell field on the bar instead)");
  ok(sv({ v: 3, sells: [12, 33, 77, 5] }) === "[10,25,50,100]", "a v3 custom save → fixed sizes");
  ok(S.sellLabel(37) === "37%", "sell label = plain %");
  const pnlSrc = fs.readFileSync(path.join(dir, "../lib/pnl.ts"), "utf8"), f0 = pnlSrc.indexOf("export function fmtMoney");
  const fmtMoney = new Function(ts.transpileModule(pnlSrc.slice(f0, pnlSrc.indexOf("\n}\n", f0) + 3).replace("export ", ""), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText + "return fmtMoney;")();
  const want = [[0.2, "$0.20"], [5, "$5.00"], [129.12, "$129.12"], [129120, "$129.12K"], [1.5e6, "$1.50M"], [2.25e9, "$2.25B"], [3e12, "$3.00T"]];
  ok(want.every(([v, w]) => fmtMoney(v) === w), "fmtMoney shorthand: " + want.map(([v]) => fmtMoney(v)).join(" "));
  const engFmt = new Function(eng.slice(eng.indexOf("function fmtMoney(v)"), eng.indexOf("function fmtPnlUsd")) + "return fmtMoney;")();
  ok(want.every(([v, w]) => engFmt(v) === w), "engine fmtMoney (buy tiles / labels) matches lib/pnl.ts");
}
// 3) engine sell guard is the first thing trade() checks for sells
{ const tr = eng.slice(eng.indexOf("function trade(side,opt){"), eng.indexOf("function submit(")); const g = tr.indexOf("!hasTokens()"), th = tr.indexOf("submit(side");
  ok(g > 0 && g < th, "engine: no-tokens guard runs before submit (thrust/flare only on the confirmed fill, @fillthrust)");
  ok(/md\.usd>S\.hold\.valueUsd/.test(tr), "engine: paper sell capped at holdings value"); }
// 4) select-then-fire: clicks only select, shortcuts fire, DUMP/Shift sells the selected %
{ const pd = eng.slice(eng.indexOf("cv.addEventListener('pointerdown'"), eng.indexOf("addEventListener('resize',resize)"));
  ok(pd.length > 0 && !/trade\(|buyPreset\(|disciple:sellpreset/.test(pd), "engine: clicking a buy/sell preset never trades (select only)");
  ok(/disciple:sellselect/.test(pd), "engine: sell preset click → disciple:sellselect");
  // gameplay keys live in the engine's @hotkeys block (bindings from the ESC settings menu; see scripts/test-hotkeys.mjs)
  const kd = eng.slice(eng.indexOf("/* @hotkeys"), eng.indexOf("/* @hotkeys-end */"));
  { const bl = (kd.match(/^.*HOTKEYS\.buy\.indexOf\(e\.code\).*$/m) || [""])[0];
    ok(/S\.mode=bi/.test(bl) && !/trade\(|buyPreset|boost\(/.test(bl) && !/buyPreset/.test(eng), "engine: 1–6 (buy-preset keys) only SELECT, never buy (2026-10: was 'buys instantly')"); }
  ok(/e\.code==='Space'[^\n]*boost\(\)/.test(kd) && /function boost\(\)\{ trade\('buy', S\.customBuyUsd>0\?\{usd:S\.customBuyUsd\}:undefined\); \}/.test(kd), "engine: SPACE = BOOST with the active amount (custom $ wins)");
  ok(/ShiftLeft[\s\S]{0,200}disciple:dump/.test(kd), "engine: Shift = DUMP the selected preset");
  ok(/NO TOKENS IN WALLET/.test(eng) && !/no tokens to sell/i.test(eng), "engine hint says NO TOKENS IN WALLET");
  const tb = fs.readFileSync(path.join(dir, "../components/TradeBridge.tsx"), "utf8");
  ok(/disciple:sellselect/.test(tb) && /disciple:dump/.test(tb) && /selSell\.current\(i\); \}/.test(tb) && !/sellRef/.test(tb), "TradeBridge: Z/X/C/V only SELECT (never trade); DUMP / Shift sell");
  ok(/const mod=e\.ctrlKey\|\|e\.metaKey\|\|e\.altKey/.test(kd) && /ShiftLeft'\|\|e\.code==='ShiftRight'\)&&!mod/.test(kd) && kd.indexOf("isTyping(e)") < kd.indexOf("ShiftLeft"), "Shift: no modifier combos, never while typing");
  ok((kd.match(/Shift(Left|Right)/g) || []).length === 2 && !/Shift/.test(eng.slice(eng.indexOf("addEventListener('keyup'"), eng.indexOf("addEventListener('keyup'") + 200)), "Shift does nothing else in the engine");
  ok(/SELL · Z\/X\/C\/V select, SHIFT dump/.test(eng), "SELL row hint: Z/X/C/V select, SHIFT dump");
  ok(/▲ \{t\("tb\.boost"\)\} \{fmtShot\(shotUsd\)\}/.test(tb) && /▼ \{t\("tb\.dump"\)\} \{/.test(tb) && /disabled=\{!has\}/.test(tb), "BOOST/DUMP show the selected amount; DUMP disabled with 0 tokens");
  ok(!/no tokens to sell/i.test(tb), "TradeBridge hint says NO TOKENS IN WALLET");
  ok(!/INITIALS|"init"/.test(tb.replace(/INITIALS → 25%/, "")) && !/INITIALS/.test(eng), "INITIALS removed (engine + bridge)");
  ok(/fmtShot=v=>fmtMoney\(v\)/.test(eng) && /const fmtShot = fmtMoney/.test(tb), "buttons and buy tiles use the shared formatter");
  ok(/data-testid="custom-sell"/.test(tb) && /data-testid="sell-unit"/.test(tb) && /▼ \{t\("tb\.dump"\)\} \{dumpLabel\}/.test(tb), "custom sell field + %/$ toggle; DUMP shows the exact amount");
  ok(/Math\.min\(sellCustomN, pos\.valueUsd\)/.test(tb) && /Math\.min\(100, sellCustomN\)/.test(tb), "custom sell: $ capped at position value, % capped at 100");
  ok(!/i===am/.test(eng), "no auto-ammo suggestion outline on buy tiles"); }
// 5) PnL regression: a $60K paper buy at $3.3K–$50K mcap → uPnL ≥ −fee right after, and it tracks the mark afterwards.
//    Paper (mock + DISCIPLE, no wallet) fills EXACTLY on the bonding curve (pre-grad) / full-range pool (post-grad):
//    engine paperFill on lib/flight/paperCurve params (= curveMath steep curve + CURVE), never a linear mark booking.
{ const { loadLib, SIM_MODULES } = await import("./lib/load-ts.mjs"); const { mods, cleanup } = await loadLib([...SIM_MODULES, "flight/paperCurve"], "pnl2-");
  const P = mods["pnl"], { cloneConfig, SIM_CONFIG } = mods["sim/config"], { SimRun } = mods["sim/run"], { Market } = mods["sim/market"], { Pool } = mods["sim/pool"], CM = mods["curveMath"];
  const PCv = mods["flight/paperCurve"].paperCurve();
  const SUP = 1e6, USD = 60_000, GAS = 0.01, FEE = PCv.fee;
  let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }; const randn = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(6.2831853 * rnd());
  const Mth = Object.assign(Object.create(Math), { random: rnd });
  const cls = (name, end) => eng.slice(eng.indexOf("class " + name + " {"), eng.indexOf(end, eng.indexOf("class " + name + " {")));
  const pm = eng.slice(eng.indexOf("const PC=window.__PAPER_CURVE"), eng.indexOf("/* =====================================================================\n   DATA-SOURCE INTERFACE"));
  const W = { __PAPER_CURVE: PCv };
  const paperFill = new Function("window", pm + ";return paperFill;")(W);
  const Mock = new Function("Q", "randn", "performance", "Math", "window", pm + cls("MockReplaySource", "\n/* DexScreener") + ";return MockReplaySource;")(new URLSearchParams(""), randn, { now: () => 0 }, Mth, W);
  const Disc = new Function("Q", "setInterval", "clearInterval", "window", pm + cls("DiscipleSource", "\n/* SIMULATOR bridge") + ";return DiscipleSource;")(new URLSearchParams(""), () => 0, () => {}, W);
  // NO wallet cap in paper mode (Launchpad default WALLET_CAP_BPS_DEFAULT = 0): the engine has no cap code left
  ok(!/WALLET_CAP_FRAC|paperCap|capFilledUsd|capApplies|WALLET CAP 7%/.test(eng), "engine: no paper wallet cap (paperCap/capFilledUsd/7% flashes removed)");
  ok(pm.length > 0 && /__PAPER_CURVE: paperCurve\(\)/.test(fs.readFileSync(path.join(dir, "../components/FlightCanvas.tsx"), "utf8")), "FlightCanvas hands the engine window.__PAPER_CURVE (lib/flight/paperCurve)");
  ok(/else if\(r\.ok&&r\.exact\)/.test(eng) && /mcap:r\.fillMcap\*/.test(eng) && !/usd\/\(m\*0\.25\)/.test(cls("DiscipleSource", "\n/* SIMULATOR bridge")) && !/this\.applyTrade\(side,usd,true/.test(eng),
    "engine: mock + DISCIPLE paper book the exact curve/pool fill (no linear usd/(mcap·0.25) impact, no mock pseudo-liquidity for your shots)");
  // curve state at a mcap (for the "curve left" bound): steep curve m(g) = CP(x0, y0) + tail·g^30, inverted (curveMath)
  const soldAt = (M) => CM.curveFracAtMcap(M) * PCv.sC;
  const W18 = (x) => BigInt(Math.round(x * 1e18)), N18 = (b) => Number(b) / 1e18;
  // the full steep curve (curveMath launch params at a $1 quote = lib/flight/paperCurve); engine.js must price the tail too
  const CP = CM.paramsFromQuotePrice(10n ** 18n);
  const rel = (a, b) => Math.abs(a - b) / Math.max(1e-12, Math.abs(b));
  ok(PCv.tail > 0 && rel(PCv.x0, N18(CP.x0)) < 1e-12 && rel(PCv.y0, N18(CP.y0)) < 1e-12 && rel(PCv.tail, N18(CP.tail)) < 1e-12, `paperCurve = curveMath launch params (x0, y0, tail $${PCv.tail.toFixed(0)})`);
  const engineSteep = /PC\.tail/.test(pm);
  ok(engineSteep, "engine.js paperFill prices the steep tail (PC.tail·g^30)");
  if (!engineSteep) console.log("SKIP 5a–5d + mock/DISCIPLE paper fills: engine.js paperFill is still CP-only (ends at $15K, not $33,333); they run once GAME ports the tail");
  if (engineSteep) {
  // 5a) $60K at $3.3K: completes the curve (84% of supply, never more than the curve has left), refund the rest; = curveMath + sim Market
  { const f = paperFill("buy", PCv.startMcap, USD, null, false); // launch-price fill ($3,333 start)
    ok(f.ok && f.tokens < SUP && f.tokens <= PCv.sC + 1e-3 && rel(f.tokens, PCv.sC) < 1e-9, `paper $60K @ $3.3K: ${(f.tokens / SUP * 100).toFixed(2)}% of supply = the whole curve (< 100%; was 142.9% with the linear paper model)`);
    ok(rel(f.usd + f.refund, USD) < 1e-12 && f.usd < USD && rel(f.post, PCv.gradMcap) < 1e-9 && f.graduated, `paper $60K @ $3.3K: spends $${f.usd.toFixed(2)} to finish the curve at $${Math.round(f.post).toLocaleString()}, $${f.refund.toFixed(2)} refunded`);
    const cm = N18(CM.quoteBuy(CP, 0n, W18(f.usd), 0n)); ok(rel(cm, f.tokens) < 1e-9, `paper $60K @ $3.3K = curveMath.quoteBuy(spent) within 1e-9 (${cm.toExponential(9)} vs ${f.tokens.toExponential(9)})`);
    ok(N18(CM.quoteBuy(CP, 0n, W18(f.usd * (1 - 1e-6)), 0n)) < PCv.sC * (1 - 1e-7), "…and the spent $ is the minimum that finishes the curve (1 ppm less does not)");
    const mk = new Market(SIM_CONFIG), mf = mk.buy(USD, 1e9, 0); ok(rel(mf.tokens, f.tokens) < 1e-9 && rel(mf.usd, f.usd) < 1e-9, "paper $60K @ $3.3K = sim Market.buy (tokens + spent) on the steep curve");
    for (const [M, u] of [[3_333, 5_000], [12_000, 2_500], [20_000, 800], [30_000, 1_000]]) { const g = paperFill("buy", M, u, null, false), sold = soldAt(M);
      if (!(Number.isFinite(g.tokens) && g.tokens > 0)) { ok(false, `paper $${u} @ $${M / 1e3}K: engine paperFill returned ${g.tokens} tokens (past its CP-only curve end)`); continue; }
      const q = N18(CM.quoteBuy(CP, W18(sold), W18(u), 0n)), qs = N18(CM.quoteSell(CP, W18(sold + g.tokens), W18(g.tokens), 0n)), back = paperFill("sell", g.post, 0, { tokens: g.tokens }, false);
      ok(rel(g.tokens, q) < 1e-6 && rel(back.net, qs) < 1e-6, `paper $${u} @ $${M / 1e3}K = curveMath quoteBuy/quoteSell within 1e-6 (${(g.tokens / SUP * 100).toFixed(3)}% of supply, sell back $${back.net.toFixed(2)})`); } }
  // 5b) a buy never gets more tokens than the curve has left
  { let worst = -Infinity, n = 0; for (const M of [3_333, 8_000, 12_000, 20_000, 30_000, 33_200, 33_332]) for (const u of [10, 1_000, 5_000, 20_000, 60_000, 1e6, 1e9]) {
      const f = paperFill("buy", M, u, null, false); n++; worst = Math.max(worst, f.tokens - (PCv.sC - soldAt(M))); if (!(f.tokens < SUP)) worst = Infinity; }
    ok(worst <= 1e-3, `curve cap: ${n} buys ($10…$1B at $3,333…$33,332) never exceed sCurve − sold (worst ${worst.toExponential(2)} tokens) or 100% of supply`); }
  // 5c) post-grad pool = sim Pool (full range, curve-end liquidity), and graduation is continuous
  { const pg = PCv.gradMcap / SUP, L = PCv.L; ok(rel(Math.sqrt(new Pool(pg * (PCv.S - PCv.sC), PCv.S - PCv.sC).L0 ** 2), L) < 1e-9, "paper pool liquidity = the sim's Pool seeded at the curve-end price (Migration.sol)");
    for (const M of [33_333, 50_000, 250_000]) { const s0 = Math.sqrt(M / SUP), pool = new Pool(L * s0, L / s0), f = paperFill("buy", M, USD, null, true), t = pool.buy(USD * (1 - PCv.poolFee));
      ok(rel(f.tokens, t) < 1e-9 && rel(f.post, pool.price() * SUP) < 1e-9, `paper pool $60K @ $${M / 1e3}K = sim Pool.buy (${(f.tokens / SUP * 100).toFixed(2)}% of supply, → $${Math.round(f.post).toLocaleString()})`); } }
  // 5d) buy-then-sell round trips lose only the fees (curve and pool are path-reversible: gross back = net in)
  for (const [M, u, g] of [[3_333, 5_000, false], [15_000, 20_000, false], [3_333, USD, false], [30_000, 1_000, false], [50_000, USD, true], [250_000, 5_000, true]]) {
    const b = paperFill("buy", M, u, null, g), s2 = paperFill("sell", b.post, 0, { tokens: b.tokens }, g), fee = g ? PCv.poolFee : FEE;   // a curve-completing buy sells back down the curve
    const lost = b.usd - s2.net, feesPaid = b.usd * fee + s2.usd * fee;
    ok(Math.abs(lost - feesPaid) < 1e-6 * b.usd && rel(s2.post, b.pre) < 1e-9, `round trip $${b.usd.toFixed(2)} @ $${M / 1e3}K${g ? " (pool)" : ""}: lost $${lost.toFixed(4)} = fees $${feesPaid.toFixed(4)}, price back to $${Math.round(s2.post).toLocaleString()}`); }
  }
  const check = (tag, pos, mark, usd) => { const v = P.view(pos, mark / SUP, SUP); const floor = -(usd * P.FEE + GAS) - 1e-6;
    ok(v.uPnl >= floor, `${tag}: uPnL right after ${v.uPnl >= 0 ? "+" : ""}$${v.uPnl.toFixed(2)} ≥ −fee $${(-floor).toFixed(2)} (filled $${usd.toFixed(2)})`); return v; };
  const tracks = (tag, pos, marks) => { const errs = marks.map((m) => { const v = P.view(pos, m / SUP, SUP); return Math.abs(v.uPnl - (pos.size * m / SUP - pos.costBasis)); });
    ok(Math.max(...errs) < 1e-6 && new Set(marks.map((m) => Math.round(m))).size > 1, `${tag}: uPnL tracks the mark afterwards (= holdings × mark − cost over ${marks.length} marks)`); };
  if (engineSteep)
  for (const M of [3_333, 15_000, 30_000, 50_000]) {
    // MOCK (coin page ?source=mock, paper): your shot is an exact curve/pool fill
    { const m = new Mock(); m.mcap = M; m.graduated = M >= PCv.gradMcap; m.emit = () => {}; m.seedDepth();
      const f = m.paperTrade("buy", USD, null, "h"), left = M < PCv.gradMcap ? PCv.sC - soldAt(M) : Infinity;
      const pos = P.applyFill(P.emptyPosition(), "buy", f.usd, f.fillMcap / SUP, GAS);
      ok(f.ok && rel(pos.size, f.tokens) < 1e-9 && pos.size < SUP && pos.size <= left + 1e-3, `mock $${M / 1e3}K: ledger holds exactly the ${(f.tokens / SUP * 100).toFixed(2)}% filled (≤ curve left, < 100%) for $${f.usd.toFixed(2)}`);
      check(`mock $${M / 1e3}K`, pos, m.mcap, f.usd); const marks = []; for (let i = 0; i < 600; i++) { m.onBlock(); marks.push(m.mcap); } tracks(`mock $${M / 1e3}K`, pos, marks);
      ok(marks[50] > f.pre, `mock $${M / 1e3}K: no instant snap-back (5 s later $${Math.round(marks[50]).toLocaleString()} vs pre $${Math.round(f.pre).toLocaleString()})`); }
    // DISCIPLE coin, paper (no wallet): exact fill; the move becomes the decaying paper offset
    { const d = new Disc(); d.mcap = M; d.graduated = M >= PCv.gradMcap; d.emit = () => {}; const r = await d.submitTrade("buy", USD);
      const pos = P.applyFill(P.emptyPosition(), "buy", r.usd, r.fillMcap / SUP, GAS); check(`disciple paper $${M / 1e3}K`, pos, d.shown(), r.usd);
      ok(r.exact && pos.size < SUP && (M >= PCv.gradMcap || pos.size <= PCv.sC - soldAt(M) + 1e-3), `disciple paper $${M / 1e3}K: ${(pos.size / SUP * 100).toFixed(2)}% of supply for $${r.usd.toFixed(2)}${r.refund > 0 ? ` ($${r.refund.toFixed(2)} refunded at the curve end)` : ""}`);
      const old = P.view(P.applyFill(P.emptyPosition(), "buy", USD, M * Math.sqrt(1 + USD / (M * 0.25)) / SUP, GAS), M / SUP, SUP).uPnl;
      if (M === 3_333) ok(old < -USD * 0.5, `(old booking would show uPnL $${Math.round(old).toLocaleString()} right after a $60K buy — the bug)`);
      // ...and a 100% sell right after returns the cash minus the two fees (+ gas)
      const before = d.shown(), sr = await d.submitTrade("sell", 0, { tokens: pos.size }), after = P.applyFill(pos, "sell", sr.usd, sr.fillMcap / SUP, GAS, Date.now(), 1);
      ok(after.size === 0 && Math.abs((r.usd - sr.net) - (r.usd * FEE + sr.usd * FEE)) < 1e-6 * r.usd && rel(d.shown(), M) < 1e-9 && before > M, `disciple paper $${M / 1e3}K: buy → sell 100% loses only fees ($${(r.usd - sr.net).toFixed(2)}), price back to $${Math.round(d.shown()).toLocaleString()}`);
      const d2 = new Disc(); d2.mcap = M; d2.graduated = d.graduated; d2.emit = () => {}; const r2 = await d2.submitTrade("buy", USD), pos2 = P.applyFill(P.emptyPosition(), "buy", r2.usd, r2.fillMcap / SUP, GAS);
      const marks = []; for (let i = 0; i < 40; i++) { d2.paper = 1 + (d2.paper - 1) * Math.exp(-0.25 / 20); marks.push(d2.shown()); } tracks(`disciple paper $${M / 1e3}K`, pos2, marks); }
  }
  // SIMULATOR: exact fills, NO wallet cap (live Launchpad default walletCapBps = 0). A buy that completes the curve is
  // filled up to the curve end and the unspent quote refunded. After the 7 s anti-snipe window (that tax is a real cost).
  for (const T of [80, 120, 170]) { const r = new SimRun(cloneConfig(), "pve", 1000, { balance: 1e6 }); while (r.t < T) r.step(0.1);
    const pre = r.m.mcap(), wasCurve = r.m.phase === "curve"; const f = r.playerTrade("buy", USD); const spent = 1e6 - r.player.cash;
    ok(f.ok && Math.abs(spent - f.usd - r.cfg.player.gasUsd) < 1e-6, `sim t=${T}s @ $${Math.round(pre).toLocaleString()}: only the filled $${f.usd.toFixed(2)} is charged (${(f.tokens / 1e4).toFixed(2)}% of supply${wasCurve && f.usd < USD ? ", curve completed, rest refunded" : ""})`);
    const curveEnd = wasCurve && r.m.phase === "pool" && f.tokens <= 0.07 * r.m.S;
    ok(f.tokens > 0.07 * r.m.S || curveEnd, curveEnd ? `sim t=${T}s: the buy was limited only by the curve end (${(f.tokens / r.m.S * 100).toFixed(1)}% left), not by a cap` : `sim t=${T}s: no wallet cap — one wallet holds ${(f.tokens / r.m.S * 100).toFixed(1)}% of supply (> 7%)`);
    const pos = P.applyFill(P.emptyPosition(), "buy", f.usd, f.mcap / r.m.S, 0); const v = P.view(pos, r.m.mcap() / r.m.S, r.m.S);
    ok(v.uPnl >= -f.usd * P.FEE - 1e-6, `sim t=${T}s: uPnL right after +$${v.uPnl.toFixed(2)} ≥ −fee`);
    const marks = []; for (let i = 0; i < 100; i++) { r.step(0.1); marks.push(r.m.mcap()); } tracks(`sim t=${T}s`, pos, marks); }
  cleanup();
}
if (bad) { console.error(bad + " FAILED"); process.exit(1); } console.log("PASS");
