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
const { mods, cleanup } = await loadLib(["config", "pnl", "flight/fills", "flight/tradeSpeed", "abi/DiscipleRouter"], "tradespeed-");
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
    performance: { now: () => 1 }, pushPaperCash() {}, dispatchEvent: (e) => E.events.push(e), CustomEvent: CE, SESSION: null, isOnchainRevert: () => true, setTimeout: () => 0 };
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

cleanup();
console.log(bad ? `\n${bad} FAILED` : "\nall trade-speed checks passed");
process.exit(bad ? 1 : 0);
