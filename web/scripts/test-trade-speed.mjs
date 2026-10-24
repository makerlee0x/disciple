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
ok(/noteReceipt\(r\.txHash, r\.receipt\.receipt\.logs\)/.test(wl) && /noteReceipt\(hash, last\.logs\)/.test(wl), "lib/wallet.execCalls hands the returned logs over (smart account + EOA paths)");
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

cleanup();
console.log(bad ? `\n${bad} FAILED` : "\nall trade-speed checks passed");
process.exit(bad ? 1 : 0);
