// Gameplay audit guards (maker lee, 2026-10): mock mcap stays plausible (no runaway to $90M), mock supply = 7B,
// sell presets default 25/50/100/INITIALS with migration of the old 12/33/77 defaults (custom values kept),
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
  ok(JSON.stringify(S.DEFAULT_SELLS) === JSON.stringify([25, 50, 100, "init"]), "default sells 25/50/100/INITIALS");
  ok(JSON.stringify(S.sanitize({ sells: [12, 33, 77, "init"] }).sells) === JSON.stringify([25, 50, 100, "init"]), "old saved defaults 12/33/77 → migrated");
  ok(JSON.stringify(S.sanitize({ sells: [10, 33, 90, 40] }).sells) === JSON.stringify([10, 50, 90, 40]), "custom slots kept, untouched old default slot migrated");
  ok(JSON.stringify(S.sanitize({ v: 2, sells: [12, 33, 77, "init"] }).sells) === JSON.stringify([12, 33, 77, "init"]), "a v2 save that chose 12/33/77 on purpose is kept");
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
  ok(/disciple:sellselect/.test(tb) && /disciple:dump/.test(tb) && /selSell\.current\(i\); sellRef/.test(tb), "TradeBridge: select / dump / Z-X-C-V sell + select wired");
  ok(/▲ BOOST \{fmtShot\(shotUsd\)\}/.test(tb) && /▼ DUMP \{/.test(tb) && /disabled=\{!has\}/.test(tb), "BOOST/DUMP show the selected amount; DUMP disabled with 0 tokens");
  ok(!/no tokens to sell/i.test(tb), "TradeBridge hint says NO TOKENS IN WALLET"); }
if (bad) { console.error(bad + " FAILED"); process.exit(1); } console.log("PASS");
