// game/boost-amount-fix — Gameplay Test 2 (Oct 26 ~9:58–10:01 CT): BOOST sometimes bought $10 when the player had picked
// or typed another amount ($50,$50,$10,$50 within 8 s; extra / same-block fills).
// Root cause (reproduced on prod 3fee842f, /coin/<addr>?cs=… — no ?quote, so FlightCanvas re-runs engine.js once the
// coin's real quote resolves):
//   1. the engine never announced its ammo on boot (AMMO_TIERS=null ⇒ no tier push; TradeBridge's ammo-query fires
//      before the script loads), so the remembered preset was never restored, custom $ / Swap-settings presets were never
//      pushed, and every BOOST tap sent TradeBridge's default mode 0 ⇒ $10;
//   2. the re-run left the OLD engine's window listeners live ⇒ every tap traded twice, Space bought the stale run's preset.
// Everything here is SLICED FROM THE SHIPPED SOURCE (engine @gen / pushAmmo / ammo-override / shoot + custombuy listeners /
// boost / trade+submit / @boot-ammo, and TradeBridge's ammo + boot + restore listeners, pushCfg, shoot(), phone handlers),
// wired on one window EventTarget. The engine "boots" by evaluating those slices; a remount evaluates them again.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import ts from "typescript";
const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
const rd = (f) => fs.readFileSync(path.join(web, f), "utf8");
const eng = rd("public/flight/engine.js"), tb = rd("components/TradeBridge.tsx"), ph = rd("components/flight/PhoneTradeBar.tsx");
const block = (a, b, s = eng) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); if (!(i >= 0 && j > i)) throw new Error("block " + a); return s.slice(i, j); };
const need = (s, re, what) => { const m = s.match(re); if (!m) throw new Error("slice: " + what); return m; };
const tsx = (src) => ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

// ---- engine slices
const genBlk = block("/* @gen", "'use strict';");
const pushAmmoFn = block("function pushAmmo(", "function setAmmoTier");
const queryLsn = need(eng, /addEventListener\('disciple:ammo-query',\(\)=>pushAmmo\(\)\);/, "ammo-query listener")[0];
const overrideBlk = block("/* @ammo-override", "/* @ammo-override-end */");
const trBlock = block("/* @trade (sliced", "// Pre-flight failures");
const shootLsn = need(eng, /addEventListener\('disciple:shoot',[\s\S]*?\}\);/, "shoot listener")[0];
const customLsn = need(eng, /addEventListener\('disciple:custombuy',[^\n]*/, "custombuy listener")[0];
const boostFn = need(eng, /function boost\(\)\{[^\n]*/, "boost()")[0];
const tileSel = need(eng, /S\.pressFx=\{i,t:S\.t\}; S\.mode=i; pushAmmo\(\);/, "canvas tile select")[0];
const hotSel = need(eng, /if\(bi>=0&&!mod\)\{ if\(!e\.repeat\)\{ (S\.mode=bi; S\.pressFx=\{i:bi,t:S\.t\}; pushAmmo\(\);)/, "buy hotkey select")[1];
const bootTail = block("/* @boot-ammo", "\n})();");
// ---- TradeBridge slices
const tbAmmoH = need(tb, /const h = \(e: Event\) => \{ const d = \(e as CustomEvent<Ammo>\)\.detail; setAmmo\(d\);[^\n]*?\};/, "ammo listener")[0];
const tbQuery = need(tb, /addEventListener\("disciple:ammo", h\);\n\s*(dispatchEvent\(new Event\("disciple:ammo-query"\)\);)/, "mount ammo-query")[1];
const tbBootH = need(tb, /useEffect\(\(\) => \{ (const h = \(e: Event\) => \{ if \(!booted\.current[\s\S]*?\} \};) addEventListener\("disciple:ammo", h\)/, "boot listener")[1];
const tbPushCfg = need(tb, /pushCfg\.current = \(\) => \{[\s\S]*?pushPresets\(\); \};/, "pushCfg")[0];
const tbPresets = need(tb, /const pushPresets = \(\) => [^\n]*/, "pushPresets")[0];
const tbRestoreH = need(tb, /const h = \(e: Event\) => \{ const d = \(e as CustomEvent<\{ mode: number; boot\?: boolean \}>\)[\s\S]*?catch \{ \/\* \*\/ \} \};/, "restore listener")[0];
const tbShoot = need(tb, /const shoot = \(side[\s\S]*?\)\)\);/, "shoot")[0];
const tbPick = need(tb, /onPickBuy=\{(\(i\) => \{[^\n]*?\})\}\n/, "onPickBuy")[1];
const tbSet = need(tb, /onSetBuy=\{(\(v\) => setCustom\(v\))\}/, "onSetBuy")[1];
const tbCustomFx = /useEffect\(\(\) => \{ dispatchEvent\(new CustomEvent\("disciple:custombuy", \{ detail: \{ usd: customUsd \} \}\)\); \}, \[customUsd\]\);/.test(tb);
const tbShot = need(tb, /const shotUsd = ([^;]*);/, "shotUsd")[1];

console.log("— 0. the shipped wiring");
ok(/onClick=\{\(\) => shoot\("buy"\)\}/.test(need(tb, /data-testid="buy-btn"[^\n]*/, "buy-btn")[0]), "desktop BOOST button → shoot(\"buy\")");
ok(/\(e\.key === "Enter" \|\| e\.key === " "\) && customUsd\) \{ e\.preventDefault\(\); shoot\("buy"\); \}/.test(tb), "desktop custom $ field: Enter / Space → shoot(\"buy\")");
ok(/onBoost=\{\(\) => shoot\("buy"\)\}/.test(tb) && /onClick=\{b \? p\.onBoost : p\.onDump\}/.test(ph), "phone BOOST → onBoost → shoot(\"buy\")");
ok(tbCustomFx, "TradeBridge pushes the custom $ to the engine on every change (disciple:custombuy)");
ok(/^\s*pushAmmo\(true\);\s*$/m.test(bootTail) && eng.indexOf("pushAmmo(true);") > eng.indexOf("window.__flight={"), "engine @boot-ammo: announces disciple:ammo (boot:true) as its last boot step, after every listener");
ok(/const RAF=f=>\{ if\(CAPTURE\|\|!isCurrent\(\)\) return;/.test(eng) && /!CAPTURE && isCurrent\(\)\)\{ last=performance\.now\(\)/.test(eng), "engine @gen: a superseded run's rAF loop stops (and visibilitychange won't restart it)");
ok(/<script|engine\.js/.test(rd("components/FlightCanvas.tsx")) && /\[search\]\);/.test(rd("components/FlightCanvas.tsx")), "FlightCanvas still re-runs engine.js on a search change (the remount the @gen guard covers)");

// ---- harness
const DEFAULT_BUY_USD = [10, 25, 50, 100];
let CUR = null;   // the current page's window
function page({ saved = null, cfgBuy = null, fixed = true } = {}) {
  const win = new EventTarget(); CUR = win; const store = new Map(); const SEL_KEY = "disciple.swap.sel";
  if (saved) store.set(SEL_KEY, JSON.stringify(saved));
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const fills = []; const intervals = []; const engines = [];
  const dispatchEvent = (e) => win.dispatchEvent(e);
  const fakeWin = { addEventListener: (...a) => win.addEventListener(...a), removeEventListener: (...a) => win.removeEventListener(...a), dispatchEvent,
    setInterval: (f, ms) => intervals.push(f), __discipleTrade() {} };
  const document = { hidden: false };
  function bootEngine() {
    const gen = engines.length + 1;
    const S = { fuelers: { you: 0 }, hold: { tokens: 1e6, valueUsd: 50 }, liveBag: { tokens: 1e6 }, flashes: [], feed: [], mode: 0, balance: 1e6, liveCash: 1e6,
      gasPerOpUsd: 0, confirmed: { mcap: 7e4 }, pending: [], cooldownUntil: 0, buyBoost: 0, score: 0, simF: 1, t: 0, ammoTier: null, rocketAmmoTier: null };
    const MODES = DEFAULT_BUY_USD.map((usd, i) => ({ usd, name: "P" + i, key: String(i + 1) }));
    const env = { window: fakeWin, document, S, MODES, DEFAULT_BUY_USD, AMMO_TIERS: null, noteBuyAmount() {}, pushPaperCash() {}, dispatchEvent, CustomEvent,
      hasTokens: () => true, noTokens() {}, isLive: () => true, markMcap: () => 7e4, MIN_SHOT: 0.2, fmtShot: (x) => "$" + (+x).toFixed(2), fmtMoney: (x) => "$" + (+x).toFixed(2),
      applyThrust() {}, srcImpact: () => 1.02, fillMcapEst: () => 7e4, MAX_PENDING: 999, performance: { now: () => 1 }, mcapToAlt: (m) => Math.log10(m),
      shownMcap: () => S.confirmed.mcap, clamp: (x, a, b) => Math.max(a, Math.min(b, x)), SESSION: null, isOnchainRevert: () => true, setTimeout: () => 0,
      source: { supply: 7e9, impact: () => 1.02, submitTrade: (side, usd) => { fills.push({ gen, side, usd }); return Promise.resolve({ ok: true, filled: true, txHash: "0x" + fills.length }); } } };
    let body = genBlk + "\n" + pushAmmoFn + "\n" + queryLsn + "\n" + overrideBlk + "\n" + trBlock + "\n" + shootLsn + "\n" + customLsn + "\n" + boostFn + "\n"
      + "function selectTile(i){ " + tileSel + " }\nfunction hotkey(bi){ " + hotSel + " }\n" + "setInterval(()=>S.ticks=(S.ticks||0)+1,1000);\n";
    if (!fixed) body = body.replace(/const GEN=window\.__flightGen=[^\n]*/, "const isCurrent=()=>true;").replace(/^function (add|remove)EventListener\([^\n]*\n/gm, "");
    body += (fixed ? bootTail : "") + "\nreturn { S, MODES, boost, selectTile, hotkey };";
    const E = new Function(...Object.keys(env), body)(...Object.values(env)); E.gen = gen; engines.push(E); return E; }
  // TradeBridge (mounted before the engine script loads, as on the real page)
  const R = { mode: 0, custom: "", ammo: { usd: DEFAULT_BUY_USD.slice(), mode: 0 }, get customUsd() { return +R.custom > 0 ? +R.custom : 0; } };
  const MODESui = DEFAULT_BUY_USD.map((usd) => ({ usd }));
  const tbEnv = { R, dispatchEvent, CustomEvent, Event, localStorage, SEL_KEY, MODES: MODESui, window: { dispatchEvent }, queueMicrotask,
    booted: { current: false }, pushCfg: { current() {} }, cfgRef: { current: { buy: cfgBuy, tag: false, sells: [10, 25, 50, 100] } }, customRef: { get current() { return R.customUsd; } },
    setAmmo: (d) => { R.ammo = d; }, setMode: (m) => { R.mode = m; }, setCustom: (v) => { const was = R.customUsd; R.custom = v; if (R.customUsd !== was) dispatchEvent(new CustomEvent("disciple:custombuy", { detail: { usd: R.customUsd } })); },
    tradeClick() {} };
  const T = new Function(...Object.keys(tbEnv), "with (R) {\n" + tsx(tbPresets + "\n" + tbPushCfg + "\nconst ammoH = (() => { " + tbAmmoH + " return h; })();\nconst bootH = (() => { " + tbBootH
    + " return h; })();\nconst restoreH = (() => { let restored = false, tries = 0; " + tbRestoreH + " return h; })();\n" + tbShoot
    + "\nconst onPickBuy = " + tbPick + ";\nconst onSetBuy = " + tbSet + ";\nconst shotUsd = () => " + tbShot + ";\n"
    + "addEventListener('disciple:ammo', ammoH); " + tbQuery + "\naddEventListener('disciple:ammo', bootH);\naddEventListener('disciple:ammo', restoreH);\n"
    + "return { shoot, onPickBuy, onSetBuy, shotUsd };") + "\n}")(...Object.values(tbEnv));
  return { win, R, T, store, fills, engines, intervals, bootEngine, settle: () => new Promise((r) => setImmediate(r)), sel: () => JSON.parse(store.get(SEL_KEY) || "{}") };
}
// TradeBridge's useEffects call the global addEventListener: route them to the page under test.
globalThis.addEventListener = (...a) => CUR.addEventListener(...a); globalThis.removeEventListener = (...a) => CUR.removeEventListener(...a);
const open = page;
const amounts = (P, from = 0) => P.fills.slice(from).map((f) => f.usd);
const tapN = async (P, n, fn) => { const f0 = P.fills.length; for (let i = 0; i < n; i++) fn(); await P.settle(); return amounts(P, f0); };
const all = (a, v) => a.length > 0 && a.every((x) => Math.abs(x - v) < 1e-9);

console.log("— 1. remembered preset ($50) survives boot — desktop BOOST, rapid taps");
{ const P = open({ saved: { buy: 2 } }); P.bootEngine(); await P.settle();
  const E = P.engines[0];
  ok(P.R.mode === 2 && E.S.mode === 2 && P.T.shotUsd() === 50, `boot: TradeBridge mode ${P.R.mode}, engine mode ${E.S.mode}, BOOST label $${P.T.shotUsd()} (was mode 0 / $10: no disciple:ammo ever came)`);
  const a = await tapN(P, 5, () => P.T.shoot("buy"));
  ok(all(a, 50) && a.length === 5, `5 rapid BOOST clicks = 5 fills of $50, never $10 (${a.join(",")})`);
  const s = await tapN(P, 3, () => E.boost());
  ok(all(s, 50), `Space ×3 = $50 each (${s.join(",")})`); }

console.log("— 2. engine re-run (FlightCanvas search change) — one live engine, same amounts");
{ const P = open({ saved: { buy: 2 } }); P.bootEngine(); await P.settle();
  P.T.onSetBuy("37"); P.bootEngine(); await P.settle();   // custom $37 typed, then the quote resolves → engine re-runs
  const [old, cur] = P.engines;
  const a = await tapN(P, 6, () => P.T.shoot("buy"));
  ok(all(a, 37) && a.length === 6 && P.fills.slice(-6).every((f) => f.gen === 2), `6 rapid BOOST taps after the re-run = 6 fills of $37 from the new engine only (${a.join(",")}; was 12, doubled)`);
  const s = await tapN(P, 4, () => cur.boost());
  ok(all(s, 37) && s.length === 4, `Space after the re-run buys the custom $37 (custombuy re-pushed on boot) (${s.join(",")})`);
  P.T.onSetBuy(""); await P.settle();
  ok(cur.S.mode === 2 && P.R.mode === 2 && P.T.shotUsd() === 50, "cleared custom → the remembered $50 preset (restored on the new engine too)");
  const b = await tapN(P, 4, () => P.T.shoot("buy"));
  ok(all(b, 50) && b.length === 4, `BOOST ×4 = $50 (${b.join(",")})`);
  cur.selectTile(1); await P.settle();   // desktop canvas tile — only the live engine's canvas gets the pointer
  const c = await tapN(P, 3, () => cur.boost());
  ok(P.R.mode === 1 && all(c, 25) && c.length === 3, `desktop tile $25 then Space ×3 = $25 each, no stale-engine $10 (${c.join(",")})`);
  const t0 = old.S.ticks || 0, t1 = cur.S.ticks || 0; P.intervals.forEach((f) => f());
  ok((old.S.ticks || 0) === t0 && cur.S.ticks === t1 + 1, "superseded engine's intervals stop; the live one's run");
  const seen = []; P.win.addEventListener("disciple:ammo", (e) => seen.push(e.detail.mode)); P.win.dispatchEvent(new CustomEvent("disciple:ammo-query"));
  ok(seen.length === 1 && seen[0] === 1, `ammo-query after the re-run: answered once, by the live engine (${seen.length} answers)`); }

console.log("— 3. phone path: preset sheet + custom SET, rapid BOOST taps");
{ const P = open({ saved: { buy: 0 } }); P.bootEngine(); await P.settle();
  P.T.onPickBuy(3); await P.settle();
  const a = await tapN(P, 8, () => P.T.shoot("buy"));
  ok(P.engines[0].S.mode === 3 && all(a, 100) && a.length === 8, `pick $100 → 8 rapid BOOST taps = $100 each (${a.join(",")})`);
  ok(P.sel().buy === 3, "the $100 pick is remembered (disciple.swap.sel)");
  P.T.onSetBuy("12.5");
  const b = await tapN(P, 5, () => P.T.shoot("buy"));
  ok(all(b, 12.5) && b.length === 5, `SET custom $12.50 → 5 rapid BOOST taps = $12.50 each (${b.join(",")})`);
  P.T.onPickBuy(1); await P.settle();
  const c = await tapN(P, 3, () => P.T.shoot("buy"));
  ok(P.R.customUsd === 0 && all(c, 25), `back to the $25 preset (custom cleared) → $25 each (${c.join(",")})`);
  P.bootEngine(); await P.settle();   // phone re-run (e.g. rotate → search change)
  const d = await tapN(P, 4, () => P.T.shoot("buy"));
  ok(all(d, 25) && d.length === 4 && P.fills.slice(-4).every((f) => f.gen === 2), `after an engine re-run the phone still buys $25, once per tap (${d.join(",")})`); }

console.log("— 4. Swap-settings presets (custom 4) reach a freshly booted engine");
{ const P = open({ saved: { buy: 2 }, cfgBuy: [5, 15, 40, 90] }); P.bootEngine(); await P.settle();
  const a = await tapN(P, 3, () => P.T.shoot("buy")), s = await tapN(P, 2, () => P.engines[0].boost());
  ok(P.T.shotUsd() === 40 && all(a, 40) && all(s, 40), `selected preset #3 = $40 on BOOST (${a.join(",")}) and Space (${s.join(",")})`);
  P.engines[0].hotkey(0); await P.settle();
  const k = await tapN(P, 3, () => P.T.shoot("buy"));
  ok(all(k, 5), `hotkey 1 → $5 preset, BOOST = $5 (${k.join(",")})`); }

console.log("— 5. the same harness on the pre-fix engine reproduces the bug (guards the test itself)");
{ const P = open({ saved: { buy: 2 }, fixed: false }); P.bootEngine(); await P.settle();
  const a = await tapN(P, 1, () => P.T.shoot("buy"));
  ok(P.T.shotUsd() === 10 && all(a, 10), `pre-fix: remembered $50 but BOOST label/fill = $10 (${a.join(",")})`);
  P.T.onSetBuy("37"); P.bootEngine(); await P.settle();
  const b = await tapN(P, 1, () => P.T.shoot("buy"));
  ok(b.length === 2, `pre-fix: one BOOST tap after a re-run = ${b.length} fills (${b.join(",")})`); }

console.log(bad ? `\n${bad} FAILED` : "\nall ok"); process.exit(bad ? 1 : 0);
