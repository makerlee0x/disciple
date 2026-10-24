// GAME trade speed (maker lee 2026-10-24: "3 seconds is unacceptable. we will only accept ms"; no optimistic / fake fills).
//   1. fill decoded from the logs the send RETURNED (lib/wallet.execCalls → lib/flight/tradeSpeed) at "✓ done"; the 2nd
//      waitForTransactionReceipt 700 ms poll is gone (kept only as a fallback when no logs came back)
//   2. the rocket reacts only on the REAL fill: no turbo flare / thrust at the click, thrust + flare on r.ok, none on failure
//   3. warm tick quotes the ACTIVE amount (custom $ incl.), re-warmed right after our own trade
//   4. SPACE in the custom $ field = BOOST the custom amount
//   5. click → confirm → fill ms in 'disciple:op' {phase:"filled"}
//   6. "✓ done" shows the FILLED $ (BOOST and DUMP), not the pre-trade estimate
//   Run: node scripts/test-trade-speed.mjs
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { loadLib } from "./lib/load-ts.mjs";
const dir = path.dirname(fileURLToPath(import.meta.url)), web = path.join(dir, "..");
let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const rd = (f) => fs.readFileSync(path.join(web, f), "utf8");
const eng = rd("public/flight/engine.js"), tb = rd("components/TradeBridge.tsx"), wl = rd("lib/wallet.ts");
const block = (a, b) => { const i = eng.indexOf(a), j = eng.indexOf(b); if (!(i > 0 && j > i)) throw new Error("engine block " + a); return eng.slice(i, j); };
const { mods, cleanup } = await loadLib(["config", "pnl", "flight/fills", "flight/tradeSpeed", "flight/ownLedger", "flight/holders", "abi/DiscipleRouter"], "tradespeed-");
const TS = mods["flight/tradeSpeed"], fills = mods["flight/fills"], { fmtMoney } = mods.pnl, { discipleRouterAbi } = mods["abi/DiscipleRouter"];

// ───────────── 1 + 6. fill from the returned logs, status shows the fill $ ─────────────
console.log("— 1/6. fill from the returned logs; ✓ done = the filled $");
const TOKEN = "0x" + "11".repeat(20), ME = "0x" + "22".repeat(20), ROUTER = "0x" + "33".repeat(20);
const e18 = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const ev = (abi, name, args, address) => { const e = abi.find((x) => x.type === "event" && x.name === name);
  return { address, topics: encodeEventTopics({ abi: [e], eventName: name, args }), data: encodeAbiParameters(e.inputs.filter((i) => !i.indexed), e.inputs.filter((i) => !i.indexed).map((i) => args[i.name])) }; };
const TX1 = "0xAB" + "0".repeat(62), TX2 = "0xcd" + "0".repeat(62);
const sellLogs = [ev(discipleRouterAbi, "UsdgTrade", { trader: ME, token: TOKEN, isBuy: false, amountIn: e18(2.1e6), amountOut: e18(245), viaCurve: true }, ROUTER)];
const buyLogs = [ev(discipleRouterAbi, "UsdgTrade", { trader: ME, token: TOKEN, isBuy: true, amountIn: e18(1.95), amountOut: e18(16800), viaCurve: true }, ROUTER)];
TS.noteReceipt(TX1, sellLogs); TS.noteReceipt(TX2, buyLogs);
const got = TS.takeReceipt(TX1.toLowerCase());
ok(Array.isArray(got) && got.length === 1 && TS.takeReceipt(TX1) === undefined, "returned logs handed over by tx hash (case-insensitive), once");
ok(TS.takeReceipt("0x" + "ee".repeat(32)) === undefined && TS.takeReceipt(undefined) === undefined, "no logs came back ⇒ undefined (caller falls back to polling)");
for (let i = 0; i < 40; i++) TS.noteReceipt("0x" + i.toString(16).padStart(64, "0"), []);
ok(TS.takeReceipt(TX2) === undefined && TS.takeReceipt("0x" + (39).toString(16).padStart(64, "0")) !== undefined, "bounded (last 32 kept)");
const o = { token: TOKEN, trader: ME, router: ROUTER, usdgDecimals: 18 };
const sellFill = fills.decodeTradeFill(got, o), buyFill = fills.decodeTradeFill(buyLogs, o);
ok(sellFill && sellFill.side === "sell" && near(sellFill.usd, 245, 1e-6), "sell fill decoded from the returned logs: $245 received");
const sl = TS.doneLine("sell", 208.25, { ok: true }, sellFill, fmtMoney);
ok(sl === "▼ $245.00 ✓ done" && !/208/.test(sl), `DUMP status shows the FILLED $ (${sl}), not the $208.25 estimate`);
const bl = TS.doneLine("buy", 1.98, { ok: true }, buyFill, fmtMoney);
ok(bl === "▲ $1.95 ✓ done", `BOOST status shows the FILLED $ (${bl}), not the $1.98 estimate`);
ok(TS.doneLine("buy", 1.98, { ok: true }, null, fmtMoney) === "▲ $1.98 ✓ done", "no fill decoded yet (slow path) ⇒ shot $ until the polled receipt replaces it");
ok(TS.doneLine("buy", 5, { ok: true }, { side: "sell", usd: 9 }, fmtMoney) === "▲ $5.00 ✓ done", "a fill for the other side is never shown");
ok(TS.doneLine("sell", 5, { ok: false, reason: "Price moved" }, sellFill, fmtMoney) === "▼ $5.00 ✕ Price moved", "failure keeps its reason (no fill $)");
// wiring
ok(/handOffLogs\(r\.txHash, r\.receipt\?\.receipt\?\.logs\)/.test(wl) && /handOffLogs\(hash, last\.logs\)/.test(wl), "lib/wallet.execCalls hands the returned logs over (smart account + EOA paths)");
ok(/takeReceipt\(r\.txHash\)/.test(tb) && /await bookReceipt\(r\.txHash, side, bag, logs\)/.test(tb), "TradeBridge decodes the fill from the returned logs BEFORE the result returns (fillreceipt at ✓ done)");
ok(!/pollingInterval: 700/.test(tb), "TradeBridge: the 700 ms waitForTransactionReceipt poll is gone");
ok(/if \(!rl\) \{[^}]*waitForTransactionReceipt/.test(tb) && /&& !logs\) void bookReceipt\(r\.txHash, side, bag\)/.test(tb), "receipt polling kept only as the fallback when no logs came back");
ok(/setLast\(doneLine\(side, usd, r, fill, fmtMoney\)\)/.test(tb) && /if \(x\) setLast\(doneLine\(side, usd, r, x, fmtMoney\)\)/.test(tb), "TradeBridge ✓ done line = doneLine (fill $), also once a polled receipt lands");
ok(/fillUsd: fill\.usd/.test(tb), "bridge result carries the fill $ (fillUsd) to the engine");

// ───────────── 2. rocket only on the real fill ─────────────
console.log("— 2. rocket reacts only on the confirmed fill");
const trBlock = block("/* @trade (sliced", "// Pre-flight failures");
ok(!/S\.buyBoost=1/.test(block("function trade(side,opt){", "/* @trade-end */")) && !/applyThrust\(/.test(block("function trade(side,opt){", "/* @trade-end */")), "engine trade(): no turbo flare / thrust at the click");
function engine({ live = true, result, sell = false }) {
  const E = { thrust: [], events: [] };
  const S = { fuelers: { you: 0 }, hold: { tokens: 1e6, valueUsd: 50 }, liveBag: live ? { tokens: 1e6 } : null, flashes: [], feed: [], mode: 0, balance: 1e3, liveCash: 1e3,
    confirmed: { mcap: 7e4 }, pending: [], cooldownUntil: 0, buyBoost: 0 };
  let resolve; const pend = new Promise((r) => { resolve = r; });
  class CE { constructor(t, o) { this.type = t; this.detail = o && o.detail; } }
  const env = { S, MODES: [{ usd: 10 }], hasTokens: () => true, noTokens() {}, isLive: () => live, markMcap: () => 7e4, MIN_SHOT: 0.2, fmtShot: String,
    window: live ? { __discipleTrade() {} } : {}, applyThrust: (side, usd, pct) => E.thrust.push({ side, usd, pct, boost: S.buyBoost }),
    source: { supply: 7e9, impact: () => 1.02, submitTrade: () => pend }, srcImpact: () => 1.02, fillMcapEst: () => 7e4, MAX_PENDING: 4, COOLDOWN_MS: 0,
    performance: { now: () => 1 }, mcapToAlt: (m) => Math.log10(m), shownMcap: () => S.confirmed.mcap, clamp: (x, a, b) => Math.max(a, Math.min(b, x)), pushPaperCash() {}, dispatchEvent: (e) => E.events.push(e), CustomEvent: CE, SESSION: null, isOnchainRevert: () => true, setTimeout: () => 0 };
  E.trade = new Function(...Object.keys(env), trBlock + "\nreturn trade;")(...Object.values(env));
  E.S = S; E.fill = async (r) => { resolve(r); await pend; await new Promise((x) => setImmediate(x)); };
  return E; }
{ const E = engine({});
  E.trade("buy");
  ok(E.S.buyBoost === 0 && E.thrust.length === 0 && E.S.pending.length === 1 && E.S.pending[0].state === "pending", "click: pending ghost only (no flare, no thrust)");
  await E.fill({ ok: true, txHash: "0x1", fillUsd: 9.7 });
  ok(E.S.buyBoost === 1 && E.thrust.length === 1 && E.thrust[0].side === "buy" && near(E.thrust[0].usd, 9.7) && near(E.thrust[0].pct, 2), "confirmed buy: turbo flare + thrust, sized from the real fill ($9.70) at the click's impact");
  ok(E.events.some((e) => e.type === "disciple:paperfill" && e.detail.live && e.detail.txHash === "0x1"), "the confirmed fill still books the PnL ledger (paperfill → receipt reconcile)"); }
{ const E = engine({}); E.trade("buy"); await E.fill({ ok: false, reason: "Price moved" });
  ok(E.S.buyBoost === 0 && E.thrust.length === 0 && E.S.pending[0].state === "failed", "failed buy: no flare, no thrust"); }
{ const E = engine({}); E.trade("sell", { usd: 5, frac: 0.25 });
  ok(E.thrust.length === 0, "sell click: the rocket doesn't move before the fill");
  await E.fill({ ok: true, txHash: "0x2" });
  ok(E.thrust.length === 1 && E.thrust[0].side === "sell" && E.S.buyBoost === 0 && near(E.thrust[0].usd, 2.5), "confirmed sell: thrust (shot $ = 25% of the real bag when no fill $ came back), no buy flare"); }
{ const E = engine({}); E.trade("sell", { usd: 5, frac: 0.25 }); await E.fill({ ok: false });
  ok(E.thrust.length === 0, "failed sell: no thrust"); }
{ const E = engine({ live: false }); E.trade("buy"); ok(E.thrust.length === 0, "paper: same rule (rocket moves on its fill)");
  await E.fill({ ok: true, exact: true, usd: 10, net: 0 }); ok(E.thrust.length === 1 && E.S.buyBoost === 1, "paper fill: flare + thrust then"); }

// ───────────── 3. warm the active amount ─────────────
console.log("— 3. warm quote for the active amount");
ok(/const usd = customRef\.current \|\| \(ammo\.usd\[mode\] \?\? MODES\[mode\]\.usd\);/.test(tb), "warm tick quotes the custom $ when filled, else the selected preset");
ok(/warmRef\.current = tick;/.test(tb) && /setTimeout\(\(\) => void warmRef\.current\(\), 0\);/.test(tb), "re-warmed right after our own trade completes");
ok(/if \(!customUsd\) return; const id = setTimeout\(\(\) => void warmRef\.current\(\), 150\)/.test(tb), "a newly typed custom $ is warmed right away (debounced)");

// ───────────── 4. SPACE in the custom $ field ─────────────
console.log("— 4. SPACE in the custom $ field");
{ const m = tb.match(/aria-label="custom amount"[\s\S]*?onKeyDown=\{(\(e\) => \{[\s\S]*?e\.stopPropagation\(\); \})\}/);
  ok(!!m, "custom $ field has its keydown handler");
  const shots = []; let customUsd = 25;
  const mk = () => new Function("shoot", "customUsd", "return " + m[1] + ";")((s) => shots.push(s), customUsd);
  const key = (k, repeat = false) => { const e = { key: k, repeat, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }; mk()(e); return e; };
  let e = key(" "); ok(shots.length === 1 && shots[0] === "buy" && e.prevented && e.stopped, "SPACE with a custom $ = BOOST that amount (no space typed, not re-handled by the engine)");
  e = key(" ", true); ok(shots.length === 1 && e.prevented, "held SPACE (repeat) does not re-fire");
  customUsd = 0; e = key(" "); ok(shots.length === 1 && e.prevented && e.stopped, "SPACE with no custom $: nothing fires");
  customUsd = 25; e = key("Enter"); ok(shots.length === 2, "Enter still BOOSTs the custom $");
  e = key("5"); ok(shots.length === 2 && !e.prevented && e.stopped, "digits type normally (and never reach the game hotkeys)"); }

// ───────────── 5. timing ─────────────
console.log("— 5. click → confirm → fill ms");
{ const M = new TS.OpMarks();
  M.note({ phase: "submitted", userOpHash: "0xOP", txHash: "0xTX", at: 1100 });
  M.note({ phase: "confirmed", userOpHash: "0xOP", txHash: "0xTX", at: 1450, timings: { rpc: 300 } });
  M.note({ phase: "filled", txHash: "0xTX", at: 2000 });
  const op = M.byTx("0xtx");
  ok(op && op.submittedAt === 1100 && op.confirmedAt === 1450 && op.timings.rpc === 300, "op marks collected by op hash, found by tx hash (own 'filled' events ignored)");
  const ms = TS.tradeMs(1000, { quoteAt: 1004, op, resultAt: 1460, fillAt: 1462 });
  ok(ms.quote === 4 && ms.submit === 100 && ms.confirm === 450 && ms.fill === 462 && ms.total === 462, "ms from the click: quote / submit / confirm / fill / total");
  const slow = new TS.OpMarks(); slow.note({ phase: "submitted", userOpHash: "0xOP2", at: 1200 }); slow.note({ phase: "confirmed", userOpHash: "0xOP2", txHash: "0xT2", at: 3000 });
  ok(slow.byTx("0xT2").submittedAt === 1200, "slow path (submitted carries only the userOpHash) still joins by op");
  ok(TS.tradeMs(0, { resultAt: 900 }).confirm === 900 && TS.tradeMs(0, { resultAt: 900 }).fill === undefined, "no op marks / no fill: confirm = result time, fill undefined"); }
ok(/new CustomEvent\("disciple:op", \{ detail: \{ phase: "filled"/.test(tb) && /logs: logs \? "returned" : "polled", ms/.test(tb), "TradeBridge emits disciple:op {phase:'filled', ms, logs:'returned'|'polled'} (no UI)");
ok(/if \(d\?\.phase === "submitted"\)/.test(tb) && /if \(d\?\.phase === "confirmed"\)/.test(tb), "existing disciple:op consumers only act on submitted / confirmed (filled is instrumentation only)");

// ───────────── SITE conditions on the lib/wallet.ts hand-off: no-throw, sync, logs as returned (no RPC) ─────────────
console.log("— wallet.ts noteReceipt hand-off: no-throw, synchronous, no extra RPC");
{ const hb = wl.slice(wl.indexOf("function handOffLogs("), wl.indexOf("export async function execCalls("));
  ok(/try \{ noteReceipt\(txHash, logs\); \} catch/.test(hb) && !/await|async|Promise|import\(|createPublicClient|getTransactionReceipt|waitForTransactionReceipt/.test(hb), "handOffLogs: try/catch, no await/async, no RPC");
  const nr = rd("lib/flight/tradeSpeed.ts"); const nb = nr.slice(nr.indexOf("export function noteReceipt("), nr.indexOf("export function takeReceipt("));
  ok(/try \{/.test(nb) && !/await|async|Promise|fetch|viem/.test(nb), "noteReceipt itself: synchronous, no-throw, no I/O");
  for (const bad2 of [undefined, null, 42, { length: 1 }]) { let threw = false; try { TS.noteReceipt(bad2, bad2); TS.noteReceipt("0x1", bad2); } catch { threw = true; } ok(!threw, "noteReceipt(" + JSON.stringify(bad2 ?? String(bad2)) + ") never throws"); }
  { const hostile = new Proxy([], { get(t, k) { if (k === "slice") throw new Error("boom"); return Reflect.get(t, k); } }); let threw = false;
    try { TS.noteReceipt("0x2", hostile); } catch { threw = true; } ok(!threw, "noteReceipt with logs that throw on copy never throws"); }

  // run the REAL lib/wallet.ts execCalls with stub deps and a noteReceipt that THROWS
  const os = await import("node:os"), ts = (await import("typescript")).default, { pathToFileURL } = await import("node:url");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-handoff-"));
  const src = wl.replace(/from "viem"/g, 'from "./stub-viem.mjs"').replace(/import\("viem"\)/g, 'import("./stub-viem.mjs")').replace(/from "\.\/chains"/, 'from "./stub-chains.mjs"').replace(/from "\.\/aa\/relayOp"/, 'from "./stub-relayOp.mjs"')
    .replace(/from "\.\/flight\/tradeSpeed"/, 'from "./stub-tradeSpeed.mjs"').replace(/from "\.\/aa\/session"/, 'from "./stub-session.mjs"');
  fs.writeFileSync(path.join(tmp, "wallet.mjs"), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText);
  const RC_LOGS = [{ address: ROUTER, topics: ["0x01"], data: "0x" }];
  fs.writeFileSync(path.join(tmp, "stub-viem.mjs"), `export const custom = (e) => e;
    export const http = () => ({});
    export const createWalletClient = () => ({ requestAddresses: async () => ["${ME}"], getChainId: async () => 1, sendTransaction: async () => "0x" + "ee".repeat(32) });
    export const createPublicClient = () => ({ waitForTransactionReceipt: async () => { globalThis.__rpc = (globalThis.__rpc || 0) + 1; return { status: "success", logs: ${JSON.stringify(RC_LOGS)} }; } });`);
  fs.writeFileSync(path.join(tmp, "stub-chains.mjs"), `export const ACTIVE_CHAIN = { id: 1 };`);
  fs.writeFileSync(path.join(tmp, "stub-relayOp.mjs"), `export const REJECTED_MSG = "rejected";`);
  fs.writeFileSync(path.join(tmp, "stub-tradeSpeed.mjs"), `export function noteReceipt(h, l) { globalThis.__calls = (globalThis.__calls || []); globalThis.__calls.push([h, l]); if (globalThis.__throw) throw new Error("noteReceipt exploded"); }`);
  fs.writeFileSync(path.join(tmp, "stub-session.mjs"), `export const aaSession = () => globalThis.__sa;
    export const aaSend = async () => globalThis.__send;
    export const aaAddress = async () => null; export const aaAvailable = () => true; export const aaLogout = async () => {}; export const eoaLogin = async () => null;
    export const localImport = async () => null; export const localReset = async () => {}; export const localStart = async () => null; export const privyLogin = () => {}; export const restore = async () => null; export const setPrivyOwner = async () => null;`);
  const W = await import(pathToFileURL(path.join(tmp, "wallet.mjs")).href);
  const SA_LOGS = [{ address: ROUTER, topics: ["0x02"], data: "0x" }];
  globalThis.__throw = true; globalThis.__sa = { a: 1 }; globalThis.__rpc = 0;
  globalThis.__send = { txHash: TX1, userOpHash: "0xop", gasMode: "sponsored", receipt: { receipt: { logs: SA_LOGS } } };
  let r = null, err = null; try { r = await W.execCalls([{ to: ROUTER, data: "0x" }]); } catch (e) { err = e; }
  ok(!err && r && r.txHash === TX1 && r.logs === SA_LOGS && r.userOp === "0xop" && r.gasMode === "sponsored", "smart account: noteReceipt THROWS ⇒ execCalls still returns the normal trade result" + (err ? " (" + err.message + ")" : ""));
  ok(globalThis.__calls.length === 1 && globalThis.__calls[0][0] === TX1 && globalThis.__calls[0][1] === SA_LOGS && globalThis.__rpc === 0, "smart account: the returned logs are passed as-is (same array), zero extra RPC reads");
  globalThis.__send = { txHash: TX2, userOpHash: "0xop2", receipt: { receipt: {} } }; err = null; r = null;
  try { r = await W.execCalls([{ to: ROUTER, data: "0x" }]); } catch (e) { err = e; }
  ok(!err && r && r.txHash === TX2 && r.logs === undefined, "smart account: a response with no receipt logs still returns (hand-off skipped, TradeBridge falls back to polling)");
  globalThis.__sa = null; globalThis.__calls = []; globalThis.__rpc = 0; W.setWalletProvider({}); await W.connectWallet(); err = null; r = null;
  try { r = await W.execCalls([{ to: ROUTER, data: "0x" }, { to: ROUTER, data: "0x" }]); } catch (e) { err = e; }
  ok(!err && r && r.txHash === "0x" + "ee".repeat(32) && JSON.stringify(r.logs) === JSON.stringify(RC_LOGS), "EOA: noteReceipt THROWS ⇒ execCalls still returns the normal trade result" + (err ? " (" + err.message + ")" : ""));
  ok(globalThis.__calls.length === 2 && globalThis.__rpc === 2 && globalThis.__calls[1][1] === r.logs, "EOA: logs handed over as-is from the receipt the path already waits for (no extra RPC: 1 receipt read per call, as before)");
  // the hand-off adds no await: execCalls resolves in the same number of microtask turns with a throwing vs a clean noteReceipt
  const ticks = async (thr) => { globalThis.__throw = thr; globalThis.__sa = { a: 1 }; globalThis.__send = { txHash: TX1, receipt: { receipt: { logs: SA_LOGS } } };
    let done = false, n = 0; W.execCalls([]).then(() => { done = true; }); while (!done && n < 100) { await null; n++; } return n; };
  const tClean = await ticks(false), tThrow = await ticks(true);
  ok(tClean === tThrow && tClean < 100, "a throwing noteReceipt doesn't delay the return (" + tThrow + " vs " + tClean + " microtask turns)");
  delete globalThis.__throw; delete globalThis.__sa; delete globalThis.__send; delete globalThis.__calls; delete globalThis.__rpc;
  fs.rmSync(tmp, { recursive: true, force: true }); }

// ───────────── click mark hook for SITE #140 (lib/trade/timing.ts markTradeClick), not imported until #140 lands ─────────────
console.log("— #140 click-mark hook point (guarded, no-throw)");
{ let n = 0; TS.setTradeClickMark(null);
  let threw = false; try { TS.tradeClick(); TS.tradeStart(); } catch { threw = true; } ok(!threw, "no hook registered (today) ⇒ tradeClick/tradeStart are silent no-ops");
  TS.setTradeClickMark(() => { n++; });
  TS.tradeClick(); TS.tradeStart(); ok(n === 1, "trade-bar click marks once; the bridge entry doesn't re-mark (keeps the earlier click time)");
  TS.tradeStart(); ok(n === 2, "engine hotkey (no trade-bar click) ⇒ marked at the bridge entry");
  TS.setTradeClickMark(() => { throw new Error("timing exploded"); }); threw = false;
  try { TS.tradeClick(); TS.tradeStart(); TS.tradeStart(); } catch { threw = true; } ok(!threw, "a throwing markTradeClick never breaks the click or the trade");
  TS.setTradeClickMark("nope"); threw = false; try { TS.tradeClick(); } catch { threw = true; } ok(!threw, "a non-function hook is ignored");
  TS.setTradeClickMark(null);
  ok(![tb, rd("lib/flight/tradeSpeed.ts")].some((f) => /^\s*import[^\n]*lib\/trade\/timing|import\(\s*["'][^"']*trade\/timing/m.test(f)), "lib/trade/timing (SITE #140) is NOT imported (not on the base yet): TODO only");
  ok(/TODO\(#140\)[^\n]*\n\/\/\s+import \{ markTradeClick \} from "@\/lib\/trade\/timing";\s+setTradeClickMark\(markTradeClick\)/.test(tb), "TradeBridge carries the one-line #140 wiring TODO");
  ok(/const shoot = [^\n]*\n\s+\(tradeClick\(\), window\.dispatchEvent\(new CustomEvent\("disciple:shoot"/.test(tb), "every trade-bar click / key (shoot: BOOST, DUMP, custom $ Enter / SPACE) calls tradeClick()");
  ok(/window\.__discipleTrade = async[^\n]*\n[^\n]*\n\s+tradeStart\(\);/.test(tb), "the bridge entry calls tradeStart() (engine SPACE / Shift hotkeys)");
  const wi = tb.indexOf("setTimeout(() => void warmRef.current(), 0)"); const pre = tb.slice(Math.max(0, wi - 400), wi);
  ok(wi > 0 && /TODO\(#140\): REMOVE this immediate post-trade re-warm/.test(pre) && /KEEP the 150 ms custom-\$ debounce/.test(pre), "TODO(#140) marks the immediate post-trade re-warm for removal (still present today)");
  ok(/setTimeout\(\(\) => void warmRef\.current\(\), 150\)/.test(tb), "the 150 ms custom-$ debounce re-warm stays"); }

// ───────────── balances / position / cash from the SYNC RECEIPT at confirm; public RPC only reconciles (block-checked) ─────────────
console.log("— own balances from the receipt logs at confirm; stale reads never roll back");
{ const OL = mods["flight/ownLedger"], USDG = "0x" + "44".repeat(20), POOL = "0x" + "55".repeat(20);
  const pad = (a) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase(), word = (v) => "0x" + v.toString(16).padStart(64, "0");
  const xfer = (tok, from, to, v) => ({ address: tok, topics: [OL.TRANSFER_TOPIC, pad(from), pad(to)], data: word(v) });
  const E = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
  // a BOOST: $1.95 USDG out of the account (to the router), 16 800 tokens in (from the pool), plus noise
  const buy = [xfer(USDG, ME, ROUTER, E(1.95)), xfer(TOKEN, POOL, ME, E(16800)), xfer(TOKEN, POOL, ROUTER, E(5)), { address: TOKEN, topics: ["0x01"], data: "0x" }];
  const d = OL.transferDeltas(buy, ME, [TOKEN, USDG]);
  ok(d.get(TOKEN.toLowerCase()) === E(16800) && d.get(USDG.toLowerCase()) === -E(1.95), "Transfer deltas for the account: +tokens, −USDG (other parties' transfers / non-Transfer logs ignored)");
  const L = new OL.OwnLedger(), now0 = 1_000_000;
  L.offerRead(TOKEN, ME, E(1000), 100n, now0 - 5000); L.offerRead(USDG, ME, E(50), 100n, now0 - 5000);
  const ch = L.applyFill(ME, [TOKEN, USDG], buy, TX2, () => undefined, now0);
  ok(ch.length === 2 && L.get(TOKEN, ME) === E(17800) && L.get(USDG, ME) === E(48.05), "at confirm: token balance 1 000 → 17 800 and cash $50 → $48.05 straight from the logs (no RPC)");
  ok(L.pending(TOKEN, ME) && L.tooSoon(TOKEN, ME, now0 + 999) && !L.tooSoon(TOKEN, ME, now0 + 1000), "fill pending; no reconcile read before 1 s");
  ok(!L.offerRead(TOKEN, ME, E(1000), 105n, now0 + 300) && L.get(TOKEN, ME) === E(17800), "stale PRE-fill read (RPC ~0.7 s behind, fill block unknown yet) does NOT overwrite the fill");
  ok(!L.offerRead(TOKEN, ME, E(1000), undefined, now0 + 300) && L.get(TOKEN, ME) === E(17800), "unpinned read (no block) while a fill is pending is rejected");
  L.noteTxBlock(TX2, 110n);
  ok(!L.offerRead(TOKEN, ME, E(1000), 109n, now0 + 1500) && L.get(TOKEN, ME) === E(17800), "read at block 109 < fill block 110 is rejected (no roll-back)");
  ok(L.offerRead(TOKEN, ME, E(17800) + 7n, 110n, now0 + 1600) && L.get(TOKEN, ME) === E(17800) + 7n && !L.pending(TOKEN, ME), "read at block ≥ the fill block reconciles (overwrites) and clears the pending fill");
  ok(!L.offerRead(TOKEN, ME, E(1), 108n, now0 + 2000) && L.get(TOKEN, ME) === E(17800) + 7n, "an out-of-order older read never overwrites a newer one");
  // a DUMP from the receipt: −tokens, +USDG, applied on top of the ledger
  const sell = [xfer(TOKEN, ME, POOL, E(800)), xfer(USDG, ROUTER, ME, E(245))];
  L.applyFill(ME, [TOKEN, USDG], sell, TX1, () => undefined, now0 + 3000);
  ok(L.get(TOKEN, ME) === E(17000) + 7n && L.get(USDG, ME) === E(293.05), "DUMP at confirm: tokens down, cash up by the real $245 received");
  const L2 = new OL.OwnLedger();
  ok(L2.applyFill(ME, [TOKEN], sell, TX1, () => undefined, 0).length === 0 && L2.get(TOKEN, ME) === undefined, "unknown base for a debit ⇒ untouched (left to the reconcile read), never a made-up value");
  ok(L2.applyFill(ME, [TOKEN], buy, TX2, (t) => (t === TOKEN ? E(10) : undefined), 0)[0].value === E(16810), "no ledger entry yet ⇒ the cached balance is the base");
  // ownRead: the read path the HUD / cash / sell sizing use
  { const Lr = new OL.OwnLedger(); let t = 0, calls = [];
    const pc = { head: 105n, rc: null, bal: E(1000),
      getBlockNumber: async (a) => { calls.push("block:" + (a && a.cacheTime)); return pc.head; },
      getTransactionReceipt: async () => { calls.push("rc"); if (!pc.rc) throw new Error("not found"); return pc.rc; },
      readContract: async (a) => { calls.push("bal@" + a.blockNumber); return pc.bal; } };
    const plain = async () => { calls.push("plain"); return E(1000); };
    ok(await OL.ownRead(Lr, pc, TOKEN, ME, plain, () => t) === E(1000) && calls.join() === "plain", "no fill pending ⇒ the normal (cached / hinted) read");
    Lr.applyFill(ME, [TOKEN], buy, TX2, () => undefined, 0); calls = [];
    t = 500; ok(await OL.ownRead(Lr, pc, TOKEN, ME, plain, () => t) === E(17800) && calls.length === 0, "< 1 s after the fill ⇒ the fill-derived balance, ZERO RPC");
    t = 1200; ok(await OL.ownRead(Lr, pc, TOKEN, ME, plain, () => t) === E(17800) && calls.join() === "rc", "≥ 1 s, RPC hasn't seen the fill tx yet ⇒ keep the fill value (no balanceOf)");
    pc.rc = { blockNumber: 110n }; pc.head = 109n; calls = [];
    t = 1800; ok(await OL.ownRead(Lr, pc, TOKEN, ME, plain, () => t) === E(17800) && calls.join() === "rc,block:0,bal@109", "load-balanced RPC: head 109 < fill block 110 ⇒ pinned read rejected, HUD keeps the fill");
    pc.head = 111n; pc.bal = E(17800) + 3n; calls = [];
    t = 2400; ok(await OL.ownRead(Lr, pc, TOKEN, ME, plain, () => t) === E(17800) + 3n && calls.join() === "block:0,bal@111" && !Lr.pending(TOKEN, ME), "head ≥ fill block ⇒ the pinned read reconciles (fill block looked up once, getBlockNumber uncached)");
    pc.getBlockNumber = async () => { throw new Error("rpc down"); }; Lr.applyFill(ME, [TOKEN], sell, TX1, () => undefined, 3000); Lr.noteTxBlock(TX1, 120n);
    t = 4500; let thr = false; let v; try { v = await OL.ownRead(Lr, pc, TOKEN, ME, plain, () => t); } catch { thr = true; }
    ok(!thr && v === E(17000) + 3n, "RPC error during reconcile ⇒ keeps the fill value, never throws"); }
  // wiring
  const ai = tb.indexOf("if (r.ok && r.txHash && logs) await applyOwn(r.txHash, logs)"), bi = tb.indexOf("await bookReceipt(r.txHash, side, bag, logs)");
  ok(ai > 0 && bi > ai, "TradeBridge: the ledger is updated from the logs BEFORE fillreceipt (HUD / PnL / engine see the same fill)");
  ok(/await applyOwn\(hash, rl, rc\.blockNumber\)/.test(tb), "slow path: balances from the polled receipt (its block noted)");
  ok(!/setTimeout\(res, 1200\)\)\.then\(async \(\) => tokenBalance/.test(tb) && !/bumpBalance\(token as Address, await activeAddress\(\), r\.amountOut\)/.test(tb), "no post-trade balanceOf (1.2 s sell re-read) and no amountOut bump (both replaced by the logs)");
  ok(/addEventListener\("disciple:ownbalance", soon\)/.test(tb) && /const soon = \(\) => \{ void fromLedger\(\); later\(1100\); \}/.test(tb), "HUD position: pushed from the ledger at confirm, reconciled ≥ 1 s later");
  ok(/addEventListener\("disciple:ownbalance", own\)/.test(tb) && /const own = \(\) => \{ void fromLedger\(\); at\(1100\); \}/.test(tb), "cash: pushed from the ledger at confirm, reconciled ≥ 1 s later");
  ok((tb.match(/ownBalance\(pc, /g) || []).length >= 3 && /ownHint\(pc, token as Address, me, 4000\)/.test(tb), "sell sizing, holdings and cash reads all go through the ledger (warm tick too)"); }

// engine: the own BUY's feed row / marker come from the decoded receipt at confirm (feed swap later only moves the price)
console.log("— engine: own BUY drawn from the receipt at confirm");
{ const blk = block("/* @sellfill", "/* @sellfill-end */");
  const S = { feed: [], fuelers: { you: 0 }, volEma: 0, buyEma: 0, sellEma: 0, confirmed: {}, fullStackNext: false };
  const ticks = [], mine = [], awards = [];
  const f = new Function("S", "markMcap", "chartTick", "chartMine", "chartState", "momNote", "noteSell", "award", "fmtShot", "fmtUsd", "isLive", "addEventListener",
    blk + "\nreturn { onFillReceipt, ownSellSwap };");
  const H = f(S, () => 5e5, (m, u, side) => ticks.push([m, u, side]), (side, m, k) => mine.push([side, k]), () => ({ seen: new Set() }), () => {}, () => {},
    (id) => awards.push(id), (u) => "$" + u.toFixed(2), (u) => "$" + u.toFixed(0), () => true, () => {});
  H.onFillReceipt({ txHash: TX2, side: "buy", usd: 1.95 });
  ok(S.feed[0] && /▲ BOOST\s+\$1\.95 {2}\(you\)/.test(S.feed[0].txt) && S.fuelers.you === 1.95 && mine.length === 1 && ticks[0][2] === "buy" && awards[0] === "first", "own BOOST receipt ⇒ TRADES row with the decoded $1.95, marker, fueler credit at confirm");
  const swap = { t: "swap", side: "buy", mine: true, txHash: TX2.toUpperCase(), usd: 1.98, mcap: 5.1e5 };
  ok(H.ownSellSwap(swap) === null && S.feed.length === 1 && S.confirmed.mcap === 5.1e5, "the lagging feed swap for that tx only moves the price (no 2nd row / marker)");
  const other = { t: "swap", side: "buy", mine: false, txHash: TX1, usd: 3 };
  ok(H.ownSellSwap(other) === other, "other traders' swaps pass through unchanged");
  const first = { t: "swap", side: "buy", mine: true, txHash: "0x" + "9".repeat(64), usd: 2 };
  ok(H.ownSellSwap(first) === first && (H.onFillReceipt({ txHash: first.txHash, side: "buy", usd: 2 }), S.feed.length === 1), "swap first ⇒ drawn from the swap; the later receipt adds nothing"); }

console.log("— SITE #137: own receipt events + holders from the receipt");
{ const tb = fs.readFileSync(path.join(web, "components/TradeBridge.tsx"), "utf8");
  const L1 = [{ address: "0x1", topics: [], data: "0x" }], L2 = [{ address: "0x1", topics: [], data: "0x", blockNumber: 1234n }];
  ok(TS.blockOfLogs(L1) === undefined && TS.blockOfLogs(L2) === 1234 && TS.blockOfLogs([{ blockNumber: "0x10" }]) === 16, "blockOfLogs: bigint / hex / none (sync relay logs carry none)");
  const R = TS.ownReceipt("0xabc", L1, "0xme", "0xcoin");
  ok(R.blockNumber === null && R.logs === L1 && R.trader === "0xme" && R.token === "0xcoin" && R.txHash === "0xabc", "ownReceipt: {txHash, logs (as-is), blockNumber null until known, trader, token}");
  ok(TS.ownReceipt("0xabc", L1, "0xme", "0xcoin", 99n).blockNumber === 99 && TS.ownReceipt("0xabc", L2, "0xme", "0xcoin").blockNumber === 1234, "ownReceipt: block from the polled receipt, else from the logs");
  const fr = tb.match(/disciple:fillreceipt", \{ detail: \{([^\n]*)\} \}\)\)/);
  ok(!!fr && /blockNumber: rcpt\.blockNumber/.test(fr[1]) && /trader: me/.test(fr[1]) && /\btoken\b/.test(fr[1]) && /logs: rl/.test(fr[1]), "fillreceipt detail adds blockNumber, trader, token, raw logs");
  ok(/dispatchEvent\(new CustomEvent\("disciple:receipt", \{ detail: rcpt \}\)\)/.test(tb) && /disciple:receipt", \{ detail: \{ \.\.\.ownReceipt\([^)]*\), update: true \} \}/.test(tb) && /RECONCILE_MIN_MS\);/.test(tb), "disciple:receipt emitted at confirm; block unknown ⇒ re-emitted once (update:true) after ≥ 1 s");
  const br = tb.slice(tb.indexOf("const bookReceipt"), tb.indexOf("window.__discipleTrade = "));
  ok((br.match(/waitForTransactionReceipt/g) || []).length === 1 && /if \(!rl\) \{[^\n]*FALLBACK ONLY[^\n]*\n\s*const rc = await pc\.waitForTransactionReceipt/.test(br), "waitForTransactionReceipt only on the no-logs fallback (never on the normal path)");
  ok((tb.match(/waitForTransactionReceipt/g) || []).length === 2, "TradeBridge: no other waitForTransactionReceipt (1 call + 1 comment)");
  const HL = mods["flight/holders"], ME = "0x" + "aa".repeat(20), BIG = "0x" + "bb".repeat(20), POOL = "0x" + "cc".repeat(20);
  const o = { me: ME, labels: { [POOL]: "pool" }, totalSupplyRaw: 1000n * 10n ** 18n, priceUsd: 2, limit: 50 };
  const lag = { rows: HL.buildHolders([{ address: BIG, balance: 50n * 10n ** 18n }, { address: POOL, balance: 900n * 10n ** 18n }, { address: ME, balance: 0n }], o), asOfBlock: null, source: "balances", at: 1 };
  ok(!lag.rows.some((r) => r.mine), "lagging node: our row missing (0 holdings) before the overlay");
  const ov = HL.overlayOwn(lag, o, 80n * 10n ** 18n), mine = ov.rows.find((r) => r.mine);
  ok(mine && mine.tokens === 80 && near(mine.usd, 160) && near(mine.pct, 8) && ov.rows[0].mine && ov.rows[ov.rows.length - 1].label === "pool", "overlayOwn: our row from the receipt ledger (80 tokens), re-ranked, pool row kept last");
  ok(HL.overlayOwn(lag, o, undefined) === lag && HL.overlayOwn(lag, { ...o, me: null }, 5n) === lag, "overlayOwn: no ledger value / no wallet ⇒ snapshot unchanged");
  const api = { rows: [{ address: POOL, balance: (900n * 10n ** 18n).toString(), tokens: 900, pct: 90, usd: 1800, label: "curve", mine: false }], asOfBlock: 7, source: "api", at: 1 };
  const ova = HL.overlayOwn(api, { ...o, labels: {} }, 10n ** 18n);
  ok(ova.rows.some((r) => r.mine && r.tokens === 1) && ova.rows.find((r) => r.address === POOL).label === "curve" && ova.asOfBlock === 7, "overlayOwn on /api/holders: API labels + asOfBlock kept");
  const hb = fs.readFileSync(path.join(web, "components/flight/HoldersBridge.tsx"), "utf8");
  ok(/OWN\.entry\(coin, me\) \? await ownRead\(OWN/.test(hb) && /overlayOwn\(raw, o, mine\)/.test(hb) && /addEventListener\("disciple:ownbalance", onOwn\)/.test(hb) && /removeEventListener\("disciple:ownbalance", onOwn\)/.test(hb),
    "HoldersBridge: own row from the ledger (pinned reconcile, never older), redrawn at confirm on disciple:ownbalance with no RPC"); }

cleanup();
console.log(bad ? `\n${bad} FAILED` : "\nall trade-speed checks passed");
process.exit(bad ? 1 : 0);
