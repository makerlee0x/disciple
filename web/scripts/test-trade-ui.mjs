// Trade UI fixes (game/trade-ui-fixes): one check group per fix.
//   1. every confirmed SELL is drawn on the chart, sized from the real USDG received (decoded receipt / feed swap /
//      /api/trades usdOut ?? usd); sells are never filtered by MIN_SHOT (that stays a buy-side gas guard)
//   2. GameChat is closed by default and never opens itself on H / Enter (keys act only inside an open, focused dock)
//   3. buy presets default $10 / $25 / $50 / $100 (customisable, ESC menu + Swap settings share one store);
//      sell sizes fixed 10 / 25 / 50 / 100% of the bag; one custom field per side; 1–4 + Z/X/C/V only SELECT, SPACE fires
// Evaluates the engine's own blocks (public/flight/engine.js) with stubs, plus the lib modules (transpiled).
//   Run: node scripts/test-trade-ui.mjs
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { loadLib } from "./lib/load-ts.mjs";
const dir = path.dirname(fileURLToPath(import.meta.url)), web = path.join(dir, "..");
let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const rd = (f) => fs.readFileSync(path.join(web, f), "utf8");
const eng = rd("public/flight/engine.js");
const block = (a, b) => { const i = eng.indexOf(a), j = eng.indexOf(b); if (!(i > 0 && j > i)) throw new Error("engine block " + a); return eng.slice(i, j); };
const { mods, cleanup } = await loadLib(["config", "trade/swapSettings"], "tradeui-");
const cfg = mods.config, SW = mods["trade/swapSettings"];
// lib/game/settings imports react (useSyncExternalStore): transpile it with a stub, as test:hotkeys does
const tmpG = fs.mkdtempSync(path.join(os.tmpdir(), "tradeui-gs-"));
fs.writeFileSync(path.join(tmpG, "react.mjs"), "export const useSyncExternalStore=()=>{}; export const useCallback=(f)=>f;");
fs.writeFileSync(path.join(tmpG, "settings.mjs"), ts.transpileModule(rd("lib/game/settings.ts").replace(/from "react"/, 'from "./react.mjs"'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText);
const GS = await import(pathToFileURL(path.join(tmpG, "settings.mjs")).href);

// ───────────── Fix 1: sells always on the chart ─────────────
function chartEnv({ live = true, mark = 7e4 } = {}) {
  const C = { mine: [], seen: new Set() }, E = { C, ticks: [], bombs: [], mom: [] };
  const S = { feed: [], confirmed: { mcap: 0 }, simF: 1, fullStackNext: false };
  const L = {};
  const env = { S, chartState: () => C, chartNow: () => 1000, isLive: () => live, markMcap: () => mark,
    chartTick: (m, usd, side) => E.ticks.push({ m, usd, side }), momNote: (s, u) => E.mom.push(u), noteSell: (e) => E.bombs.push(e),
    fmtShot: (u) => "$" + u, fmtUsd: (u) => "$" + u, performance: { now: () => 0 },
    addEventListener: (t, f) => { (L[t] = L[t] || []).push(f); } };
  const r = new Function(...Object.keys(env), block("function hudNoteTrade(e)", "/* @sellfill-end */") + "\nreturn {hudNoteTrade, ownSellSwap, onFillReceipt};")(...Object.values(env));
  // the engine's swap path: onEvent → ownSellSwap (dedupe / receipt $) → hudNoteTrade (chart); feed row + bomb when usd>0
  E.swap = (e) => { const x = r.ownSellSwap(e); if (!x) return null; r.hudNoteTrade(x); if (x.side === "sell" && x.usd > 0) E.bombs.push(x); return x; };
  E.receipt = (d) => (L["disciple:fillreceipt"] || []).forEach((f) => f({ detail: d }));
  return { ...E, ...r, S };
}
{ const E = chartEnv();
  E.swap({ t: "swap", side: "sell", mine: true, txHash: "0xA", mcap: 6e4, usd: 0 });
  ok(E.C.mine.length === 1 && E.C.mine[0].side === "sell", "own sell with no $ in the feed (was: dropped by `usd>0`) is still marked on the chart");
  E.receipt({ txHash: "0xa", side: "sell", usd: 12.5 });
  ok(E.C.mine.length === 1, "its receipt arriving later does not add a second marker (deduped by tx)"); }
{ const E = chartEnv();
  E.receipt({ txHash: "0xB", side: "sell", usd: 0.004 });
  ok(E.C.mine.length === 1 && E.ticks.some((t) => t.side === "sell" && near(t.usd, 0.004)), "receipt first: a $0.004 dust sell is marked + sized from the real USDG (MIN_SHOT never applies)");
  ok(E.S.feed.length === 1 && /DUMP/.test(E.S.feed[0].txt) && E.bombs.length === 1 && near(E.bombs[0].usd, 0.004), "receipt first: feed row + sell bomb with the received $");
  const x = E.swap({ t: "swap", side: "sell", mine: true, txHash: "0xb", mcap: 6.9e4, usd: 0.004 });
  ok(x === null && E.C.mine.length === 1 && E.bombs.length === 1 && E.S.confirmed.mcap === 6.9e4, "the feed swap for the same tx later only moves the price (no duplicate marker / bomb)"); }
{ const E = chartEnv();
  E.receipt({ txHash: "0xC", side: "sell", usd: 42 });   // receipt known, then a feed swap without $ for an unseen tx id case
  const E2 = chartEnv(); E2.S.rcpt.set("0xd", { usd: 42 });
  const x = E2.swap({ t: "swap", side: "sell", mine: true, txHash: "0xD", mcap: 6e4, usd: 0 });
  ok(x && near(x.usd, 42) && E2.bombs.length === 1 && E2.ticks.some((t) => near(t.usd, 42)), "feed swap with no $: sized from the decoded receipt (real USDG received)"); }
{ const E = chartEnv();
  E.swap({ t: "swap", side: "buy", mine: true, txHash: "0xE", mcap: 6e4, usd: 0 });
  ok(E.C.mine.length === 0, "a $0 BUY is not marked (only sells are forced on)");
  E.swap({ t: "swap", side: "sell", mine: false, txHash: "0xF", mcap: 6e4, usd: 0.0001 });
  ok(E.C.mine.length === 0 && E.ticks.length === 2, "other traders' sells still tick the chart (no own marker)"); }
{ const fu = new Function(eng.slice(eng.indexOf("function fillUsd(f)"), eng.indexOf("function chartBackfill(")) + "return fillUsd;")();
  ok(fu({ side: "sell", usd: "9", usdOut: "8.7" }) === 8.7, "/api/trades sell: usdOut (USDG received) wins over usd");
  ok(fu({ side: "sell", usd: "9" }) === 9 && fu({ side: "sell", usdOut: null, usd: 3 }) === 3, "/api/trades sell without usdOut → usd (usdOut ?? usd)");
  ok(fu({ side: "buy", usd: "5", usdIn: "5.1" }) === 5.1 && fu({ side: "buy", usd: 5 }) === 5, "/api/trades buy: usdIn ?? usd");
  ok(/usd:fillUsd\(f\)/.test(eng) && /f\.mine&&f\.m>0&&\(f\.usd>0\|\|f\.side==='sell'\)/.test(eng), "chart backfill sizes fills with fillUsd and always marks own sells"); }
{ // trade(): sells never blocked by MIN_SHOT; buys still are
  function tradeEnv({ live, liveTokens = 0, usd = 0.1 }) {
    const E = { submits: [], flashes: [] };
    const S = { fuelers: { you: 0 }, hold: { tokens: 1e3, valueUsd: 0.002 }, liveBag: live ? { tokens: liveTokens } : null, flashes: E.flashes, mode: 0, balance: 100, confirmed: { mcap: 7e4 }, promoLeft: 0 };
    const env = { S, MODES: [{ usd }], hasTokens: () => true, noTokens() {}, isLive: () => live, markMcap: () => 7e4, source: { supply: 1e6 },
      MIN_SHOT: 0.5, PROMO_GAS: false, GAS_USD: 0.01, applyThrust() {}, srcImpact: () => 1, fmtShot: String, window: live ? { __discipleTrade() {} } : {},
      submit: (side, u, force, opt) => E.submits.push({ side, usd: u, opt }) };
    E.trade = new Function(...Object.keys(env), block("/* @trade", "/* @trade-end */") + "\nreturn trade;")(...Object.values(env));
    return E; }
  let E = tradeEnv({ live: true, liveTokens: 100 }); E.trade("sell", { usd: 0.01, frac: 0.1 });
  ok(E.submits.length === 1 && E.submits[0].side === "sell", "live 10% sell of a $0.0001 bag is submitted (below MIN_SHOT, never filtered)");
  E = tradeEnv({ live: false }); E.trade("sell", { usd: 0.0005, frac: 0.25 });
  ok(E.submits.length === 1 && !E.flashes.some((f) => /BELOW MIN|min/i.test(f.txt)), "paper sell below MIN_SHOT: submitted, no 'below min' flash");
  E = tradeEnv({ live: false, usd: 0.1 }); E.trade("buy");
  ok(E.submits.length === 0, "buy below MIN_SHOT is still blocked (gas guard)"); }
ok(rd("lib/flight/workerBridge.ts").includes('"disciple:fillreceipt"'), "worker render path forwards disciple:fillreceipt to the engine");
ok(/dispatchEvent\(new CustomEvent\("disciple:fillreceipt"/.test(rd("components/TradeBridge.tsx")), "TradeBridge emits the decoded receipt (disciple:fillreceipt)");

// ───────────── Fix 2: chat closed by default, no H / Enter hijack ─────────────
{ const gc = rd("components/gamechat/GameChat.tsx");
  ok(/const \[open, setOpen\] = useState\(false\)/.test(gc), "GameChat starts closed");
  ok(/localStorage\.getItem\("disciple\.gamechat\.open"\) === "1"/.test(gc), "stored choice kept: opens at load only if the player left it open ('1')");
  ok(/localStorage\.setItem\("disciple\.gamechat\.open", open \? "1" : "0"\)/.test(gc), "open / closed choice is still persisted");
  const keyFx = gc.slice(gc.indexOf("Chat never opens itself"), gc.indexOf("// rate-limit countdown"));
  ok(keyFx.length > 0 && !/setOpen\(/.test(keyFx), "the key handler never calls setOpen (H / Enter cannot open chat)");
  ok(/if \(!api \|\| !open\) return;/.test(keyFx), "no key listener at all while chat is closed");
  ok(/data-testid="chat-open" onClick=\{\(\) => setOpen\(true\)\}/.test(gc), "chat opens from the explicit toggle click");
  ok(!/Open chat \(Enter\)/.test(gc), "toggle no longer advertises Enter");
  // the pure gate, transpiled from the component source
  const src = gc.slice(gc.indexOf("export function chatKeyApplies"), gc.indexOf("export default function GameChat")).replace("export ", "").replace(/: \{[^)]*\}\)/, ")");
  const gate = new Function(src + "return chatKeyApplies;")();
  const base = { open: true, inDock: true, typing: false, mod: false };
  ok(gate(base) === true, "open + focus inside the dock → H / Enter act (tab toggle / focus input)");
  ok(gate({ ...base, inDock: false }) === false, "focus on the game / trade bar → chat ignores H / Enter");
  ok(gate({ ...base, open: false }) === false, "chat closed → chat ignores every key");
  ok(gate({ ...base, typing: true }) === false && gate({ ...base, mod: true }) === false, "typing in the message box / modifier keys → no chat shortcut"); }

// ───────────── Fix 3: presets ─────────────
ok(JSON.stringify(cfg.MODES.map((m) => m.usd)) === "[10,25,50,100]", "lib/config MODES: 4 buy presets $10 / $25 / $50 / $100");
ok(JSON.stringify(SW.DEFAULT_BUY) === "[10,25,50,100]" && JSON.stringify(SW.buyAmounts(SW.sanitize(null))) === "[10,25,50,100]", "swapSettings: default buy amounts $10 / $25 / $50 / $100");
ok(JSON.stringify(SW.sanitize({ buy: [5, 20, 75, 250] }).buy) === "[5,20,75,250]", "custom buy presets are kept");
ok(SW.sanitize({ buy: [0.01, 0.5, 5, 10, 100, 1000] }).buy === null, "an old 6-tier (FEATHER…GLORY) save → back to the new defaults");
ok(SW.sanitize({ buy: [10, -1, 50, 100] }).buy === null, "an invalid buy save → defaults");
ok(JSON.stringify(SW.DEFAULT_SELLS) === "[10,25,50,100]", "sell sizes 10 / 25 / 50 / 100%");
ok(JSON.stringify(SW.sanitize({ v: 3, sells: [12, 33, 77, 5] }).sells) === "[10,25,50,100]" && JSON.stringify(SW.sanitize({ sells: [1, 2, 3, 4] }).sells) === "[10,25,50,100]", "sell sizes are fixed: any saved custom % → 10 / 25 / 50 / 100");
{ const p = eng.slice(eng.indexOf("/* @presets"), eng.indexOf("/* @presets-end */"));
  const r = new Function(p + "\nreturn {MODES, DEFAULT_BUY_USD};")();
  ok(JSON.stringify(r.MODES.map((m) => m.usd)) === "[10,25,50,100]" && r.MODES.map((m) => m.key).join("") === "1234", "engine MODES: 4 presets 1–4 = $10 / $25 / $50 / $100");
  const S = { ammoOverride: null }, pushed = [];
  const o = new Function("S", "MODES", "DEFAULT_BUY_USD", "pushAmmo", "addEventListener", block("/* @ammo-override", "/* @ammo-override-end */") + "\nreturn setBuyPresets;");
  const L = {}; const set = o(S, r.MODES, r.DEFAULT_BUY_USD, () => pushed.push(r.MODES.map((m) => m.usd).join()), (t, f) => { L[t] = f; });
  set([5, 20, 75, 250]); ok(r.MODES.map((m) => m.usd).join() === "5,20,75,250", "engine: custom buy presets (disciple:ammo-override) apply to the 4 tiles");
  set(null); ok(r.MODES.map((m) => m.usd).join() === "10,25,50,100", "engine: override cleared → defaults (no mcap tier scaling)");
  set([1, 2, 3, 4, 5, 6]); ok(r.MODES.map((m) => m.usd).join() === "10,25,50,100", "engine: a wrong-length override is ignored → defaults");
  ok(typeof L["disciple:ammo-override"] === "function" && pushed.length >= 3, "engine listens for disciple:ammo-override and re-pushes the ammo panel"); }
ok(/const AMMO_TIERS=null/.test(eng) && !/MODES\[2\]\.usd[^ ]/.test(eng.replace(/\/\/[^\n]*/g, "")), "engine: mcap ammo tiers no longer rescale the presets");
ok(/mode:0,/.test(eng) && /useState\(0\)/.test(rd("components/TradeBridge.tsx")), "first preset ($10) selected by default (engine + trade bar)");
ok(/MODES\.forEach\(\(q,i\)=>\{ const TW=82, bx=ax\+50\+i\*86/.test(eng) && /hv>=0&&hv<MODES\.length/.test(eng), "ammo panel draws 4 buy tiles aligned over the 4 SELL tiles");
ok(/if\(i>=MODES\.length\) return;/.test(eng), "clicking outside the 4 buy tiles never selects a missing preset");
{ const d = GS.sanitizeGameSettings(null);
  ok(d.keys.buy.join() === "Digit1,Digit2,Digit3,Digit4" && d.keys.sell.join() === "KeyZ,KeyX,KeyC,KeyV", "ESC menu hotkeys: buy 1–4, sell Z/X/C/V (still rebindable, same storage key)");
  ok(GS.sanitizeGameSettings({ keys: { buy: ["KeyQ", "KeyE", "KeyR", "KeyY", "KeyU", "KeyI"], sell: ["KeyZ", "KeyX", "KeyC", "KeyV"] } }).keys.buy.join() === "KeyQ,KeyE,KeyR,KeyY", "an older 6-key customization keeps its first 4 keys");
  ok(GS.SETTINGS_KEY === "disciple.game.settings.v1", "hotkey customization storage key unchanged"); }
{ const hk = block("/* @hotkeys", "/* @hotkeys-end */");
  ok(/HOTKEYS=\{buy:\['Digit1','Digit2','Digit3','Digit4'\]/.test(hk), "engine default buy keys 1–4");
  ok(/S\.mode=bi; S\.pressFx=\{i:bi,t:S\.t\}; pushAmmo\(\); \} return; \}/.test(hk) && /dispatchEvent\(new CustomEvent\('disciple:sellselect'/.test(hk), "1–4 / Z/X/C/V only SELECT");
  ok(/function boost\(\)\{ trade\('buy', S\.customBuyUsd>0\?\{usd:S\.customBuyUsd\}:undefined\); \}/.test(hk) && /e\.code==='Space'\)\{ e\.preventDefault\(\); if\(!e\.repeat\) boost\(\)/.test(hk), "SPACE fires the custom $ when set, else the selected preset"); }
{ const tb = rd("components/TradeBridge.tsx"), sm = rd("components/flight/SettingsMenu.tsx"), mo = rd("components/trade/SwapSettingsModal.tsx");
  ok(/aria-label="custom amount"/.test(tb) && (tb.match(/sellUnit/g) || []).length > 2, "trade bar: one custom buy field + one custom sell field");
  ok(!/sells: d\.sells/.test(tb) && /buy: d\.buy/.test(tb), "TradeBridge presets-set only takes buy amounts (sells fixed)");
  ok(!/AMMO_TIERS/.test(tb), "TradeBridge: no mcap ammo-tier defaults");
  ok(/hk-sell-amt-\$\{i\}`\} inputMode="decimal" value=\{`\$\{sellDraft\[i\] \?\? DEFAULT_SELLS\[i\]\}%`\} readOnly/.test(sm), "ESC menu: sell sizes shown read-only");
  ok(/disciple:presets-set", \{ detail: \{ buy: buyAuto/.test(sm) && !/sells: s \}/.test(sm), "ESC menu saves buy amounts only");
  ok(/setBuyDraft\(DEFAULT_BUY\.map\(money\)\)/.test(sm), "ESC menu 'use defaults' → $10 / $25 / $50 / $100");
  ok(/swap-sell-\$\{i\}`\} value=\{`\$\{v\}%`\} readOnly/.test(mo) && /repeat\(4, 1fr\)/.test(mo), "Swap settings: 4 buy cells, sell sizes read-only"); }

cleanup(); fs.rmSync(tmpG, { recursive: true, force: true });
console.log(bad ? `\n${bad} FAILED` : "\nall trade-ui checks passed");
process.exit(bad ? 1 : 0);
