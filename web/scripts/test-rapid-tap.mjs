// game/rapid-tap — up to 3 real trades in flight, each press with its own reservation; all sync before aaSend (#140).
//   1. repeat guards: held Enter (custom $ / custom sell) and held SPACE never auto-fire
//   2. cap: only PENDING trades count (no 450 ms linger); a 4th press = no trade, no thrust, a '3 IN FLIGHT' pulse;
//      disciple:inflight drives BOOST / DUMP greyed while 3 are pending
//   3. cash reservation incl. gas: engine spendableCash + the GAME ledger / SITE-registry shim (spendableUsd)
//   4. DUMP % from unreserved tokens: 50 % then 50 % = 75 %
//   5. stacked ghosts: a failed middle press rolls back only its own step
//   6. no await before aaSend (execCalls, and the reservation path is sync); typed error codes → copy
//   7. AUDIT timeouts: a timed-out send is UNKNOWN (hover, keep the reservation); timeout → late fill = a normal fill;
//      timeout → definite fail = ease back + "That didn't go through."
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
const dir = path.dirname(fileURLToPath(import.meta.url)), web = path.join(dir, "..");
let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const rd = (f) => fs.readFileSync(path.join(web, f), "utf8");
const eng = rd("public/flight/engine.js"), tb = rd("components/TradeBridge.tsx"), wal = rd("lib/wallet.ts");
const block = (a, b) => { const i = eng.indexOf(a), j = eng.indexOf(b, i); if (!(i > 0 && j > i)) throw new Error("engine block " + a); return eng.slice(i, j); };

// lib modules, transpiled; "@/lib/chains" → a stub (USDG decimals settable)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rapidtap-"));
fs.writeFileSync(path.join(tmp, "chains.mjs"), "export const D = { dec: 18 }; export const deployment = () => ({ usdgDecimals: D.dec });");
fs.writeFileSync(path.join(tmp, "wallet.mjs"), "export const W = { smart: true }; export const isSmartMode = () => W.smart;");
for (const m of ["rapidTap", "reservationsShim", "gasReserve"]) {
  const src = rd(`lib/flight/${m}.ts`).replace(/from "@\/lib\/chains"/g, 'from "./chains"').replace(/from "@\/lib\/wallet"/g, 'from "./wallet"').replace(/from "(\.\/[^"]+)"/g, 'from "$1.mjs"');
  fs.writeFileSync(path.join(tmp, m + ".mjs"), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText); }
const imp = (m) => import(pathToFileURL(path.join(tmp, m + ".mjs")).href);
const RT = await imp("rapidTap"), RS = await imp("reservationsShim"), GR = await imp("gasReserve"), CH = await imp("chains"), WL = await imp("wallet");
const E18 = BigInt(10) ** BigInt(18), E6 = BigInt(10) ** BigInt(6);

console.log("— 1. repeat guards");
ok(/if \(\(e\.key === "Enter" \|\| e\.key === " "\) && e\.repeat\) \{ e\.preventDefault\(\); \}\s*\/\/[^\n]*\n\s*else if \(\(e\.key === "Enter" \|\| e\.key === " "\) && customUsd\)/.test(tb), "custom $ field: held Enter / SPACE (e.repeat) only preventDefaults; a fresh press fires once");
ok(/if \(e\.key === "Enter" && e\.repeat\) e\.preventDefault\(\);\s*\/\/[^\n]*\n\s*else if \(e\.key === "Enter" && sellCustomN\)/.test(tb), "custom sell field: held Enter never auto-fires DUMPs");
ok(/e\.code==='Space'\)\{ e\.preventDefault\(\); if\(!e\.repeat\) boost\(\);/.test(eng), "engine SPACE guard kept (if(!e.repeat) boost())");
ok(/'ShiftLeft'\|\|e\.code==='ShiftRight'\)&&!mod\)\{ if\(!e\.repeat\)/.test(eng), "engine Shift (DUMP) guard kept");

console.log("— 2. cap: 3 pending, 4th press = pulse only");
const trBlock = block("/* @trade (sliced", "// Pre-flight failures");
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function engine({ live = true, cash = 100, gas = 0 } = {}) {
  const E = { thrust: [], events: [], res: [], sent: [] }; let now = 1;
  const S = { fuelers: { you: 0 }, hold: { tokens: 1e6, valueUsd: 50 }, liveBag: live ? { tokens: 1e6 } : null, flashes: [], feed: [], mode: 0, balance: cash, liveCash: cash,
    gasPerOpUsd: gas, confirmed: { mcap: 7e4 }, pending: [], cooldownUntil: 0, buyBoost: 0, score: 0, simF: 1 };
  class CE { constructor(t, o) { this.type = t; this.detail = o && o.detail; } }
  const env = { S, MODES: [{ usd: 10 }], hasTokens: () => true, noTokens() {}, isLive: () => live, markMcap: () => 7e4, MIN_SHOT: 0.2, fmtShot: (x) => "$" + (+x).toFixed(2),
    fmtMoney: (x) => "$" + (+x).toFixed(2), window: live ? { __discipleTrade() {} } : {}, applyThrust: (side, usd, pct) => E.thrust.push({ side, usd, pct }),
    source: { supply: 7e9, impact: () => 1.02, submitTrade: (side, usd, o) => { E.sent.push({ side, usd, o }); return new Promise((r) => E.res.push(r)); } },
    srcImpact: () => 1.02, fillMcapEst: () => 7e4, MAX_PENDING: 3, COOLDOWN_MS: 250, performance: { now: () => now }, mcapToAlt: (m) => Math.log10(m),
    shownMcap: () => S.confirmed.mcap, clamp, pushPaperCash() {}, dispatchEvent: (e) => E.events.push(e), CustomEvent: CE, SESSION: null, isOnchainRevert: () => true, setTimeout: () => 0 };
  E.trade = new Function(...Object.keys(env), trBlock + "\nreturn trade;")(...Object.values(env));
  E.S = S; E.at = (t) => { now = t; };
  E.settle = async (i, r) => { E.res[i](r); await new Promise((x) => setImmediate(x)); };
  E.inflight = () => E.events.filter((e) => e.type === "disciple:inflight").map((e) => e.detail);
  return E; }
for (const live of [true, false]) { const E = engine({ live, cash: 1000 }), tag = live ? "live" : "paper";
  E.trade("buy"); E.at(300); E.trade("buy"); E.at(600); E.trade("buy");
  ok(E.sent.length === 3 && E.S.pending.length === 3, `${tag}: 3 quick BOOSTs (≥ 250 ms apart) = 3 trades in flight`);
  E.at(900); const f0 = E.S.flashes.length; E.trade("buy");
  ok(E.sent.length === 3 && E.thrust.length === 0 && E.S.pending.length === 3, `${tag}: 4th press: no trade, no thrust, no ghost`);
  ok(E.S.flashes.length === f0 + 1 && E.S.flashes.at(-1).txt === "3 IN FLIGHT" && E.S.flashes.at(-1).life <= 1, `${tag}: 4th press shows a brief '3 IN FLIGHT' pulse`);
  E.at(1200); E.trade("sell", { frac: 0.5 }); E.trade("buy");
  ok(E.sent.length === 3 && E.S.flashes.filter((f) => f.inflight).length === 1, `${tag}: a 5th / DUMP press re-pulses (deduped), still nothing sent`);
  ok(E.inflight().at(-1).n === 3 && E.inflight().at(-1).max === 3, `${tag}: disciple:inflight {n:3,max:3} (TradeBridge greys BOOST / DUMP)`);
  await E.settle(0, { ok: false, reason: "x" });
  ok(E.S.pending.length === 2 && E.inflight().at(-1).n === 2, `${tag}: a failed trade frees its slot at once (no 450 ms linger)`);
  E.at(1500); E.trade("buy");
  ok(E.sent.length === 4, `${tag}: …so the next press goes straight out`);
  E.at(1600); E.trade("buy");
  ok(E.sent.length === 4 && E.S.flashes.some((f) => f.inflight && f.life > 0), `${tag}: cap again at 3`); }
{ const E = engine({ live: true, cash: 1000 }); E.trade("buy"); E.at(100); E.trade("buy"); const n1 = E.sent.length; E.at(260); E.trade("buy");
  ok(n1 === 1 && E.sent.length === 2, "250 ms cooldown kept (a press 100 ms later is dropped, 260 ms later goes out)"); }
ok(!/setTimeout\(\(\)=>\{S\.pending=S\.pending\.filter[^\n]*450\)/.test(eng) && !/,\s*450\s*\)/.test(eng), "engine: the 450 ms failed-ghost linger is gone");
ok(/disabled=\{short \|\| full\}/.test(tb) && /disabled=\{!has \|\| full\}/.test(tb) && /const full = inFlight\.n >= inFlight\.max/.test(tb) && /addEventListener\("disciple:inflight"/.test(tb), "TradeBridge: BOOST + DUMP disabled while 3 in flight (disciple:inflight)");
ok(/title=\{full \? COPY\.inFlight/.test(tb), "TradeBridge: greyed BOOST title = '3 IN FLIGHT'");

console.log("— 3. cash reservation incl. gas");
{ const E = engine({ live: true, cash: 25, gas: 0.1 });
  E.trade("buy"); E.at(300); E.trade("buy");   // $10 + $0.10 gas each ⇒ $20.20 held, $4.80 left − own gas $0.10 = $4.70
  ok(E.sent.length === 2, "live: 2 × $10 BOOST from $25 go out");
  E.at(600); E.trade("buy");
  ok(E.sent.length === 2 && /NOT ENOUGH CASH/.test(E.S.flashes.at(-1).txt) && /\$4\.70/.test(E.S.flashes.at(-1).txt) && /2 pending/.test(E.S.flashes.at(-1).txt),
    `live: 3rd $10 blocked — spendable = 25 − 2×(10+0.10) − 0.10 = $4.70 (${E.S.flashes.at(-1).txt})`);
  ok(E.thrust.length === 0, "live: blocked press = no thrust"); }
{ const E = engine({ live: true, cash: 20.2, gas: 0.1 }); E.trade("buy"); E.at(300); E.trade("buy");
  ok(E.sent.length === 2, "live: exactly-enough cash incl. gas ($20.20 = 2×10 + 2×0.10 gas) passes"); }
{ const E = engine({ live: true, cash: 20.15, gas: 0.1 }); E.trade("buy"); E.at(300); E.trade("buy");
  ok(E.sent.length === 1, "live: 5 ¢ short of the gas reserve ⇒ the 2nd BOOST is blocked"); }
{ const E = engine({ live: false, cash: 25, gas: 0.1 }); E.trade("buy"); E.at(300); E.trade("buy"); E.at(600); E.trade("buy");
  ok(E.sent.length === 2, "paper: Σ pending $ reserved too (no gas in paper): $25 ⇒ 2 × $10"); }
// FLOW #145 gas adapter semantics: raw USDG at the config decimals (18 testnet / 6 after redeploy), 10 USDG cold, 0n outside smart mode
CH.D.dec = 18; WL.W.smart = true;
ok(GR.peekGasReservePerOp() === null && GR.gasReservePerOp() === BigInt(10) * E18, "gas adapter cold (18 dec): peek null, gasReservePerOp = 10 USDG raw");
CH.D.dec = 6; ok(GR.gasReservePerOp() === BigInt(10) * E6, "gas adapter cold (6 dec after the redeploy): 10 USDG raw — decimals from config, not hard-coded");
WL.W.smart = false; ok(GR.gasReservePerOp() === BigInt(0) && GR.peekGasReservePerOp() === BigInt(0), "outside smart mode: 0n (both)"); WL.W.smart = true;
CH.D.dec = 18; GR.setGasReservePeek(() => E18 / BigInt(20));   // warm: $0.05
ok(GR.peekGasReservePerOp() === E18 / BigInt(20) && GR.gasReservePerOp() === E18 / BigInt(20), "gas adapter warm: the cached cap");
ok(typeof GR.gasReservePerOp() === "bigint", "gasReservePerOp(): bigint, sync");
// GAME ledger (raw bigint) + the SITE registry shim (#144 signatures)
{ const evs = []; const off = RS.subscribe((e) => evs.push(e));
  RT.reservePress("a", "buy", "0xC0in", 10); RT.reservePress("b", "buy", "0xC0in", 5);
  const pend = RT.pendingCashRaw(18);
  ok(pend === BigInt(15) * E18 + E18 / BigInt(10), `GAME pending (raw, 18 dec) = Σ usd + Σ gas = 15.10 USDG: ${pend}`);
  const cash = BigInt(20) * E18;
  ok(RT.spendableRaw(cash, 18) === cash - pend - E18 / BigInt(20), "spendableRaw = raw cash − pending − own gas (bigint, no float)");
  ok(RT.canSpend(cash, 4.85, 18) && !RT.canSpend(cash, 4.850001, 18), "canSpend: exactly $4.85 left (raw compare), a µ$ more is short");
  ok(RT.rawToUsd(RT.spendableRaw(cash, 18), 18).toFixed(2) === "4.85", "$ only for display (rawToUsd)");
  ok(RS.RESERVATIONS.get("a").side === "boost" && RS.RESERVATIONS.get("a").usd === 10 && RS.RESERVATIONS.get("a").gasReserve === E18 / BigInt(20), "registry entry: SITE side 'boost', usd, gasReserve raw (same press id)");
  ok(RS.inflightCount() === 2 && RS.inflightCount("boost") === 2 && RS.pendingNet("0xc0in").buys === 2, "inflightCount / pendingNet (SITE API) see the presses");
  ok(RS.reserve("a", { side: "boost", coin: "0xC0in", usd: 10 }) && RS.inflightCount() === 2, "reserve is idempotent per id (the trade layer merging into the press id ≠ a 2nd hold)");
  RT.releasePress("a", "filled");
  ok(RT.pendingCashRaw(18) === BigInt(5) * E18 + E18 / BigInt(20) && RT.pendingPresses().length === 1 && !RS.RESERVATIONS.has("a"), "release frees that press only");
  RT.releasePress("b", "error"); RT.releasePress("b", "error");
  ok(RT.pendingCashRaw(18) === BigInt(0) && evs.filter((e) => e.type === "release").length === 2 && evs.at(-1).reason === "error", "release is idempotent; subscribe gets {type, id, reason}");
  off(); const n = evs.length; RT.reservePress("z", "buy", "0xc0in", 1); ok(evs.length === n, "unsubscribe works"); RT.releasePress("z", "cancel"); }
ok(/const short = rawLive \? !canSpend\(CASH_RAW\.v!, shotUsd, dec\)/.test(tb) && /CASH_RAW\.v = raw;/.test(tb) && !/usdgDecimals \?\? (6|18)/.test(tb),
  "TradeBridge short check: raw bigint vs the raw balance (decimals from config, none hard-coded)");
{ const i = tb.indexOf("window.__discipleTrade = async"), c = tb.indexOf("!canSpend(CASH_RAW.v, usd", i), a = tb.indexOf("await ", i);
  ok(c > i && c < a, "TradeBridge: raw cash check on top of pending presses at entry, before any await"); }
ok(/detail: \{ usd, gasPerOpUsd: gasUsd\(\) \}/.test(tb), "TradeBridge pushes the per-op gas reserve to the engine with disciple:cash");

console.log("— 4. DUMP % sizes from unreserved tokens");
{ const bal = BigInt(1000) * BigInt(10) ** BigInt(18), C = "0xC0in";
  const half = (b) => b / BigInt(2);   // sellAmountFor(bal, {frac:0.5})
  RT.reservePress("s1", "sell", C); const a1 = half(RT.unreservedTokens(bal, C)); RT.reservePressTokens("s1", a1);
  RT.reservePress("s2", "sell", C); const a2 = half(RT.unreservedTokens(bal, C)); RT.reservePressTokens("s2", a2);
  ok(a1 + a2 === bal * BigInt(3) / BigInt(4), "50 % then 50 % (both in flight) = 75 % of the bag");
  ok(RS.reservedTokens(C.toLowerCase()) === a1 + a2, "reservedTokens(coin) is case-insensitive, sums pending sells");
  RT.reservePress("s3", "sell", C); RT.reservePressTokens("s3", RT.unreservedTokens(bal, C));
  ok(RT.unreservedTokens(bal, C) === BigInt(0), "DUMP ALL then: only the unreserved quarter; nothing left after");
  ok(RT.pendingCashRaw(18) === BigInt(3) * E18 / BigInt(20) && RS.RESERVATIONS.get("s1").side === "dump", "pending sells hold gas only (3 × 0.05), SITE side 'dump'");
  for (const id of ["s1", "s2", "s3"]) RT.releasePress(id, "x"); }
{ const i = tb.indexOf("const free = unreservedTokens(bal, token);"), j = tb.indexOf("reservePressTokens(pressId, amountIn);");
  ok(i > 0 && j > i && !/await /.test(tb.slice(i, j)) && /sellAmountFor\(free, o\)/.test(tb.slice(i, j)), "TradeBridge: sized from the unreserved balance and reserved in the same sync step (no await between)"); }
ok(/releaseAfter = bookReceipt\(/.test(tb) && /releaseAfter\.finally\(\(\) => releasePress\(pressId, "filled"\)\)/.test(tb), "slow path (no logs): the press is released only after its receipt is booked");

console.log("— 5. stacked ghosts, failed middle rolls back only its step");
{ const E = engine({ live: true, cash: 1000 }); E.trade("buy"); E.at(300); E.trade("buy"); E.at(600); E.trade("buy");
  const [a, b, c] = E.S.pending;
  ok(near(b.from, a.proj) && near(c.from, b.proj) && near(c.proj, 7e4 * 1.02 ** 3), "each ghost projected from the previous pending one (3 steps)");
  await E.settle(1, { ok: false, reason: "x" });
  ok(E.S.pending.length === 2 && near(c.from, a.proj) && near(c.proj, 7e4 * 1.02 ** 2), "middle fails: its ghost gone, the later one drops by its step only");
  ok(E.S.flashes.some((f) => /didn't go through/.test(f.txt)), "failure copy: \"That didn't go through.\""); }

console.log("— 6. no await before aaSend; error copy");
{ const body = wal.slice(wal.indexOf("export async function execCalls"), wal.indexOf("handOffLogs(r.txHash", wal.indexOf("export async function execCalls")));
  ok(body.indexOf("await aaSend(") > 0 && (body.slice(0, body.indexOf("await aaSend(")).match(/await /g) || []).length === 0, "execCalls: no await before aaSend"); }
{ const i = tb.indexOf("window.__discipleTrade = async"), r = tb.indexOf("reservePress(pressId", i), a = tb.indexOf("await ", i);
  ok(r > i && a > r, "TradeBridge: the press is reserved before the first await of the trade"); }
for (const [f, src] of [["reservationsShim", rd("lib/flight/reservationsShim.ts")], ["gasReserve", rd("lib/flight/gasReserve.ts")]])
  ok(!/\bawait\b|\basync\b/.test(src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")), `${f}.ts: no async / await (sync in the trade path)`);
{ const rt = rd("lib/flight/rapidTap.ts"), pre = rt.slice(0, rt.indexOf("export function watchOutcome"));
  ok(!/\bawait\b|\basync\b/.test(pre.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")), "rapidTap.ts: every pre-send helper is sync (only the post-timeout watcher is async)");
  const rs = [RT.reservePress("x-sync", "sell", "0xc"), RT.reservePressTokens("x-sync", BigInt(1)), RT.spendableRaw(E18, 18), RT.canSpend(E18, 1, 18), RT.unreservedTokens(E18, "0xc"), RT.releasePress("x-sync", "cancel")];
  ok(rs.every((x) => !(x instanceof Promise)), "reservePress / reservePressTokens / spendableRaw / canSpend / unreservedTokens / releasePress return synchronously"); }
ok(!/\bawait\b/.test(block("/* @rapidtap —", "/* @rapidtap-end */")), "engine @rapidtap: sync");
ok(RT.tradeErrorCopy({ ok: false, code: "rate_limited", retryAfterMs: 800, reason: "x" }) === "Slow down", "code rate_limited → 'Slow down'");
ok(RT.tradeErrorCopy({ ok: false, code: "spend_limit", reason: "x" }) === "Spend limit reached", "code spend_limit → 'Spend limit reached'");
ok(RT.tradeErrorCopy({ ok: false, reason: "HTTP 429 Too Many Requests" }) === "Slow down" && RT.tradeErrorCopy({ ok: false, reason: "SpendCapExceeded()" }) === "Spend limit reached", "fallback string match (no code yet)");
ok(RT.tradeErrorCopy({ ok: false, reason: "That didn't go through. Try again." }) === "That didn't go through. Try again.", "other reasons pass through");
ok(/if \(!r\.ok\) r\.reason = tradeErrorCopy\(/.test(tb), "TradeBridge maps the trade result's reason through tradeErrorCopy");
ok(RT.tradeErrorCode({ code: "rate_limited", retryAfterMs: 500 }) === "rate_limited" && RT.tradeErrorCode({ errorCode: "spend_limit" }) === "spend_limit" && RT.tradeErrorCode(new Error("x")) === undefined, "tradeErrorCode mirrors SITE's (ProtocolError.code / TradeResult.errorCode)");
ok(RT.tradeErrorCopy({ ok: false, errorCode: "spend_limit", reason: "x" }) === "Spend limit reached", "TradeResult.errorCode → copy");
ok(/reservationId: pressId/.test(tb), "TradeParams.reservationId = the press id (SITE #144: else counted twice)");

console.log("— 7. AUDIT: a timed-out send is unknown, not failed");
ok(RT.isUnknownOutcome({ code: "Timeout", message: "Still confirming. Check back in a moment." }) && RT.isUnknownOutcome({ ok: false, reason: "Still confirming. Check back in a moment." }) && RT.isUnknownOutcome({ message: "x", cause: { code: "Timeout" } }),
  "ProtocolError Timeout / 'Still confirming' / a Timeout cause = unknown");
ok(!RT.isUnknownOutcome({ code: "Reverted", message: "Price moved too much." }) && !RT.isUnknownOutcome({ message: "The trade took too long and expired. Try again." }) && !RT.isUnknownOutcome({ code: "Bundler", message: "That didn't go through. Try again." }),
  "revert / expired / rejected-before-send = definite");
ok(RT.opIds({ code: "Timeout", extra: { txHash: "0xab", userOpHash: "0xcd" } }).txHash === "0xab" && RT.opIds({ cause: { txHash: "0xef" } }).txHash === "0xef", "op ids from AAError.extra / cause chain");
const tick = () => new Promise((x) => setImmediate(x));
const fakeSleep = () => { const q = []; return { sleep: () => new Promise((r) => q.push(r)), step: async () => { const r = q.shift(); if (r) r(); for (let i = 0; i < 4; i++) await tick(); }, q }; };
{ // receipt lookup: null (not mined yet) then success ⇒ landed; reservation kept until then
  const F = fakeSleep(); let calls = 0; RT.reservePress("t1", "buy", "0xc", 10);
  const w = RT.watchOutcome({ pressId: "t1", txHash: "0x01", sleep: F.sleep, schedule: [1, 2, 3], subscribe: RS.subscribe, lookup: async () => (++calls < 2 ? null : { status: "success" }) });
  let out; w.then((x) => { out = x; });
  await F.step(); ok(out === undefined && RT.isHeld("t1") && RS.RESERVATIONS.has("t1"), "timeout → not mined yet: still held (cap + cash reservation)");
  await F.step(); ok(out?.state === "landed" && out.txHash === "0x01", "timeout → late fill: landed from the receipt"); RT.releasePress("t1", "filled"); }
{ const F = fakeSleep(); RT.reservePress("t2", "buy", "0xc", 10);
  const w = RT.watchOutcome({ pressId: "t2", txHash: "0x02", sleep: F.sleep, schedule: [1], lookup: async () => ({ status: "reverted" }) }); let out; w.then((x) => { out = x; });
  await F.step(); ok(out?.state === "failed" && out.reason === "That didn't go through. Try again.", "timeout → reverted receipt: definite failure"); RT.releasePress("t2", "error"); }
{ // no tx hash: SITE's resolution of the press id; SITE's timeout/TTL release is only a backstop ⇒ re-held
  const F = fakeSleep(); RT.reservePress("t3", "buy", "0xc", 10); let out;
  RT.watchOutcome({ pressId: "t3", sleep: F.sleep, schedule: [1, 2], subscribe: RS.subscribe }).then((x) => { out = x; });
  RS.release("t3", "timeout"); ok(RS.RESERVATIONS.has("t3") && out === undefined, "SITE timeout / 60 s TTL release ⇒ GAME re-holds (not an outcome)");
  RS.release("t3", "filled"); await tick(); ok(out?.state === "landed", "SITE release 'filled' ⇒ landed"); RT.releasePress("t3", "filled"); }
{ const F = fakeSleep(); RT.reservePress("t4", "buy", "0xc", 10); let out;
  RT.watchOutcome({ pressId: "t4", sleep: F.sleep, schedule: [1], subscribe: RS.subscribe }).then((x) => { out = x; });
  RS.release("t4", "error"); await tick(); ok(out?.state === "failed", "SITE release 'error' ⇒ definite failure"); RT.releasePress("t4", "error"); }
{ const F = fakeSleep(); RT.reservePress("t5", "buy", "0xc", 10); let out;
  RT.watchOutcome({ pressId: "t5", txHash: "0x05", sleep: F.sleep, schedule: [1, 2], lookup: async () => null }).then((x) => { out = x; });
  await F.step(); await F.step(); ok(out?.state === "unknown" && RT.isHeld("t5"), "never resolves: 'unknown' at the end of the schedule (caller releases; the balance poll shows the truth)"); RT.releasePress("t5", "timeout"); }
// engine: timeout → hover; then late fill / definite fail
for (const lateOk of [true, false]) { const E = engine({ live: true, cash: 1000 }); E.trade("buy"); const p = E.S.pending[0], ba = p.ba;
  let resolveLate; const late = new Promise((r) => { resolveLate = r; });
  await E.settle(0, { ok: false, pending: true, reason: "Still confirming…", late });
  ok(E.S.pending.length === 1 && p.state === "pending" && p.unknown === 1 && ba.st !== "fail" && E.thrust.length === 0, `timeout${lateOk ? " (→ late fill)" : " (→ fail)"}: still pending, rocket still hovering, no thrust`);
  ok(E.S.flashes.some((f) => f.txt === "Still confirming…") && !E.S.flashes.some((f) => /didn't go through/.test(f.txt)) && !E.S.feed.some((r) => r.err), "timeout: calm 'Still confirming…', no failure copy / row");
  E.at(31000); E.trade("buy"); ok(E.inflight().at(-1).n >= 1 && E.S.pending.includes(p), "timeout: the press keeps its slot (counts toward the 3)");
  resolveLate(lateOk ? { ok: true, txHash: "0xlate", lateFill: true, fillUsd: 9.9 } : { ok: false, reason: "That didn't go through. Try again." }); for (let i = 0; i < 4; i++) await tick();
  if (lateOk) ok(p.state === "confirmed" && ba.st === "ok" && E.thrust.length === 1 && E.events.some((e) => e.type === "disciple:paperfill" && e.detail.txHash === "0xlate") && !E.S.pending.includes(p), "timeout → late fill: a normal fill (completes, thrust, booked by txHash)");
  else ok(p.state === "failed" && ba.st === "fail" && E.thrust.length === 0 && E.S.flashes.some((f) => /didn't go through/.test(f.txt)) && !E.S.pending.includes(p), "timeout → definite fail: eases back, \"That didn't go through.\""); }
{ const E = engine({ live: true, cash: 1000 }); E.trade("buy"); const p = E.S.pending[0];
  await E.settle(0, { ok: false, pending: true, late: Promise.resolve({ ok: false, unknown: true, reason: "Couldn't confirm yet. Check your balance in a moment." }) }); for (let i = 0; i < 4; i++) await tick();
  ok(!E.S.pending.includes(p) && !E.S.flashes.some((f) => /didn't go through/.test(f.txt)) && !E.S.feed.some((r) => r.err), "still unknown at the end: calm line, no failure copy / row"); }
{ const BA = new Function("clamp", "S", block("/* @boostanim", "/* @boostanim-end */") + "\nreturn {baStart,baOffset};")(clamp, { pending: [] });
  const L = []; const e = BA.baStart(L, 0, 1, 0); e.unk = 1;
  ok(BA.baOffset(L, 0, 45000) > 0.69 && e.st !== "fail", "@boostanim: an unknown-outcome send keeps hovering past the 30 s stale guard"); }
ok(/if \(isUnknownOutcome\(e\)\) return unknownOutcome\(e\);/.test(tb) && /if \(!r\.ok && isUnknownOutcome\(r\)\) return unknownOutcome\(r\);/.test(tb), "TradeBridge: a thrown / returned timeout goes to the unknown path, not the failure copy");
ok(/if \(!keep\) \{/.test(tb) && /releasePress\(pressId, "filled"\); \s*setTimeout|setLast\(doneLine\(side, usd, \{ ok: true \}, fill, fmtMoney\)\); releasePress\(pressId, "filled"\)/.test(tb), "TradeBridge: no release on timeout; the late watcher releases on the real outcome (late fill booked from its receipt)");

fs.rmSync(tmp, { recursive: true, force: true });
if (bad) { console.log(`\n${bad} rapid-tap check(s) FAILED`); process.exit(1); }
console.log("\nall rapid-tap checks passed");
