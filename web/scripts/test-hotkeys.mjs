// Hotkeys (maker lee, 2026-10): buy-preset keys (default 1–4; 4 buy presets since GAME trade-ui-fixes) and sell-size keys (default Z/X/C/V) only SELECT, they never
// trade; SPACE = BOOST buys the ACTIVE amount (the trade bar's custom $ when filled, else the selected preset); SHIFT = DUMP.
// Bindings are customizable (ESC settings menu → lib/game/settings.ts) and no gameplay key fires while the menu is open.
// Evaluates the engine's own @hotkeys block (public/flight/engine.js) with stubs, plus the settings store + i18n tables.
//   Run: node scripts/test-hotkeys.mjs
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
const dir = path.dirname(fileURLToPath(import.meta.url)), web = path.join(dir, "..");
let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
const rd = (f) => fs.readFileSync(path.join(web, f), "utf8");

// ---- engine @hotkeys block -----------------------------------------------------------------------------------
const eng = rd("public/flight/engine.js");
const a = eng.indexOf("/* @hotkeys"), b = eng.indexOf("/* @hotkeys-end */");
ok(a > 0 && b > a, "engine.js has the @hotkeys … @hotkeys-end block");
ok(!/buyPreset\(/.test(eng), "engine.js: no buyPreset() (digits used to BUY on press)");
ok(/addEventListener\('keydown',onHotkey\)/.test(eng), "engine.js: keydown → onHotkey");
// the block defines onHotkey (the engine registers it right after the block); return it so the test can drive it
function engine(ls = null) {
  const E = { L: {}, out: [], trades: [], ammo: [], flags: { noTokens: 0, tokens: true } };
  E.S = { keys: {}, mode: 2, t: 0, grass: false };
  E.MODES = [1, 2, 3, 4].map((k) => ({ key: String(k), usd: k * 10 }));
  class CE { constructor(type, o) { this.type = type; this.detail = o && o.detail; } }
  const env = {
    S: E.S, MODES: E.MODES, CustomEvent: CE, isTyping: (e) => !!e.typing,
    addEventListener: (t, f) => { (E.L[t] = E.L[t] || []).push(f); },
    dispatchEvent: (e) => { E.out.push(e); (E.L[e.type] || []).forEach((f) => f(e)); return true; },
    localStorage: { getItem: (k) => (k === "disciple.game.settings.v1" ? ls : null) },
    trade: (side, opt) => E.trades.push({ side, opt }), pushAmmo: () => E.ammo.push(E.S.mode),
    hasTokens: () => E.flags.tokens, noTokens: () => E.flags.noTokens++,
    setOrbs() {}, setChartMap() {}, setPnlTag() {}, setBombs() {}, window: { __flight: { source: {} } }, source: {}, MockReplaySource: class {},
  };
  const onHotkey = new Function(...Object.keys(env), eng.slice(a, b) + "\nreturn onHotkey;")(...Object.values(env));
  E.key = (code, o = {}) => onHotkey({ code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {}, ...o });
  E.emit = (type, detail) => env.dispatchEvent(new CE(type, { detail }));
  E.events = (type) => E.out.filter((e) => e.type === type);
  return E;
}
{ const E = engine();
  for (let i = 0; i < 6; i++) E.key("Digit" + (i + 1));
  ok(E.trades.length === 0, "1–6 never trade (was: digit = BUY that preset now)");
  ok(E.S.mode === 3 && E.ammo.join() === "0,1,2,3", "1–4 select the 4 buy presets (S.mode + ammo push); 5/6 are unbound and do nothing");
  E.key("Space");
  ok(E.trades.length === 1 && E.trades[0].side === "buy" && E.trades[0].opt === undefined, "SPACE with no custom $ buys the selected preset");
  E.emit("disciple:custombuy", { usd: 37 }); E.key("Space");
  ok(E.trades.length === 2 && E.trades[1].opt && E.trades[1].opt.usd === 37, "SPACE with a custom $37 buys $37 (the active amount), not the preset");
  E.key("Digit1"); E.key("Space");
  ok(E.trades.length === 3 && E.trades[2].opt.usd === 37 && E.S.mode === 0, "selecting a preset while a custom $ is filled: SPACE still fires the custom $ (custom wins, as the BOOST button)");
  E.emit("disciple:custombuy", { usd: 0 }); E.key("Space");
  ok(E.trades.length === 4 && E.trades[3].opt === undefined, "custom $ cleared → SPACE buys the preset again");
  E.key("Space", { repeat: true });
  ok(E.trades.length === 4, "held SPACE (key repeat) does not re-fire");
  for (const [i, c] of ["KeyZ", "KeyX", "KeyC", "KeyV"].entries()) E.key(c);
  const sel = E.events("disciple:sellselect").map((e) => e.detail.i).join();
  ok(E.trades.length === 4 && sel === "0,1,2,3" && E.events("disciple:dump").length === 0, "Z/X/C/V only select a sell size (disciple:sellselect 0–3), never dump");
  E.key("ShiftLeft");
  ok(E.events("disciple:dump").length === 1 && E.trades.length === 4, "SHIFT = DUMP (disciple:dump → TradeBridge sizes the selected %)");
  E.flags.tokens = false; E.key("ShiftRight");
  ok(E.events("disciple:dump").length === 1 && E.flags.noTokens === 1, "SHIFT with no tokens: no dump, 'no tokens' hint");
  E.key("Space", { typing: true }); E.key("Digit3", { typing: true });
  ok(E.trades.length === 4 && E.S.mode === 0, "typing in a field: SPACE / digits do nothing");
  E.emit("disciple:menu", { open: true }); E.key("Space"); E.key("Digit4"); E.key("KeyZ"); E.flags.tokens = true; E.key("ShiftLeft");
  ok(E.trades.length === 4 && E.S.mode === 0 && E.events("disciple:dump").length === 1 && E.events("disciple:sellselect").length === 4, "ESC menu open: SPACE / SHIFT / 1–4 / Z–V do nothing");
  E.emit("disciple:menu", { open: false }); E.key("Space");
  ok(E.trades.length === 5, "menu closed: SPACE boosts again"); }
{ const E = engine();
  E.emit("disciple:hotkeys", { buy: ["KeyQ", "KeyE", "KeyR", "KeyY"], sell: ["Digit1", "Digit2", "Digit3", "Digit4"] });
  E.key("KeyR"); ok(E.S.mode === 2 && E.trades.length === 0, "custom binding: R selects preset 3 (no trade)");
  E.key("Digit1"); ok(E.S.mode === 2 && E.events("disciple:sellselect").map((e) => e.detail.i).join() === "0", "custom binding: 1 now selects sell size 1, not a buy preset");
  ok(E.MODES.map((m) => m.key).join("") === "QERY", "engine ammo labels follow the bindings (MODES[i].key)");
  E.emit("disciple:hotkeys", { buy: ["KeyQ", "KeyE", "KeyR", "KeyY", "KeyU", "KeyI"], sell: ["Digit1", "Digit2", "Digit3", "Digit4"] });
  ok(E.MODES.map((m) => m.key).join("") === "QERY", "an older 6-key buy binding keeps its first 4 keys"); }
{ const E = engine(JSON.stringify({ v: 1, keys: { buy: ["Numpad1", "Numpad2", "Numpad3", "Numpad4", "Numpad5", "Numpad6"], sell: ["KeyZ", "KeyX", "KeyC", "KeyV"] } }));
  E.key("Numpad4"); ok(E.S.mode === 3 && E.MODES[3].key === "N4", "bindings saved in localStorage (old 6-key save) apply at engine boot (before React pushes them)"); }

// ---- trade bar (TradeBridge): pushes the custom $ to the engine; no own key listener that trades -------------------
{ const tb = rd("components/TradeBridge.tsx");
  ok(/new CustomEvent\("disciple:custombuy", \{ detail: \{ usd: customUsd \} \}\)/.test(tb), "TradeBridge pushes the custom $ (disciple:custombuy) on change");
  ok(/disciple:custombuy", \{ detail: \{ usd: customRef\.current \} \}/.test(tb), "TradeBridge re-pushes the custom $ when the engine (re)boots");
  ok(!/addEventListener\("keydown"/.test(tb), "TradeBridge has no keydown listener (engine owns gameplay keys + bindings)");
  ok(/onClick=\{\(\) => shoot\("buy"\)\}/.test(tb), "BOOST button still buys (custom $ wins)"); }
// ---- ESC menu: capture-phase key gate + disciple:menu ------------------------------------------------------------
{ const m = rd("components/flight/SettingsMenu.tsx");
  ok(/addEventListener\("keydown", k, true\)/.test(m) && /stopImmediatePropagation\(\)/.test(m), "SettingsMenu swallows game keys in the capture phase while open");
  ok(/disciple:menu", \{ detail: \{ open: paused \} \}/.test(m), "SettingsMenu tells the engine (disciple:menu) when gameplay is paused");
  const wb = rd("lib/flight/workerBridge.ts");
  ok(["disciple:hotkeys", "disciple:custombuy", "disciple:menu", "disciple:orbs"].every((e) => wb.includes(`"${e}"`)) && wb.includes('"disciple.game.settings.v1"'), "worker render path forwards hotkeys / custom $ / menu / orbs + the settings key"); }

// ---- settings store + i18n tables ------------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hotkeys-"));
const tx = (src) => ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
fs.writeFileSync(path.join(tmp, "react.mjs"), "export const useSyncExternalStore=()=>{}; export const useCallback=(f)=>f;");
fs.writeFileSync(path.join(tmp, "settings.mjs"), tx(rd("lib/game/settings.ts").replace(/from "react"/, 'from "./react.mjs"')));
fs.writeFileSync(path.join(tmp, "i18n.mjs"), tx(rd("lib/game/i18n.ts").replace(/from "react"/, 'from "./react.mjs"').replace(/from "\.\/settings"/, 'from "./settings.mjs"')));
const G = await import(pathToFileURL(path.join(tmp, "settings.mjs")).href);
const I = await import(pathToFileURL(path.join(tmp, "i18n.mjs")).href);
{ const d = G.sanitizeGameSettings(null);
  ok(d.keys.buy.join() === "Digit1,Digit2,Digit3,Digit4" && d.keys.sell.join() === "KeyZ,KeyX,KeyC,KeyV", "defaults: buy 1–4, sell Z/X/C/V");
  ok(G.sanitizeGameSettings({ keys: { buy: ["KeyQ", "KeyE", "KeyR", "KeyY", "KeyU", "KeyI"], sell: ["KeyZ", "KeyX", "KeyC", "KeyV"] } }).keys.buy.join() === "KeyQ,KeyE,KeyR,KeyY", "an older 6-key save keeps its first 4 buy keys");
  ok(["Space", "ShiftLeft", "Escape", "KeyW", "KeyG", "KeyO", "Enter"].every((c) => !G.isBindable(c)) && G.isBindable("KeyQ") && G.isBindable("Numpad1"), "SPACE / SHIFT / ESC / steering / toggles are not bindable");
  const s1 = G.bindKey(d, { kind: "buy", i: 0 }, "KeyZ");
  ok(s1.keys.buy[0] === "KeyZ" && s1.keys.sell[0] === "Digit1", "binding a key used by another slot swaps them (no duplicates)");
  ok(G.bindKey(d, { kind: "buy", i: 0 }, "Space") === d, "binding a reserved key is refused");
  const dup = G.sanitizeGameSettings({ keys: { buy: ["KeyQ", "KeyQ", "Space", "Digit4", "Digit5", "Digit6"], sell: ["KeyZ", "KeyX", "KeyC", "KeyV"] }, sfx: { on: false, vol: 3 }, lang: "xx" });
  ok(new Set(dup.keys.buy.concat(dup.keys.sell).filter(Boolean)).size === dup.keys.buy.concat(dup.keys.sell).filter(Boolean).length && dup.keys.buy[0] === "KeyQ", "sanitize: duplicate / reserved stored keys dropped");
  ok(dup.sfx.on === false && dup.sfx.vol === 1 && dup.lang === "en", "sanitize: volume clamped 0..1, unknown language → en");
  ok(G.audioLevel("sfx", dup) === 0 && G.audioLevel("music", d) === 0.5, "audioLevel: 0 when muted, else the volume");
  ok(["Digit1", "KeyZ", "Numpad3"].map(G.keyLabel).join() === "1,Z,Num3", "keyLabel"); }
{ const en = Object.keys(I.DICTS.en);
  ok(I.LOCALES.map((l) => l.id).join() === "en,zh,ko,ja,es" && I.LOCALES.map((l) => l.label).join() === "English,中文,한국어,日本語,Español", "locales: English, 中文, 한국어, 日本語, Español");
  for (const id of ["zh", "ko", "ja", "es"]) { const k = Object.keys(I.DICTS[id]); ok(k.every((x) => en.includes(x)) && k.length >= en.length - 3, `${id}: ${k.length}/${en.length} HUD strings drafted, no unknown keys, marked ${I.REVIEW_STATUS[id]}`); }
  ok(I.translate("zh", "pnl.mcap") === "市值" && I.translate("es", "tb.boost") === "BOOST" && I.translate("ja", "ctl.shot", { shot: "$5" }).includes("$5"), "translate: locale string, English fallback, {vars}");
  ok(/BRAND \/ NATIVE REVIEW NEEDED/.test(rd("lib/game/i18n.ts")), "i18n drafts are marked for BRAND/native review in code"); }

console.log(bad ? `\n${bad} FAILED` : "\nall hotkey checks passed");
process.exit(bad ? 1 : 0);
