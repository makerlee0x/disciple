// game/rapid-tap — up to 3 real trades in flight, each press with its own reservation; all sync before aaSend (#140).
//   1. repeat guards: held Enter (custom $ / custom sell) and held SPACE never auto-fire
//   2. cap: only PENDING trades count (no 450 ms linger); a 4th press = no trade, no thrust, a '3 IN FLIGHT' pulse;
//      disciple:inflight drives BOOST / DUMP greyed while 3 are pending
//   3. cash reservation incl. gas: engine spendableCash + the GAME ledger / SITE-registry shim (spendableUsd)
//   4. DUMP % from unreserved tokens: 50 % then 50 % = 75 %
//   5. stacked ghosts: a failed middle press rolls back only its own step
//   6. no await before aaSend (execCalls, and the reservation path is sync); typed error codes → copy
//   7. AUDIT: SITE 'pending_unknown' (#144 01b27d97) is NOT a failure: hover + SITE keeps the hold (GAME can't release it);
//      resolved filled = a normal fill, resolved error = ease back + "That didn't go through.", release with no amountOut
//      = filled, booked from a balance re-read
//   gas reserve: derived cold value (op gas limit × gas price × 1.5 × ETH/USD), never a flat 10 USDG; a $1 BOOST is never
//      blocked when cash covers it + the op's real gas
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
const dir = path.dirname(fileURLToPath(import.meta.url)), web = path.join(dir, "..");
let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const rd = (f) => fs.readFileSync(path.join(web, f), "utf8");
const eng = rd("public/flight/engine.js"), tb = rd("components/TradeBridge.tsx"), wal = rd("lib/wallet.ts");
const block = (a, b) => { const i = eng.indexOf(a), j = eng.indexOf(b, i); if (!(i > 0 && j > i)) throw new Error("engine block " + a); return eng.slice(i, j); };

// lib modules, transpiled; "@/lib/chains" / "@/lib/wallet" / "@/lib/config" → stubs (USDG decimals settable); lib/usdg is the REAL one
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rapidtap-"));
const USDG = "0x25030Bff74764aD72b912276a603717DB1C00644";
fs.writeFileSync(path.join(tmp, "chains.mjs"), `export const D = { dec: 18 }; export const deployment = () => ({ usdgDecimals: D.dec, usdg: "${USDG}", defaultQuote: "0x0000000000000000000000000000000000000001" });`);
fs.writeFileSync(path.join(tmp, "wallet.mjs"), "export const W = { smart: true }; export const isSmartMode = () => W.smart;");
fs.writeFileSync(path.join(tmp, "config.mjs"), `export const GAS = ${JSON.stringify({ execGas: 200000, ethUsd: 2372, robinhoodGwei: 0.0207, maxOverhead: 0.05 })}; export const CURVE = { decimals: 18, graduationMcap: 33000 }; export const STRATEGY_TOKEN = { address: "0x0000000000000000000000000000000000000002", decimals: 18 };`);
fs.writeFileSync(path.join(tmp, "abi.mjs"), "export const tokenAbi = [];");
{ const g = rd("lib/aa/gasPolicy.ts"), pick = (re) => { const m = g.match(re); if (!m) throw new Error("gasPolicy " + re); return m[0]; };
  // the REAL clientFees + its constants, sliced out of lib/aa/gasPolicy (its abi imports aren't needed for this)
  fs.writeFileSync(path.join(tmp, "gasPolicy.ts"), [pick(/export const RELAYER_TIP = [^\n]+/), pick(/export const CLIENT_FEE_HEADROOM_PCT = [^\n]+/), pick(/export function clientFees\([\s\S]*?\n\}/)].join("\n")); }
const viemUrl = import.meta.resolve("viem");
ok(/robinhoodGwei: 0\.0207/.test(rd("lib/config.ts")) && /ethUsd: 2372/.test(rd("lib/config.ts")), "config stub = lib/config GAS (gwei / ETH-USD)");
const rew = (src) => src.replace(/from "@\/lib\/(chains|wallet|config|usdg)"/g, 'from "./$1"').replace(/from "@\/lib\/aa\/gasPolicy"/g, 'from "./gasPolicy"').replace(/from "\.\.\/usdg"/g, 'from "./usdg"').replace(/from "viem"/g, `from "${viemUrl}"`).replace(/from "(\.\/[^"]+)"/g, 'from "$1.mjs"');
for (const [m, f] of [["gasPolicy", path.relative(web, path.join(tmp, "gasPolicy.ts"))], ["rapidTap", "lib/flight/rapidTap.ts"], ["reservationsShim", "lib/flight/reservationsShim.ts"], ["gasReserve", "lib/flight/gasReserve.ts"], ["usdg", "lib/usdg.ts"]])
  fs.writeFileSync(path.join(tmp, m + ".mjs"), ts.transpileModule(rew(rd(f)), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText);
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
// gas reserve (FLOW #145 @e693cb5c adapter): gasReservePerOp(kind) — warm = the signed allowance's real maxTokenCost (as is),
// cold = gas limit(kind) × allowance maxFee formula × rate, capped at maxCostCap. FLOW's math, same numbers.
const usdOf = (raw, dec = 18) => Number(raw) / 10 ** dec;
{ const g = rd("lib/aa/gasPolicy.ts");
  ok(/maxFeePerGas = \(\(baseFee \* BigInt\(2\) \+ maxPriorityFeePerGas\) \* headroomPct\) \/ BigInt\(100\)/.test(g) && /maxPriorityFeePerGas = \(t \* BigInt\(110\)\) \/ BigInt\(100\)/.test(g),
    "clientFees (lib/aa/gasPolicy, the real one is used): maxFee = (2·base + tip·1.1) × 1.5 — FLOW's allowance formula input");
  ok(GR.TRADE_GAS_LIMIT === BigInt(2_410_000) && GR.GRAD_GAS_LIMIT === BigInt(6_000_000) && GR.ALLOWANCE_FEE_MULT === BigInt(2), "gas limits = FLOW: trade 2.41M (ALLOWANCE_GAS), gradBuy 6M (GRAD_GAS_CAPS.total); fee ×2 (ALLOWANCE_FEE_MULT)");
  const fp = rd("lib/aa/fastPath.ts");
  ok(/callGasLimit: BigInt\(1_800_000\), verificationGasLimit: BigInt\(350_000\), preVerificationGas: BigInt\(60_000\)/.test(fp), "trade limit's STATIC_GAS part matches lib/aa/fastPath"); }
CH.D.dec = 18; WL.W.smart = true; GR.setGasPrice(null); GR.setWarmAllowance(null); GR.setPaymasterCap(undefined); GR.setOpMaxFee(undefined);
{ const t = GR.gasReservePerOp(), gb = GR.gasReservePerOp("gradBuy");
  ok(GR.peekGasReservePerOp() === null && Math.abs(usdOf(t) - 0.7289) < 0.001 && Math.abs(usdOf(gb) - 1.8147) < 0.002, `cold, config constants (0.0207 gwei, $2372): trade ${usdOf(t).toFixed(4)}, gradBuy ${usdOf(gb).toFixed(4)} (FLOW: 0.73 / 1.81)`); }
GR.setGasPrice(BigInt(10_000_000));   // today's live eth_gasPrice 0.01 gwei
const COLD = GR.gasReservePerOp();
ok(Math.abs(usdOf(COLD) - 0.3619) < 0.001 && Math.abs(usdOf(GR.gasReservePerOp("gradBuy")) - 0.9009) < 0.002, `cold, live 0.01 gwei: trade ${usdOf(COLD).toFixed(4)} (≈ 0.36), gradBuy ${usdOf(GR.gasReservePerOp("gradBuy")).toFixed(4)} (≈ 0.90)`);
ok(COLD === GR.derivedGasReserve({ kind: "trade", gasPriceWei: BigInt(10_000_000), decimals: 18 }), "= FLOW derivedGasReserve (tokenCost(limit × allowanceMaxFee(gp), rate), rounded up)");
CH.D.dec = 6; ok(Math.abs(usdOf(GR.gasReservePerOp(), 6) - usdOf(COLD)) < 2e-6, "6 dec after the redeploy: same $, raw at 6 dec (lib/usdg decimals)"); CH.D.dec = 18;
GR.setPaymasterCap(E18 / BigInt(2)); ok(GR.gasReservePerOp("gradBuy") === E18 / BigInt(2) && GR.gasReservePerOp() === COLD, "cold value clamped at the paymaster's maxCostCap (contract refuses more)"); GR.setPaymasterCap(undefined);
{ let n = 0; const pc = { getGasPrice: async () => { n++; return BigInt(10_000_000); } };
  GR.setGasPrice(null); await GR.warmGasPrice(pc); await GR.warmGasPrice(pc); ok(n === 1 && GR.gasReservePerOp() === COLD, "warmGasPrice reads eth_gasPrice in the background, 30 s TTL (one read)");
  await GR.warmGasPrice({ getGasPrice: async () => { throw new Error("rpc"); } }); ok(GR.gasReservePerOp() === COLD, "warmGasPrice never throws (keeps the last price)"); }
WL.W.smart = false; ok(GR.gasReservePerOp() === BigInt(0) && GR.peekGasReservePerOp("gradBuy") === BigInt(0), "outside smart mode (gas not paid in USDG): 0n (both, both kinds)"); WL.W.smart = true;
{ const rate = BigInt(2400) * E18, fee = BigInt(63_300_000);
  const A = (mtc) => ({ maxTokenCost: mtc, rate, debt: BigInt(0), maxFeePerGas: fee });
  GR.setWarmAllowance(() => A(E18 / BigInt(20))); ok(GR.peekGasReservePerOp() === E18 / BigInt(20) && GR.gasReservePerOp() === E18 / BigInt(20), "warm trade: the allowance's real maxTokenCost ($0.05) as is");
  const spike = COLD * BigInt(3); GR.setWarmAllowance(() => A(spike)); ok(GR.gasReservePerOp() === spike && spike > COLD, "warm, gas spike: cached maxTokenCost above the derived value wins (no min ⇒ no AA33)");
  GR.setWarmAllowance(() => ({ ...A(E18), debt: BigInt(7) })); ok(GR.gasReservePerOp("gradBuy") === GR.tokenCost(GR.GRAD_GAS_LIMIT * fee, rate) + BigInt(7), "warm gradBuy: tokenCost(6M × allowance maxFee, allowance rate) + debt (FLOW peekReserve)");
  GR.setOpMaxFee(fee * BigInt(2)); ok(GR.gasReservePerOp("gradBuy") === GR.tokenCost(GR.GRAD_GAS_LIMIT * fee * BigInt(2), rate) + BigInt(7), "warm gradBuy: the higher cached op maxFee wins"); GR.setOpMaxFee(undefined);
  GR.setWarmAllowance(null); ok(GR.gasReservePerOp() === GR.derivedGasReserve({ gasPriceWei: BigInt(10_000_000), rate, decimals: 18 }), "allowance gone stale ⇒ cold again, at the last signed rate (FLOW lastRate)");
  GR.setWarmAllowance(() => A(BigInt(10) * E18)); ok(GR.gasReservePerOp() === BigInt(10) * E18, "warm stale 10 USDG (FLOW's real cap) is honoured as is");
  ok(!RT.canSpend(BigInt(140) * E18 / BigInt(100), 1), "…so a $1 BOOST on $1.40 is short while that is cached (FLOW's real cap; accepted, noted in the PR)");
  // FLOW's lastRate is module state: a last fresh allowance at the config rate puts the rest back on config numbers
  GR.setWarmAllowance(() => ({ ...A(E18), rate: GR.configRate(18) })); GR.peekGasReservePerOp(); GR.setWarmAllowance(null); }
GR.setGasPrice(BigInt(10_000_000));
const G = GR.gasReservePerOp();
// $1 BOOST: never blocked when cash covers the trade + the op's real (paymaster) gas — realistic cold reserve ≈ 0.36 USDG
{ ok(GR.peekGasReservePerOp() === null, "cold cache for the $1 BOOST case");
  const cash = E18 + G;
  ok(RT.canSpend(cash, 1) && !RT.canSpend(cash - BigInt(1), 1), `$1 BOOST with $1 + one op's gas (${usdOf(G).toFixed(4)}) passes; 1 wei less is short`);
  ok(RT.canSpend(BigInt(140) * E18 / BigInt(100), 1), "$1 BOOST with $1.40 cash goes out on a COLD cache at today's gas (reserve ≈ $0.36; a flat 10 USDG blocked it)");
  CH.D.dec = 6; const G6 = GR.gasReservePerOp(); ok(RT.canSpend(E6 + G6, 1) && !RT.canSpend(E6 + G6 - BigInt(1), 1), "same at 6 dec"); CH.D.dec = 18; }
// gas kind: "gradBuy" when this BOOST could graduate the curve (FLOW GasOpKind)
{ const H = (usd, graduates, mcapAfterUsd, venue = "curve") => ({ usd, graduates, mcapAfterUsd, venue });
  ok(RT.gasKindFor("sell", 50, H(10, true, 34000), 32000) === "trade", "DUMP ⇒ trade");
  ok(RT.gasKindFor("buy", 50, H(10, false, 20000, "router"), 40000) === "trade", "graduated (router venue) ⇒ trade");
  ok(RT.gasKindFor("buy", 10, H(10, true, 33500), 32800) === "gradBuy", "preview says this amount graduates ⇒ gradBuy");
  ok(RT.gasKindFor("buy", 5, H(10, false, 12000), 11000) === "trade", "smaller than a previewed amount that doesn't cross ⇒ trade");
  ok(RT.gasKindFor("buy", 200, H(10, false, 31000), 30500) === "gradBuy" && RT.gasKindFor("buy", 20, H(10, false, 12000), 11000) === "trade", "bigger than previewed: scaled mcap estimate (×1.25 margin) decides");
  ok(RT.gasKindFor("buy", 10, null, 31000) === "gradBuy" && RT.gasKindFor("buy", 10, null, 12000) === "trade" && RT.gasKindFor("buy", 10, null, 0) === "trade", "no preview: gradBuy only within 10 % of the grad mcap");
  RT.reservePress("gk", "buy", "0xc", 10, "gradBuy"); ok(RS.RESERVATIONS.get("gk").gasReserve === GR.gasReservePerOp("gradBuy"), "a gradBuy BOOST holds the grad gas cap"); RT.releasePress("gk", "cancel");
  ok(!RT.canSpend(E18 * BigInt(10) + G, 10, "gradBuy") && RT.canSpend(E18 * BigInt(10) + G, 10), "canSpend uses the kind's reserve"); }
// GAME presses in SITE's registry (01b27d97): cash math in raw bigint via RESERVATIONS.reservedRaw (decimals from lib/usdg)
{ const evs = []; const off = RS.subscribe((e) => evs.push(e));
  RT.reservePress("a", "buy", "0xC0in", 10); RT.reservePress("b", "buy", "0xC0in", 5);
  const pend = RT.pendingCashRaw();
  ok(pend === BigInt(15) * E18 + BigInt(2) * G, `pending (raw, 18 dec) = Σ usd + Σ gas = 15 USDG + 2 × gas: ${pend}`);
  ok(Math.abs(RS.reservedCash() - (15 + 2 * Number(G) / 1e18)) < 1e-9, "SITE reservedCash() ($) agrees at 18 dec (01b27d97 fixed the 6-dec assumption)");
  const cash = BigInt(20) * E18;
  ok(RT.spendableRaw(cash) === cash - pend - G, "spendableRaw = raw cash − pending − own gas (bigint, no float)");
  const left = RT.rawToUsd(cash - pend - G);
  ok(RT.canSpend(cash, Math.floor(left * 1e6) / 1e6) && !RT.canSpend(cash, Math.ceil(left * 1e6) / 1e6 + 1e-6), `canSpend boundary at $${left.toFixed(6)} (raw compare)`);
  ok(RS.RESERVATIONS.get("a").side === "boost" && RS.RESERVATIONS.get("a").usd === 10 && RS.RESERVATIONS.get("a").gasReserve === G, "registry entry: side 'boost', usd, gasReserve raw (same press id)");
  ok(RS.inflightCount() === 2 && RS.inflightCount("boost") === 2 && RS.pendingNet("0xc0in").buys === 2, "inflightCount / pendingNet (SITE API) see the presses");
  RS.reserve("a", { side: "boost", coin: "0xC0in", usd: 10, spend: { asset: USDG, raw: BigInt(10) * E18 } });
  ok(RS.inflightCount() === 2 && RT.pendingCashRaw() === pend, "the trade layer merging its exact spend into the press id ≠ a 2nd hold (reservationId)");
  RS.reserve("auto1", { side: "boost", coin: "0xC0in", usd: 1 }); ok(RS.RESERVATIONS.get("auto1").gasReserve === G, "setGasReserveSource wired: a trade-layer reservation holds one op's gas too"); RS.release("auto1", "cancel");
  RT.releasePress("a", "filled");
  ok(RT.pendingCashRaw() === BigInt(5) * E18 + G && !RS.RESERVATIONS.has("a"), "release frees that press only");
  ok(RT.releasePress("b", "error") === true && RT.releasePress("b", "error") === false, "release is idempotent");
  ok(RT.pendingCashRaw() === BigInt(0) && evs.filter((e) => e.type === "release" && e.id === "b").length === 1 && evs.at(-1).reason === "error", "subscribe gets {type, id, reason}");
  off(); const n = evs.length; RT.reservePress("z", "buy", "0xc0in", 1); ok(evs.length === n, "unsubscribe works"); RT.releasePress("z", "cancel"); }
{ CH.D.dec = 6; const G6 = GR.gasReservePerOp(); RT.reservePress("d6", "buy", "0xc", 10);
  ok(RT.pendingCashRaw() === BigInt(10) * E6 + G6 && Math.abs(RS.reservedCash() - (10 + Number(G6) / 1e6)) < 1e-9, "6 dec: raw pending + SITE reservedCash() both right"); RT.releasePress("d6", "cancel"); CH.D.dec = 18; }
ok(/const short = rawLive \? !canSpend\(CASH_RAW\.v!, shotUsd, gasKindFor\("buy", shotUsd, gradRef\.current, markRef\.current\.mcap\)\)/.test(tb) && /CASH_RAW\.v = raw;/.test(tb) && !/usdgDecimals \?\? (6|18)/.test(tb),
  "TradeBridge short check: raw bigint vs the raw balance (decimals from lib/usdg, none hard-coded)");
{ const i = tb.indexOf("window.__discipleTrade = async"), c = tb.indexOf("!canSpend(CASH_RAW.v, usd, kind)", i), a = tb.indexOf("await ", i);
  ok(c > i && c < a, "TradeBridge: raw cash check on top of pending presses at entry, before any await"); }
ok(/detail: \{ usd, gasPerOpUsd: gasUsd\(\) \}/.test(tb), "TradeBridge pushes the per-op gas reserve to the engine with disciple:cash");
ok(/void warmGasPrice\(pc\);/.test(tb) && tb.indexOf("void warmGasPrice(pc)") > tb.indexOf("const poll = async"), "TradeBridge warms the live gas price in the cash poll (off the trade path)");
{ RT.reservePress("dg", "sell", "0xc"); ok(RS.RESERVATIONS.get("dg").gasReserve === GR.gasReservePerOp("trade"), "DUMP: no explicit gasReserve passed — SITE's gasSource() (01b27d97: both sides) holds one trade op's gas"); RT.releasePress("dg", "cancel");
  const rp = rd("lib/flight/rapidTap.ts"); const fn = rp.slice(rp.indexOf("export function reservePress"), rp.indexOf("export function reservePressTokens"));
  ok(/kind === "gradBuy" \? \{ gasReserve: gasReservePerOp\("gradBuy"\) \} : \{\}/.test(fn) && !/gasReservePerOp\(\)/.test(fn), "reservePress passes gasReserve only for a gradBuy BOOST (never for DUMPs)");
  ok(/const kind = gasKindFor\(side, usd, gradRef\.current, markRef\.current\.mcap\);/.test(tb) && /reservePress\(pressId, side, token, side === "buy" \? usd : undefined, kind\)/.test(tb), "TradeBridge: gas kind from the preview at entry (sync) → canSpend + reservePress");
  ok(/gradRef\.current = \{ usd, graduates: b\.graduates, mcapAfterUsd: b\.mcapAfterUsd, venue: b\.venue \}/.test(tb), "gas-kind hint = the warm buy preview (graduates / mcapAfter / venue)"); }
console.log("— pressId (FLOW #145)");
ok(/reservationId: pressId, pressId \}/.test(tb), "client.buy/sell params carry pressId (same value as reservationId)");
ok(/bookReceipt\(r\.txHash, side, rp, bag, logs\)/.test(tb) && /bookReceipt\(r\.txHash, side, rp, bag\)/.test(tb) && /const rp = r\.pressId \?\? pressId;/.test(tb), "bookReceipt(r.txHash, side, r.pressId) (press id fallback when the stack doesn't return it)");
ok(/"disciple:fillreceipt", \{ detail: \{ txHash: hash, side, \.\.\.\(pressId \? \{ pressId \} : \{\}\)/.test(tb), "disciple:fillreceipt detail carries pressId");
ok(/const mine = !d\?\.pressId \|\| d\.pressId === linePress\.current;/.test(tb) && /d\?\.phase === "submitted" && mine/.test(tb) && /linePress\.current = pressId;/.test(tb), "disciple:op → press by pressId (untagged = legacy)");
ok(/marks\.byPress\(rp\) \?\? marks\.byTx\(r\.txHash\)/.test(tb), "timing marks by pressId, txHash fallback");
ok(!/GAS_RESERVE_COLD|\b10 \* |BigInt\(10\) \* BigInt\(10\) \*\* /.test(rd("lib/flight/gasReserve.ts")), "gasReserve.ts: no flat 10 USDG cold constant");

console.log("— 4. DUMP % sizes from unreserved tokens");
{ const bal = BigInt(1000) * BigInt(10) ** BigInt(18), C = "0xC0in";
  const half = (b) => b / BigInt(2);   // sellAmountFor(bal, {frac:0.5})
  RT.reservePress("s1", "sell", C); const a1 = half(RT.unreservedTokens(bal, C)); RT.reservePressTokens("s1", C, a1);
  RT.reservePress("s2", "sell", C); const a2 = half(RT.unreservedTokens(bal, C)); RT.reservePressTokens("s2", C, a2);
  ok(a1 + a2 === bal * BigInt(3) / BigInt(4), "50 % then 50 % (both in flight) = 75 % of the bag");
  ok(RS.reservedTokens(C.toLowerCase()) === a1 + a2, "reservedTokens(coin) is case-insensitive, sums pending sells");
  RT.reservePress("s3", "sell", C); RT.reservePressTokens("s3", C, RT.unreservedTokens(bal, C));
  ok(RT.unreservedTokens(bal, C) === BigInt(0), "DUMP ALL then: only the unreserved quarter; nothing left after");
  ok(RT.pendingCashRaw() === BigInt(3) * G && RS.RESERVATIONS.get("s1").side === "dump", "pending sells hold one op's gas each in cash (USDG gas), SITE side 'dump'");
  for (const id of ["s1", "s2", "s3"]) RT.releasePress(id, "cancel"); }
{ const i = tb.indexOf("const free = unreservedTokens(bal, token);"), j = tb.indexOf("reservePressTokens(pressId, token, amountIn);");
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
for (const [f, src] of [["reservationsShim", rd("lib/flight/reservationsShim.ts")], ["gasReserve", rd("lib/flight/gasReserve.ts").replace(/export function warmGasPrice[\s\S]*?\n\}\n/, "")]])
  ok(!/\bawait\b|\basync\b/.test(src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")), `${f}.ts: no async / await (sync in the trade path)`);
{ const rt = rd("lib/flight/rapidTap.ts");
  ok(!/\bawait\b|\basync\b/.test(rt.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")), "rapidTap.ts: sync (no async / await at all)");
  const rs = [RT.reservePress("x-sync", "sell", "0xc"), RT.reservePressTokens("x-sync", "0xc", BigInt(1)), RT.spendableRaw(E18), RT.canSpend(E18, 1), RT.unreservedTokens(E18, "0xc"), RT.releasePress("x-sync", "cancel")];
  ok(rs.every((x) => !(x instanceof Promise)), "reservePress / reservePressTokens / spendableRaw / canSpend / unreservedTokens / releasePress return synchronously"); }
ok(!/\bawait\b/.test(block("/* @rapidtap —", "/* @rapidtap-end */")), "engine @rapidtap: sync");
ok(RT.tradeErrorCopy({ ok: false, code: "rate_limited", retryAfterMs: 800, reason: "x" }) === "Slow down", "code rate_limited → 'Slow down'");
ok(RT.tradeErrorCopy({ ok: false, code: "spend_limit", reason: "x" }) === "Spend limit reached", "code spend_limit → 'Spend limit reached'");
ok(RT.tradeErrorCopy({ ok: false, reason: "HTTP 429 Too Many Requests" }) === "Slow down" && RT.tradeErrorCopy({ ok: false, reason: "SpendCapExceeded()" }) === "Spend limit reached", "fallback string match (no code yet)");
ok(RT.tradeErrorCopy({ ok: false, reason: "That didn't go through. Try again." }) === "That didn't go through. Try again.", "other reasons pass through");
ok(/if \(!r\.ok\) r\.reason = tradeErrorCopy\(/.test(tb), "TradeBridge maps the trade result's reason through tradeErrorCopy");
ok(RT.tradeErrorCode({ code: "rate_limited", retryAfterMs: 500 }) === "rate_limited" && RT.tradeErrorCode({ errorCode: "spend_limit" }) === "spend_limit" && RT.tradeErrorCode({ code: "pending_unknown" }) === "pending_unknown" && RT.tradeErrorCode(new Error("x")) === undefined, "tradeErrorCode mirrors SITE's (incl. pending_unknown) (ProtocolError.code / TradeResult.errorCode)");
ok(RT.tradeErrorCopy({ ok: false, errorCode: "spend_limit", reason: "x" }) === "Spend limit reached", "TradeResult.errorCode → copy");
ok(/reservationId: pressId/.test(tb), "TradeParams.reservationId = the press id (SITE #144: else counted twice)");

console.log("— 7. AUDIT: pending_unknown (SITE #144 01b27d97) is not a failure");
ok(RT.isPendingUnknown({ code: "pending_unknown" }) && RT.isPendingUnknown({ ok: false, errorCode: "pending_unknown" }), "ProtocolError.code / TradeResult.errorCode 'pending_unknown' = still confirming");
ok(!RT.isPendingUnknown({ code: "Timeout", message: "Still confirming. Check back in a moment." }) && !RT.isPendingUnknown({ ok: false, reason: "timed out" }), "no 'Timeout' / string matching: only SITE's typed code");
ok(RT.tradeErrorCopy({ ok: false, errorCode: "pending_unknown", reason: "x" }) === "Still confirming your last trade…" && RT.COPY.confirming === "Still confirming your last trade…", "copy = SITE's placeholder \"Still confirming your last trade…\"");
{ const site = fs.existsSync("/workspace/wt-rapid-tap/web/lib/aa/relayOp.ts") ? fs.readFileSync("/workspace/wt-rapid-tap/web/lib/aa/relayOp.ts", "utf8") : null;
  if (site) ok(site.includes(`PENDING_UNKNOWN_MSG = "${RT.COPY.confirming}"`), "= SITE relayOp PENDING_UNKNOWN_MSG"); }
const tick = () => new Promise((x) => setImmediate(x));
const C7 = "0xc7";
const unknownPress = (id) => { RT.reservePress(id, "buy", C7, 10); RS.RESERVATIONS.markUnknown(id, { userOpHash: "0x" + "ab".repeat(32), nonce: BigInt(7) }); };
{ unknownPress("u1"); const before = RT.pendingCashRaw();
  ok(RT.releasePress("u1", "error") === false && RT.releasePress("u1", "timeout") === false && RS.RESERVATIONS.has("u1"), "pending_unknown: GAME's release is refused, the hold stays");
  ok(RT.pendingCashRaw() === before && before >= BigInt(10) * E18 && RS.unknownCount() === 1 && RS.isPendingUnknown("u1"), "…and still counts against cash (isPendingUnknown / unknownCount)");
  let out; RT.awaitResolution("u1").then((x) => { out = x; }); await tick();
  ok(out === undefined, "awaitResolution waits for SITE's watcher");
  RS.RESERVATIONS.resolveUnknown("u1", "filled", { txHash: "0xfeed", amountOut: BigInt(123) }); await tick();
  ok(out?.outcome === "filled" && out.txHash === "0xfeed" && out.amountOut === BigInt(123) && !RS.RESERVATIONS.has("u1"), "pending_unknown → resolved filled (txHash, amountOut) → release: a fill"); }
{ unknownPress("u2"); let out; RT.awaitResolution("u2").then((x) => { out = x; });
  RS.RESERVATIONS.resolveUnknown("u2", "error"); await tick();
  ok(out?.outcome === "error" && !RS.RESERVATIONS.has("u2"), "pending_unknown → resolved error: definite failure"); }
{ unknownPress("u3"); let out; RT.awaitResolution("u3").then((x) => { out = x; });
  RS.RESERVATIONS.resolveUnknown("u3", "filled", {}); await tick();
  ok(out?.outcome === "filled" && out.amountOut === undefined && out.txHash === undefined, "release with no amountOut (nonce moved, log not found) = filled, booked from a balance re-read"); }
{ unknownPress("u4"); let out; RT.awaitResolution("u4").then((x) => { out = x; });
  RS.RESERVATIONS.clear(); await tick(); ok(out?.outcome === "gone", "hold force-cleared (logout) ⇒ 'gone' (calm)"); }
{ let out; RT.awaitResolution("never-held").then((x) => { out = x; }); await tick(); ok(out?.outcome === "gone", "not held when we look ⇒ 'gone' (never hangs)"); }
{ const evs = []; const off = RS.subscribe((e) => evs.push(e.type)); unknownPress("u5"); RS.RESERVATIONS.resolveUnknown("u5", "filled", { txHash: "0x1" }); off();
  ok(evs.join(",") === "reserve,unknown,resolved,release", "SITE event order: reserve → unknown → resolved → release"); }
// engine: pending_unknown → hover; then late fill / definite fail
for (const lateOk of [true, false]) { const E = engine({ live: true, cash: 1000 }); E.trade("buy"); const p = E.S.pending[0], ba = p.ba;
  let resolveLate; const late = new Promise((r) => { resolveLate = r; });
  await E.settle(0, { ok: false, pending: true, reason: "Still confirming your last trade…", late });
  ok(E.S.pending.length === 1 && p.state === "pending" && p.unknown === 1 && ba.st !== "fail" && E.thrust.length === 0, `pending_unknown${lateOk ? " (→ resolved fill)" : " (→ resolved fail)"}: still pending, rocket still hovering, no thrust`);
  ok(E.S.flashes.some((f) => f.txt === "Still confirming your last trade…") && !E.S.flashes.some((f) => /didn't go through/.test(f.txt)) && !E.S.feed.some((r) => r.err), "pending_unknown: calm \"Still confirming your last trade…\", no failure copy / row");
  E.at(31000); E.trade("buy"); ok(E.inflight().at(-1).n >= 1 && E.S.pending.includes(p), "pending_unknown: the press keeps its slot (counts toward the 3)");
  resolveLate(lateOk ? { ok: true, txHash: "0xlate", lateFill: true, fillUsd: 9.9 } : { ok: false, reason: "That didn't go through. Try again." }); for (let i = 0; i < 4; i++) await tick();
  if (lateOk) ok(p.state === "confirmed" && ba.st === "ok" && E.thrust.length === 1 && E.events.some((e) => e.type === "disciple:paperfill" && e.detail.txHash === "0xlate") && !E.S.pending.includes(p), "resolved fill: a normal fill (completes, thrust, booked by txHash)");
  else ok(p.state === "failed" && ba.st === "fail" && E.thrust.length === 0 && E.S.flashes.some((f) => /didn't go through/.test(f.txt)) && !E.S.pending.includes(p), "resolved fail: eases back, \"That didn't go through.\""); }
{ const E = engine({ live: true, cash: 1000 }); E.trade("buy"); const p = E.S.pending[0]; const n0 = E.S.flashes.length;
  await E.settle(0, { ok: false, pending: true, late: Promise.resolve({ ok: false, unknown: true }) }); for (let i = 0; i < 4; i++) await tick();
  ok(!E.S.pending.includes(p) && !E.S.flashes.some((f) => /didn't go through/.test(f.txt)) && !E.S.feed.some((r) => r.err), "hold gone without an outcome: calm, no failure copy / row"); }
{ const BA = new Function("clamp", "S", block("/* @boostanim", "/* @boostanim-end */") + "\nreturn {baStart,baOffset};")(clamp, { pending: [] });
  const L = []; const e = BA.baStart(L, 0, 1, 0); e.unk = 1;
  ok(BA.baOffset(L, 0, 45000) > 0.69 && e.st !== "fail", "@boostanim: a pending_unknown send keeps hovering past the 30 s stale guard (SITE watches ≤ 2 min)"); }
ok(/if \(isPendingUnknown\(e\)\) return pendingUnknown\(\);/.test(tb) && /if \(!r\.ok && isPendingUnknown\(r\)\) return pendingUnknown\(\);/.test(tb), "TradeBridge: a thrown / returned pending_unknown goes to the hover path, not the failure copy");
ok(/awaitResolution\(pressId\)/.test(tb) && /if \(!keep\) \{/.test(tb) && /out\.outcome === "filled"[\s\S]{0,600}bookReceipt\(out\.txHash, side, pressId, bag\)/.test(tb) && /out\.outcome === "error"\) \{ setLast\(`✕ \$\{REJECTED\}`\)/.test(tb),
  "TradeBridge: no release on pending_unknown; resolved fill booked from its receipt, resolved error = REJECTED");
ok(/disciple:livetrade/.test(tb.slice(tb.indexOf("const pendingUnknown"), tb.indexOf("// pending-trade state"))), "TradeBridge: a late fill re-reads balances (no amountOut ⇒ booked from the re-read)");
{ const src = [rd("lib/flight/rapidTap.ts"), tb, block("/* @rapidtap —", "/* @rapidtap-end */")].map((x) => x.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")).join("\n");
  ok(!/["']Timeout["']|timed\? \?out|Couldn't confirm|watchOutcome|isUnknownOutcome|LATE_POLL/.test(src), "no 'Timeout' string checks / own receipt watcher / 'Couldn't confirm yet' left (SITE's watcher owns it)"); }

fs.rmSync(tmp, { recursive: true, force: true });
if (bad) { console.log(`\n${bad} rapid-tap check(s) FAILED`); process.exit(1); }
console.log("\nall rapid-tap checks passed");
