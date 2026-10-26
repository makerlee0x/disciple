// game/rapid-tap-fix — the REAL click path, end to end (v5 replay Oct 26: 3 clicks in 62 ms = 1 fill, 5 clicks 150 ms apart = 3).
//   BOOST <button onClick> (TradeBridge desktop + PhoneTradeBar) → TradeBridge shoot() → window 'disciple:shoot'
//   → engine's disciple:shoot listener → trade() → submit() → source.submitTrade, with 'disciple:inflight' fed back into the
//   button state exactly as TradeBridge does. Everything here is SLICED FROM THE SHIPPED SOURCE (no COOLDOWN_MS stub, no
//   direct trade() calls): shoot, the listener, trade/submit, and the button's disabled / label expressions.
//   Rule under test: NO PRESS IS SILENTLY DROPPED — each click either sends a trade or visibly says why
//   ('3 IN FLIGHT' pulse on the canvas + the button label reads "3 IN FLIGHT"), for the custom amount AND a preset.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import ts from "typescript";
const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
const rd = (f) => fs.readFileSync(path.join(web, f), "utf8");
const eng = rd("public/flight/engine.js"), tb = rd("components/TradeBridge.tsx"), ph = rd("components/flight/PhoneTradeBar.tsx");
const block = (a, b) => { const i = eng.indexOf(a), j = eng.indexOf(b, i); if (!(i > 0 && j > i)) throw new Error("engine block " + a); return eng.slice(i, j); };
const trBlock = block("/* @trade (sliced", "// Pre-flight failures");
const lsn = eng.match(/addEventListener\('disciple:shoot',[\s\S]*?\}\);/); if (!lsn) throw new Error("engine disciple:shoot listener");
const shootSrc = tb.match(/const shoot = \(side[\s\S]*?\)\)\);/); if (!shootSrc) throw new Error("TradeBridge shoot");
const tsx = (src) => ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

console.log("— 0. the shipped wiring");
const deskBuy = tb.match(/data-testid="buy-btn"[^\n]*/)[0];
ok(/onClick=\{\(\) => shoot\("buy"\)\}/.test(deskBuy), "desktop BOOST onClick = shoot(\"buy\")");
ok(/onBoost=\{\(\) => shoot\("buy"\)\}/.test(tb) && /onClick=\{b \? p\.onBoost : p\.onDump\}/.test(ph), "phone BOOST → onBoost → shoot(\"buy\")");
ok(!/COOLDOWN_MS/.test(eng) && !/now<S\.cooldownUntil/.test(eng), "engine: the 250 ms cooldown (silent return in submit) is gone");
ok(/if \(S\.confirmed\.mcap===null\)\{ S\.flashes\.push\(/.test(eng), "engine: no price yet = a visible flash, not a silent return");
const deskDis = deskBuy.match(/ disabled=\{([^}]*)\}/)[1], phDis = ph.match(/ disabled=\{([^}]*)\}/)[1];
ok(!/full/.test(deskDis) && /aria-disabled=\{short \|\| full\}/.test(deskBuy), `desktop BOOST: disabled={${deskDis}} — never disabled by 'full' (a disabled button swallows the click silently)`);
ok(/boostDisabled=\{short\} dumpDisabled=\{!has\} inFlightFull=\{full\}/.test(tb) && phDis === "dis", "phone BOOST / DUMP: disabled only for cash / no tokens; inFlightFull drives the look");
ok(/\{full \? COPY\.inFlight : <>▲/.test(deskBuy) && /\{full && has \? COPY\.inFlight : <>▼/.test(tb), "desktop BOOST / DUMP label reads COPY.inFlight ('3 IN FLIGHT') while full");
ok(/<span className="ph-lbl">\{full \? "3 IN FLIGHT" : b \? "BOOST" : "DUMP"\}<\/span>/.test(ph) && /data-disabled=\{dis \|\| full \? "1" : "0"\}/.test(ph), "phone label reads '3 IN FLIGHT' while full (and greys)");

// ---- harness: one window EventTarget shared by TradeBridge (shoot, inflight listener) and the engine (listener, trade/submit)
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function rig({ customUsd = 0, mode = 0, presets = [{ usd: 1 }, { usd: 5 }] } = {}) {
  const win = new EventTarget(); let now = 1;
  const E = { sent: [], res: [], clicks: [] };
  const S = { fuelers: { you: 0 }, hold: { tokens: 1e6, valueUsd: 50 }, liveBag: { tokens: 1e6 }, flashes: [], feed: [], mode: 0, balance: 1000, liveCash: 1000,
    gasPerOpUsd: 0, confirmed: { mcap: 7e4 }, pending: [], cooldownUntil: 0, buyBoost: 0, score: 0, simF: 1 };
  const env = { S, MODES: presets, hasTokens: () => true, noTokens() {}, isLive: () => true, markMcap: () => 7e4, MIN_SHOT: 0.2, fmtShot: (x) => "$" + (+x).toFixed(2),
    fmtMoney: (x) => "$" + (+x).toFixed(2), window: { __discipleTrade() {} }, applyThrust() {},
    source: { supply: 7e9, impact: () => 1.02, submitTrade: (side, usd, o) => { E.sent.push({ side, usd, o, at: now }); return new Promise((r) => E.res.push(r)); } },
    srcImpact: () => 1.02, fillMcapEst: () => 7e4, MAX_PENDING: 3, COOLDOWN_MS: 250 /* main d3c33ab5 value; unused once the cooldown is gone */, performance: { now: () => now }, mcapToAlt: (m) => Math.log10(m),
    shownMcap: () => S.confirmed.mcap, clamp, pushPaperCash() {}, pushAmmo() {}, dispatchEvent: (e) => win.dispatchEvent(e), CustomEvent, SESSION: null,
    isOnchainRevert: () => true, setTimeout: () => 0, addEventListener: (t, f) => win.addEventListener(t, f) };
  new Function(...Object.keys(env), trBlock + "\n" + lsn[0])(...Object.values(env));      // the engine's own listener, registered on win
  // TradeBridge side: inflight state (as its useEffect listener), shoot() as shipped, button disabled / label as shipped
  let inFlight = { n: 0, max: 3 }; win.addEventListener("disciple:inflight", (e) => { inFlight = e.detail; });
  let marks = 0; const tradeClick = () => { marks++; };
  const shoot = new Function("window", "CustomEvent", "tradeClick", "mode", "customUsd", tsx(shootSrc[0]) + "\nreturn shoot;")({ dispatchEvent: (e) => win.dispatchEvent(e) }, CustomEvent, tradeClick, mode, customUsd);
  const btn = () => { const full = inFlight.n >= inFlight.max, short = false;
    return { disabled: new Function("short", "full", "return " + deskDis)(short, full), label: full ? "3 IN FLIGHT" : "▲ BOOST" }; };
  E.click = (t) => { for (const f of S.flashes) f.life -= (t - now) / 1000; now = t;   // flashes fade like the render loop's
    const b = btn(), s0 = E.sent.length, f0 = S.flashes.length, life0 = S.flashes.map((f) => f.life);
    if (!b.disabled) shoot("buy");   // a disabled <button> never fires onClick
    const shown = S.flashes.length > f0 ? S.flashes.at(-1) : S.flashes.find((f, i) => f.life > life0[i]);   // new flash, or a re-armed one (inFlightPulse dedupe)
    const out = E.sent.length > s0 ? "sent" : shown ? "flash:" + shown.txt : "SILENT";
    E.clicks.push({ t, out, label: btn().label }); return out; };
  E.settle = async (i, r) => { E.res[i]?.(r); await new Promise((x) => setImmediate(x)); };
  E.S = S; E.marks = () => marks; E.label = () => btn().label;
  return E; }

for (const [kind, opts, want] of [["custom $1", { customUsd: 1 }, 1], ["preset $5", { mode: 1 }, 5]]) {
  console.log(`— ${kind}`);
  { const E = rig(opts); [0, 31, 62].forEach((t) => E.click(t));       // replay: 3 clicks within 62 ms
    ok(E.sent.length === 3 && E.sent.every((s) => s.side === "buy" && Math.abs(s.usd - want) < 1e-9), `${kind}: 3 clicks in 62 ms = 3 trades of $${want} (was 1)`);
    ok(E.S.pending.length === 3 && E.label() === "3 IN FLIGHT", `${kind}: 3 stacked ghosts pending, button label '3 IN FLIGHT'`);
    ok(E.marks() === 3, `${kind}: every click marked tradeClick (tradeSpeed)`); }
  { const E = rig(opts); [0, 150, 300, 450, 600].forEach((t) => E.click(t));   // replay: 5 clicks 150 ms apart
    ok(E.clicks.every((c) => c.out !== "SILENT"), `${kind}: 5 clicks 150 ms apart — none silently dropped (${E.clicks.map((c) => c.out).join(", ")})`);
    ok(E.sent.length === 3 && E.clicks.slice(3).every((c) => c.out === "flash:3 IN FLIGHT" && c.label === "3 IN FLIGHT"), `${kind}: clicks 4–5 = '3 IN FLIGHT' pulse + label, no trade`);
    await E.settle(0, { ok: true, txHash: "0x1", filled: true });
    ok(E.label() !== "3 IN FLIGHT" && E.click(900) === "sent" && E.sent.length === 4, `${kind}: a fill frees a slot → label back, next click goes out`); }
  { const E = rig(opts); E.click(0); E.click(200);                       // replay: 2 taps 200 ms apart
    ok(E.sent.length === 2 && E.S.pending.length === 2, `${kind}: 2 taps 200 ms apart = 2 trades, 2 stacked ghosts (was 1, none)`); }
  { const E = rig(opts); E.click(0);
    ok(E.sent.length === 1 && E.S.pending.length === 1 && E.label() !== "3 IN FLIGHT", `${kind}: single tap unchanged (1 trade, label stays BOOST)`); }
}
{ const E = rig({ customUsd: 1 }); E.S.confirmed.mcap = null;
  ok(E.click(0) !== "SILENT" && E.sent.length === 0, "no price yet: the click shows a flash instead of vanishing"); }
console.log(bad ? `\n${bad} FAILED` : "\nall ok"); process.exit(bad ? 1 : 0);
