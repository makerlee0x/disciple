// Gameplay audit guards (maker lee, 2026-10): mock mcap stays plausible (no runaway to $90M), mock supply = 7B,
// sell presets default 10/25/50/100 (INITIALS removed) with migration of old defaults / "init" slots (custom values kept),
// engine refuses sells with no tokens.   Run: node scripts/test-audit.mjs
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
const dir = path.dirname(fileURLToPath(import.meta.url));
let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
const eng = fs.readFileSync(path.join(dir, "../public/flight/engine.js"), "utf8");
// 1) mock market: bounded growth, supply defined
{ let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const cls = eng.slice(eng.indexOf("class MockReplaySource {"), eng.indexOf("\n  emitDepth()")) + "\n emitDepth(){} }";
  let T = 0; const M = new Function("Q", "randn", "performance", "Math", cls + ";return MockReplaySource;")(
    new URLSearchParams(""), () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(6.2831853 * rnd()), { now: () => T }, Object.assign(Object.create(Math), { random: rnd }));
  ok(new M().supply === 7e9, "mock supply is 7B (was commented out ⇒ undefined)");
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
  ok(sv({ sells: [12, 33, 77, "init"] }) === "[10,25,50,100]", "v1 saved defaults 12/33/77/INITIALS → migrated");
  ok(sv({ v: 2, sells: [25, 50, 100, "init"] }) === "[10,25,50,100]", "v2 saved defaults 25/50/100/INITIALS → migrated");
  ok(sv({ v: 2, sells: [20, "init", 90, "init"] }) === "[20,25,90,100]", "any INITIALS slot → its new default; custom numbers kept");
  ok(sv({ sells: [10, 33, 90, 40] }) === "[10,25,90,40]", "v1: custom slots kept, untouched old default slot migrated");
  ok(sv({ v: 3, sells: [12, 33, 77, 5] }) === "[12,33,77,5]", "a v3 save that chose 12/33/77 on purpose is kept");
  ok(S.sellLabel(37) === "37%", "sell label = plain %");
  const pnlSrc = fs.readFileSync(path.join(dir, "../lib/pnl.ts"), "utf8"), f0 = pnlSrc.indexOf("export function fmtMoney");
  const fmtMoney = new Function(ts.transpileModule(pnlSrc.slice(f0, pnlSrc.indexOf("\n}\n", f0) + 3).replace("export ", ""), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText + "return fmtMoney;")();
  const want = [[0.2, "$0.20"], [5, "$5.00"], [129.12, "$129.12"], [129120, "$129.12K"], [1.5e6, "$1.50M"], [2.25e9, "$2.25B"], [3e12, "$3.00T"]];
  ok(want.every(([v, w]) => fmtMoney(v) === w), "fmtMoney shorthand: " + want.map(([v]) => fmtMoney(v)).join(" "));
  const engFmt = new Function(eng.slice(eng.indexOf("function fmtMoney(v)"), eng.indexOf("function fmtPnlUsd")) + "return fmtMoney;")();
  ok(want.every(([v, w]) => engFmt(v) === w), "engine fmtMoney (buy tiles / labels) matches lib/pnl.ts");
}
// 3) engine sell guard is the first thing trade() checks for sells
{ const tr = eng.slice(eng.indexOf("function trade(side,opt){"), eng.indexOf("function submit(")); const g = tr.indexOf("!hasTokens()"), th = tr.indexOf("applyThrust(");
  ok(g > 0 && g < th, "engine: no-tokens guard runs before any thrust/bomb visual or submit");
  ok(/md\.usd>S\.hold\.valueUsd/.test(tr), "engine: paper sell capped at holdings value"); }
// 4) select-then-fire: clicks only select, shortcuts fire, DUMP/Shift sells the selected %
{ const pd = eng.slice(eng.indexOf("cv.addEventListener('pointerdown'"), eng.indexOf("function buyPreset"));
  ok(pd.length > 0 && !/trade\(|buyPreset\(|disciple:sellpreset/.test(pd), "engine: clicking a buy/sell preset never trades (select only)");
  ok(/disciple:sellselect/.test(pd), "engine: sell preset click → disciple:sellselect");
  const kd = eng.slice(eng.indexOf("addEventListener('keydown'"), eng.indexOf("addEventListener('keyup'") > 0 ? eng.indexOf("addEventListener('keyup'") : undefined);
  ok(/Digit\(\[1-6\]\)[\s\S]{0,120}buyPreset/.test(kd), "engine: 1–6 shortcut buys instantly");
  ok(/ShiftLeft[\s\S]{0,200}disciple:dump/.test(kd), "engine: Shift = DUMP the selected preset");
  ok(/NO TOKENS IN WALLET/.test(eng) && !/no tokens to sell/i.test(eng), "engine hint says NO TOKENS IN WALLET");
  const tb = fs.readFileSync(path.join(dir, "../components/TradeBridge.tsx"), "utf8");
  ok(/disciple:sellselect/.test(tb) && /disciple:dump/.test(tb) && /selSell\.current\(i\); \}/.test(tb) && !/sellRef/.test(tb), "TradeBridge: Z/X/C/V only SELECT (never trade); DUMP / Shift sell");
  ok(/ShiftLeft'\|\|e\.code==='ShiftRight'\)&&!e\.ctrlKey&&!e\.metaKey&&!e\.altKey/.test(kd) && kd.indexOf("isTyping(e)") < kd.indexOf("ShiftLeft"), "Shift: no modifier combos, never while typing");
  ok((kd.match(/Shift(Left|Right)/g) || []).length === 2 && !/Shift/.test(eng.slice(eng.indexOf("addEventListener('keyup'"), eng.indexOf("addEventListener('keyup'") + 200)), "Shift does nothing else in the engine");
  ok(/SELL · Z\/X\/C\/V select, SHIFT dump/.test(eng), "SELL row hint: Z/X/C/V select, SHIFT dump");
  ok(/▲ BOOST \{fmtShot\(shotUsd\)\}/.test(tb) && /▼ DUMP \{/.test(tb) && /disabled=\{!has\}/.test(tb), "BOOST/DUMP show the selected amount; DUMP disabled with 0 tokens");
  ok(!/no tokens to sell/i.test(tb), "TradeBridge hint says NO TOKENS IN WALLET");
  ok(!/INITIALS|"init"/.test(tb.replace(/INITIALS → 25%/, "")) && !/INITIALS/.test(eng), "INITIALS removed (engine + bridge)");
  ok(/fmtShot=v=>fmtMoney\(v\)/.test(eng) && /const fmtShot = fmtMoney/.test(tb), "buttons and buy tiles use the shared formatter");
  ok(/data-testid="custom-sell"/.test(tb) && /data-testid="sell-unit"/.test(tb) && /▼ DUMP \{dumpLabel\}/.test(tb), "custom sell field + %/$ toggle; DUMP shows the exact amount");
  ok(/Math\.min\(sellCustomN, pos\.valueUsd\)/.test(tb) && /Math\.min\(100, sellCustomN\)/.test(tb), "custom sell: $ capped at position value, % capped at 100");
  ok(!/i===am/.test(eng), "no auto-ammo suggestion outline on buy tiles"); }
// 5) PnL regression: a $60K paper buy at $7K–$50K mcap → uPnL ≥ −fee right after, and it tracks the mark afterwards
{ const { loadLib } = await import("./lib/load-ts.mjs"); const { mods, cleanup } = await loadLib(undefined, "pnl2-");
  const P = mods["pnl"], { cloneConfig } = mods["sim/config"], { SimRun } = mods["sim/run"];
  const SUP = 7e9, USD = 60_000, GAS = 0.01;
  let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }; const randn = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(6.2831853 * rnd());
  const Mth = Object.assign(Object.create(Math), { random: rnd });
  const cls = (name, end) => eng.slice(eng.indexOf("class " + name + " {"), eng.indexOf(end, eng.indexOf("class " + name + " {")));
  const Mock = new Function("Q", "randn", "performance", "Math", cls("MockReplaySource", "\n/* DexScreener") + ";return MockReplaySource;")(new URLSearchParams(""), randn, { now: () => 0 }, Mth);
  const Disc = new Function("Q", "setInterval", "clearInterval", "window", cls("DiscipleSource", "\n/* SIMULATOR bridge") + ";return DiscipleSource;")(new URLSearchParams(""), () => 0, () => {}, {});
  const capSrc = eng.slice(eng.indexOf("const WALLET_CAP_FRAC"), eng.indexOf("function trade(side,opt){"));
  const mkCap = (source, mcap) => new Function("isLive", "source", "S", "MockReplaySource", "DiscipleSource", "GRADUATION_MCAP", capSrc + ";return Object.assign(paperCap,{capFilledUsd});")(() => false, source, { confirmed: { mcap }, hold: { tokens: 0 } }, Mock, Disc, 33e3);
  ok(/Math\.sqrt\(r\.pre\*r\.post\)/.test(eng) && /pre:m\.pre,post:m\.post/.test(eng) && /pre:b,post:m/.test(eng) && /return \{ok:true,paper:true,pre,post\}/.test(eng), "engine books paper fills at √(pre·post) of the move the market actually made");
  const check = (tag, pos, mark, usd) => { const v = P.view(pos, mark / SUP, SUP); const floor = -(usd * P.FEE + GAS) - 1e-6;
    ok(v.uPnl >= floor, `${tag}: uPnL right after ${v.uPnl >= 0 ? "+" : ""}$${v.uPnl.toFixed(2)} ≥ −fee $${(-floor).toFixed(2)} (filled $${usd.toFixed(2)})`); return v; };
  const tracks = (tag, pos, marks) => { const errs = marks.map((m) => { const v = P.view(pos, m / SUP, SUP); return Math.abs(v.uPnl - (pos.size * m / SUP - pos.costBasis)); });
    ok(Math.max(...errs) < 1e-6 && new Set(marks.map((m) => Math.round(m))).size > 1, `${tag}: uPnL tracks the mark afterwards (= holdings × mark − cost over ${marks.length} marks)`); };
  for (const M of [7_000, 15_000, 30_000, 50_000]) {
    // MOCK (coin page ?source=mock, paper)
    { const m = new Mock(); m.mcap = M; m.emit = () => {}; m.seedDepth(); const cap = mkCap(m, M), c = cap(USD);
      const r = m.applyTrade("buy", c.usd, true), fm = Math.sqrt(r.pre * r.post), usd = cap.capFilledUsd(c.usd, fm, r.pre);
      const pos = P.applyFill(P.emptyPosition(), "buy", usd, fm / SUP, GAS);
      if (M < 33e3) ok(pos.size <= 0.07 * SUP * (1 + 1e-6), `mock $${M / 1e3}K: booked ${(pos.size / SUP * 100).toFixed(2)}% of supply ≤ 7% wallet cap (walls can't sneak past it)`);
      check(`mock $${M / 1e3}K`, pos, m.mcap, usd); const marks = []; for (let i = 0; i < 600; i++) { m.onBlock(); marks.push(m.mcap); } tracks(`mock $${M / 1e3}K`, pos, marks);
      ok(marks[50] > r.pre, `mock $${M / 1e3}K: no instant snap-back (5 s later $${Math.round(marks[50]).toLocaleString()} vs pre $${Math.round(r.pre).toLocaleString()})`); }
    // DISCIPLE coin, paper (no wallet): the shot moves the paper offset; old code booked mark×√impact while the price never moved
    { const d = new Disc(); d.mcap = M; d.emit = () => {}; const c = mkCap(d, M)(USD); const r = await d.submitTrade("buy", c.usd);
      const pos = P.applyFill(P.emptyPosition(), "buy", c.usd, Math.sqrt(r.pre * r.post) / SUP, GAS); check(`disciple paper $${M / 1e3}K`, pos, d.shown(), c.usd);
      const old = P.view(P.applyFill(P.emptyPosition(), "buy", USD, M * Math.sqrt(1 + USD / (M * 0.25)) / SUP, GAS), M / SUP, SUP).uPnl;
      if (M === 7_000) ok(old < -USD * 0.5, `(old booking would show uPnL $${Math.round(old).toLocaleString()} right after a $60K buy — the bug)`);
      const marks = []; for (let i = 0; i < 40; i++) { d.paper = 1 + (d.paper - 1) * Math.exp(-0.25 / 20); marks.push(d.shown()); } tracks(`disciple paper $${M / 1e3}K`, pos, marks); }
  }
  // SIMULATOR: exact fills, NO wallet cap (live Launchpad default walletCapBps = 0). A buy that completes the curve is
  // filled up to the curve end and the unspent quote refunded. After the 7 s anti-snipe window (that tax is a real cost).
  ok(/const capApplies=m=>!isLive\(\)&&!source\.isSim&&/.test(eng), "engine: the paper 7% cap never applies to the SIMULATOR (paper mode keeps it)");
  for (const T of [10, 40, 90]) { const r = new SimRun(cloneConfig(), "pve", 1000, { balance: 1e6 }); while (r.t < T) r.step(0.1);
    const pre = r.m.mcap(), wasCurve = r.m.phase === "curve"; const f = r.playerTrade("buy", USD); const spent = 1e6 - r.player.cash;
    ok(f.ok && Math.abs(spent - f.usd - r.cfg.player.gasUsd) < 1e-6, `sim t=${T}s @ $${Math.round(pre).toLocaleString()}: only the filled $${f.usd.toFixed(2)} is charged (${(f.tokens / 7e7).toFixed(2)}% of supply${wasCurve && f.usd < USD ? ", curve completed, rest refunded" : ""})`);
    const curveEnd = wasCurve && r.m.phase === "pool" && f.tokens <= 0.07 * r.m.S;
    ok(f.tokens > 0.07 * r.m.S || curveEnd, curveEnd ? `sim t=${T}s: the buy was limited only by the curve end (${(f.tokens / r.m.S * 100).toFixed(1)}% left), not by a cap` : `sim t=${T}s: no wallet cap — one wallet holds ${(f.tokens / r.m.S * 100).toFixed(1)}% of supply (> 7%)`);
    const pos = P.applyFill(P.emptyPosition(), "buy", f.usd, f.mcap / r.m.S, 0); const v = P.view(pos, r.m.mcap() / r.m.S, r.m.S);
    ok(v.uPnl >= -f.usd * P.FEE - 1e-6, `sim t=${T}s: uPnL right after +$${v.uPnl.toFixed(2)} ≥ −fee`);
    const marks = []; for (let i = 0; i < 100; i++) { r.step(0.1); marks.push(r.m.mcap()); } tracks(`sim t=${T}s`, pos, marks); }
  cleanup();
}
if (bad) { console.error(bad + " FAILED"); process.exit(1); } console.log("PASS");
