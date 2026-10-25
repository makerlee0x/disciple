// Live trading fixes (game/live-trading-fixes): one check group per fix.
//   1. simulated market OFF by default; never on a live market (wallet / real coin / live pool); stale localStorage cleared
//   2. holders from REAL balances (/api/holders adapter, balanceOf fallback), `mine` row, pool/curve/locker labelled
//   3. realized PnL from decoded receipt logs (UsdgTrade / Trade), optimistic estimate reconciled when the receipt lands
//   4. DUMP ALL / % sells size from the smart account's fresh balanceOf (engine opt.all → frac 1, bridge → whole balance)
// Evaluates the engine's own @sim / @trade blocks and DiscipleSource with stubs, plus the lib modules (transpiled).
//   Run: node scripts/test-live-fixes.mjs
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { encodeAbiParameters, encodeEventTopics, decodeEventLog } from "viem";
import { loadLib } from "./lib/load-ts.mjs";
const dir = path.dirname(fileURLToPath(import.meta.url)), web = path.join(dir, "..");
let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const eng = fs.readFileSync(path.join(web, "public/flight/engine.js"), "utf8");
const block = (a, b) => { const i = eng.indexOf(a), j = eng.indexOf(b); if (!(i > 0 && j > i)) throw new Error("engine block " + a); return eng.slice(i, j); };
const { mods, cleanup } = await loadLib(["config", "pnl", "flight/fills", "holders", "flight/holders", "flight/liveSell", "abi/DiscipleRouter", "abi/BondingCurve", "abi/DiscipleHook"], "livefix-");
const pnl = mods.pnl, fills = mods["flight/fills"], H = mods["flight/holders"], LS = mods["flight/liveSell"];
const { discipleRouterAbi } = mods["abi/DiscipleRouter"], { bondingCurveAbi } = mods["abi/BondingCurve"], { discipleHookAbi } = mods["abi/DiscipleHook"];

// ───────────── Fix 1: simulated market ─────────────
class DiscipleSource {} class PoolLiveSource {} class MockReplaySource {}
function simEnv({ src = "disciple", ls = {}, q = "", wallet = false } = {}) {
  const store = new Map(Object.entries(ls)), L = {}, out = [];
  const source = src === "disciple" ? new DiscipleSource() : src === "pool" ? new PoolLiveSource() : src === "sim" ? Object.assign(new MockReplaySource(), { isSim: true }) : new MockReplaySource();
  const window = wallet ? { __discipleTrade: () => {} } : {};
  class CE { constructor(type, o) { this.type = type; this.detail = o && o.detail; } }
  const env = { Q: new URLSearchParams(q), source, DiscipleSource, PoolLiveSource, window, CustomEvent: CE,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    addEventListener: (t, f) => { (L[t] = L[t] || []).push(f); }, dispatchEvent: (e) => { out.push(e); (L[e.type] || []).forEach((f) => f(e)); return true; } };
  const r = new Function(...Object.keys(env), block("/* @sim", "/* @sim-end */") + "\nreturn {SIM, simActive, simAvailable, pushSim};")(...Object.values(env));
  return { ...r, store, window, out, emit: (type, detail) => env.dispatchEvent(new CE(type, { detail })) };
}
ok(!/__DISCIPLE_TESTNET\s*\|\|\s*SIM\.realRate/.test(eng), "engine: no testnet / quiet-pool 'auto' sim (was ON by default on testnet)");
{ const E = simEnv({ src: "disciple", ls: { "disciple.sim": "on" } });
  ok(E.SIM.mode === "off" && !E.simActive(), "live coin: stale localStorage disciple.sim='on' ignored → sim OFF");
  ok(!E.store.has("disciple.sim"), "live coin: stale disciple.sim cleared from localStorage");
  ok(E.simAvailable() === false, "live coin: simstate.available=false → pill hidden");
  E.emit("disciple:sim", { mode: "on" }); ok(!E.simActive() && !E.store.has("disciple.sim"), "live coin: a pill/menu 'on' toggle is ignored");
  E.pushSim(); const st = E.out.filter((e) => e.type === "disciple:simstate").pop();
  ok(st && st.detail.on === false && st.detail.available === false, "simstate {on:false, available:false} on a live coin"); }
{ const E = simEnv({ src: "disciple", wallet: true, q: "sim=on" });
  ok(!E.simActive(), "wallet bridge attached (real trading): sim never runs, even with ?sim=on"); }
{ const E = simEnv({ src: "disciple", q: "sim=on" }); ok(E.simActive(), "dev opt-in ?sim=on on a live coin without a wallet: ON"); }
{ const E = simEnv({ src: "pool", ls: { "disciple.sim": "on" } }); ok(!E.simActive() && !E.simAvailable(), "live pool source: sim OFF, no pill"); }
{ const E = simEnv({ src: "mock" }); ok(E.SIM.mode === "off" && !E.simActive() && E.simAvailable(), "mock: default OFF (pill available)");
  E.emit("disciple:sim", { mode: "on" }); ok(E.simActive() && E.store.get("disciple.sim") === "on", "mock: pill opt-in turns it on + persists"); }
{ const E = simEnv({ src: "mock", ls: { "disciple.sim": "auto" } }); ok(!E.simActive() && !E.store.has("disciple.sim"), "legacy 'auto' → OFF (and dropped)"); }
{ const E = simEnv({ src: "mock", ls: { "disciple.sim": "on" } }); ok(E.simActive(), "mock: persisted opt-in still works"); }
{ const E = simEnv({ src: "mock", q: "sim=on" }); ok(E.simActive(), "?sim=on dev opt-in on mock"); }
{ const E = simEnv({ src: "sim", q: "sim=on" }); ok(!E.simActive() && !E.simAvailable(), "/flight/sim SIMULATOR untouched (no display-offset sim)"); }
const fc = fs.readFileSync(path.join(web, "components/FlightCanvas.tsx"), "utf8");
ok(/sim\.available === true && <button/.test(fc) && /available: false \}\)/.test(fc), "FlightCanvas: sim pill only when the engine says available (initially hidden)");

// ───────────── Fix 2: holders from balances ─────────────
const COIN = "0x" + "c0".repeat(20), ME = "0x" + "aa".repeat(20), A = "0x" + "b1".repeat(20), B = "0x" + "b2".repeat(20), CURVE = "0x" + "cc".repeat(20), LOCK = "0x" + "dd".repeat(20), PM = "0x" + "ee".repeat(20);
const e18 = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n, SUP = e18(7e9);
{ const bal = { [ME]: e18(1e8), [A]: e18(5e8), [B]: e18(0), [CURVE]: e18(6e9), [LOCK]: e18(2e8) };
  const calls = [];
  const deps = { fetchJson: async (u) => { calls.push(u); if (u.startsWith("/api/holders")) return { status: 404, json: null };
      return { status: 200, json: { fills: [{ trader: A }, { trader: B }, { trader: A }] } }; },
    balancesOf: async (addrs) => addrs.map((a) => bal[a] ?? 0n), extra: () => [] };
  const snap = await H.fetchHolders(COIN, { me: ME, labels: { [CURVE]: "curve", [LOCK]: "locker", [PM]: "pool" }, totalSupplyRaw: SUP, priceUsd: 1e-5 }, deps);
  ok(calls[0].startsWith(`/api/holders?coin=${COIN}&limit=50`), "adapter asks SITE's /api/holders first");
  ok(snap && snap.source === "balances", "404 → balanceOf fallback over known traders");
  const ranked = snap.rows.filter((r) => !r.label);
  ok(ranked.map((r) => r.address).join() === [A, ME].join(), "ranked by real balance; zero balances dropped");
  ok(ranked.find((r) => r.address === ME)?.mine === true && ranked.filter((r) => r.mine).length === 1, "user's own row is `mine`");
  ok(snap.rows.find((r) => r.address === CURVE)?.label === "curve" && snap.rows.find((r) => r.address === LOCK)?.label === "locker", "curve / locker labelled, not ranked");
  ok(snap.rows.slice(0, 2).every((r) => r.label), "labelled rows on top of the ranked holders (lee 9:19 PM CT)");
  const me = ranked.find((r) => r.mine); ok(near(me.pct, 100 / 70, 1e-3) && near(me.usd, 1e3, 1e-9), "pct of supply + $ at the mark from balances"); }
{ const deps = { fetchJson: async () => ({ status: 200, json: { asOfBlock: 123, holders: [
    { address: A, balance: e18(5e8).toString(), pct: 7.14, usd: 5000, label: null },
    { address: PM, balance: e18(1e9).toString(), pct: 14.28, usd: 1e4, label: "pool" },
    { address: ME.toUpperCase().replace("0X", "0x"), balance: e18(1e8).toString(), pct: 1.43, usd: 1000 } ] } }), balancesOf: async () => { throw new Error("no fallback expected"); } };
  const snap = await H.fetchHolders(COIN, { me: ME, labels: {}, totalSupplyRaw: SUP, priceUsd: 1e-5 }, deps);
  ok(snap.source === "api" && snap.asOfBlock === 123, "API shape {holders:[{address,balance,pct,usd,label}],asOfBlock} consumed");
  ok(snap.rows[0].label === "pool" && snap.rows[1].address === A && snap.rows[2].mine, "API rows: pool label kept (on top), then ranked, mine (case-insensitive)"); }
{ // engine DiscipleSource marks the user's own live-feed swap
  const src = block("class DiscipleSource {", "/* SIMULATOR bridge");
  const L = {}; const env = { Q: new URLSearchParams(""), paperImpact: () => 1, paperFill: () => ({}), isMine: (t) => t === ME, window: {},
    addEventListener: (t, f) => { L[t] = f; }, removeEventListener() {}, setInterval: () => 0, clearInterval() {} };
  const DS = new Function(...Object.keys(env), src + "\nreturn DiscipleSource;")(...Object.values(env));
  const s = new DS(), got = []; s.start((e) => got.push(e));
  L["disciple:event"]({ detail: { type: "Trade", mcapUsd: 1e5, block: 5, side: "buy", usd: 10, trader: ME, txHash: "0x1" } });
  L["disciple:event"]({ detail: { type: "Trade", mcapUsd: 1e5, block: 6, side: "buy", usd: 10, trader: A, txHash: "0x2" } });
  const sw = got.filter((e) => e.t === "swap");
  ok(sw[0].mine === true && sw[1].mine === false, "DiscipleSource: own trade (trader = smart account) → mine; others not"); }
ok(/disciple:holders-real/.test(fs.readFileSync(path.join(web, "lib/flight/workerBridge.ts"), "utf8")), "worker render forwards disciple:holders-real");
ok(/function realHolders\(\)/.test(eng) && /h\?h\.items\.map\(r=>\[r\.who,r\.usd\]\)/.test(eng), "engine KOTH / HOLDERS use real holders when present");

// ───────────── Fix 3: receipt-based PnL ─────────────
const ROUTER = "0x" + "a7".repeat(20), TOKEN = COIN;
const ev = (abi, name, args, address) => {
  const e = abi.find((x) => x.type === "event" && x.name === name);
  const topics = encodeEventTopics({ abi: [e], eventName: name, args });
  const data = encodeAbiParameters(e.inputs.filter((i) => !i.indexed), e.inputs.filter((i) => !i.indexed).map((i) => args[i.name]));
  return { address, topics, data };
};
ok(Object.entries({ usdgTrade: [discipleRouterAbi, "UsdgTrade"], usdgRefund: [discipleRouterAbi, "UsdgRefund"], curveTrade: [bondingCurveAbi, "Trade"], hookTrade: [discipleHookAbi, "Trade"] })
  .every(([k, [abi, n]]) => encodeEventTopics({ abi: abi.filter((x) => x.type === "event" && x.name === n), eventName: n })[0] === fills.TOPIC[k]), "decoder topic0s match the deployed ABIs");
// BUY $50 USDG → 4.9M tokens via the curve (fee $0.5), one refund-free fill; noise: someone else's UsdgTrade in the same receipt
const OTHER = "0x" + "99".repeat(20);
const buyRc = [
  ev(discipleRouterAbi, "UsdgTrade", { trader: OTHER, token: TOKEN, isBuy: true, amountIn: e18(999), amountOut: e18(1), viaCurve: true }, ROUTER),
  ev(bondingCurveAbi, "Trade", { token: TOKEN, trader: ME, isBuy: true, quoteAmt: e18(50), tokenAmt: e18(4.9e6), fee: e18(0.5), snipeFee: 0n, priceBeforeX18: e18(1e-5), priceAfterX18: e18(1.02e-5), impactBps: 200n, mcapAfterUsd: e18(71400) }, CURVE),
  ev(discipleRouterAbi, "UsdgTrade", { trader: ME, token: TOKEN, isBuy: true, amountIn: e18(50), amountOut: e18(4.9e6), viaCurve: true }, ROUTER),
];
ok(decodeEventLog({ abi: discipleRouterAbi, ...buyRc[2] }).args.amountIn === e18(50), "fixture receipt round-trips through viem");
const buy = fills.decodeTradeFill(buyRc, { token: TOKEN, trader: ME, router: ROUTER, usdgDecimals: 18 });
ok(buy && buy.source === "usdg" && buy.side === "buy" && near(buy.usd, 50) && near(buy.tokens, 4.9e6), "UsdgTrade (trader = smart account): USDG in / tokens out exact, other traders ignored");
ok(near(buy.feeUsd, 0.5, 1e-6), "fee $ from the venue Trade fee / quoteAmt");
// graduating buy with a refund
const refRc = [ev(discipleRouterAbi, "UsdgTrade", { trader: ME, token: TOKEN, isBuy: true, amountIn: e18(100), amountOut: e18(8e6), viaCurve: true }, ROUTER),
  ev(discipleRouterAbi, "UsdgRefund", { trader: ME, token: TOKEN, quoteRefund: e18(12), usdgRefund: e18(12) }, ROUTER)];
ok(near(fills.decodeTradeFill(refRc, { token: TOKEN, trader: ME, router: ROUTER, usdgDecimals: 18 }).usd, 88), "UsdgRefund subtracted from the USDG spent");
// SELL 2.45M tokens → $27.0 net (fee $0.27)
const sellRc = [ev(bondingCurveAbi, "Trade", { token: TOKEN, trader: ME, isBuy: false, quoteAmt: e18(27), tokenAmt: e18(2.45e6), fee: e18(0.27), snipeFee: 0n, priceBeforeX18: e18(1.12e-5), priceAfterX18: e18(1.1e-5), impactBps: 100n, mcapAfterUsd: e18(77000) }, CURVE),
  ev(discipleRouterAbi, "UsdgTrade", { trader: ME, token: TOKEN, isBuy: false, amountIn: e18(2.45e6), amountOut: e18(27), viaCurve: true }, ROUTER)];
const sell = fills.decodeTradeFill(sellRc, { token: TOKEN, trader: ME, router: ROUTER, usdgDecimals: 18 });
ok(sell.side === "sell" && near(sell.usd, 27) && near(sell.tokens, 2.45e6) && near(sell.feeUsd, 0.27, 1e-6), "sell: tokens in / USDG out exact");
// native path (no router event): curve Trade only; $ from mcapAfterUsd (USD per quote raw derived)
const nat = fills.decodeTradeFill([sellRc[0]], { token: TOKEN, trader: ME, router: ROUTER, supply: 7e9, usdgDecimals: 18 });
ok(nat && nat.source === "curve" && near(nat.tokens, 2.45e6) && near(nat.usd, 27, 1e-6), "no UsdgTrade → curve Trade (quoteAmt × $/quote from mcapAfterUsd)");
// hook-only fill priced at the caller's mark
const hk = ev(discipleHookAbi, "Trade", { token: TOKEN, trader: ME, isBuy: false, quoteAmt: e18(27), tokenAmt: e18(2.45e6), fee: e18(0.27), snipeFee: 0n, priceBeforeX18: e18(1.12e-5), priceAfterX18: e18(1.1e-5), impactBps: 100n, sqrtPriceAfter: BigInt(Math.round(Math.sqrt(1.1e-5) * 2 ** 48)) << 48n }, "0x" + "16".repeat(20));
ok(near(fills.decodeTradeFill([hk], { token: TOKEN, trader: ME, markPriceUsd: 1.1e-5, usdgDecimals: 18 }).usd, 27, 1e-6), "hook Trade (sqrtPriceAfter variant) decoded at the mark");
ok(fills.decodeTradeFill([hk], { token: "0x" + "01".repeat(20), trader: ME, markPriceUsd: 1e-5, usdgDecimals: 18 }) === null, "other token's logs → null");
// 6-dec USDG (FLOW #115): priceAfterX18 floors to single digits. Hook: quote/token from sqrtPriceAfter; curve: no native $.
{ const e6 = (x) => BigInt(Math.round(x * 1e6));
  const px = 1.1e-5 * 1e6 / 1e18;                                    // quote raw per token raw at $1.1e-5/token, 6-dec quote
  const hk6 = ev(discipleHookAbi, "Trade", { token: TOKEN, trader: ME, isBuy: false, quoteAmt: e6(27), tokenAmt: e18(2.45e6), fee: e6(0.27), snipeFee: 0n, priceBeforeX18: 11n, priceAfterX18: 11n, impactBps: 100n, sqrtPriceAfter: BigInt(Math.round(Math.sqrt(1 / px) * 2 ** 48)) << 48n }, "0x" + "16".repeat(20));
  const h = fills.decodeTradeFill([hk6], { token: TOKEN, trader: ME, markPriceUsd: 1.1e-5, usdgDecimals: 6 });
  ok(h && near(h.usd, 27, 1e-6) && near(h.feeUsd, 0.27, 1e-6), "6-dec hook Trade: $ from sqrtPriceAfter (currency order inferred), not the floored priceAfterX18");
  const cv6 = ev(bondingCurveAbi, "Trade", { token: TOKEN, trader: ME, isBuy: false, quoteAmt: e6(27), tokenAmt: e18(2.45e6), fee: e6(0.27), snipeFee: 0n, priceBeforeX18: 11n, priceAfterX18: 11n, impactBps: 100n, mcapAfterUsd: e18(77000) }, CURVE);
  ok(fills.decodeTradeFill([cv6], { token: TOKEN, trader: ME, supply: 7e9, usdgDecimals: 6 }) === null, "6-dec curve Trade without UsdgTrade: floored priceAfterX18 ⇒ no guessed $ (null)");
  const r6 = [cv6, ev(discipleRouterAbi, "UsdgTrade", { trader: ME, token: TOKEN, isBuy: false, amountIn: e18(2.45e6), amountOut: e6(27), viaCurve: true }, ROUTER)];
  const s6 = fills.decodeTradeFill(r6, { token: TOKEN, trader: ME, router: ROUTER, usdgDecimals: 6 });
  ok(s6 && s6.source === "usdg" && near(s6.usd, 27) && near(s6.feeUsd, 0.27, 1e-6), "6-dec router sell: UsdgTrade exact at 6 dp"); }
// ledger: exact booking
const gas = 0.01;
let p = pnl.applyExactFill(pnl.emptyPosition(), "buy", buy, gas, 1);
ok(near(p.size, 4.9e6) && near(p.costBasis, 50.01), "exact buy: size = tokens received, basis = USDG spent + gas");
const avg = p.costBasis / p.size;
p = pnl.applyExactFill(p, "sell", sell, gas, 2);
ok(near(p.size, 2.45e6) && near(p.costBasis, 25.005), "exact sell closes exactly the tokens sold (half)");
ok(near(p.realized, 27 + 0.27 - 25.005, 1e-9) && near(p.fees, 0.27 + gas, 1e-9), "realized = (USDG out + fee) − basis out; fees = fee + gas");
ok(near(p.costBasis / p.size, avg), "avg entry unchanged by a sell");
// optimistic → reconcile: the estimate (applyFill at a wrong mark) is replaced by the receipt
{ const est = { usd: 50, price: 50 / 3e6, gas, at: 1 };   // optimistic mark way off (3M tokens instead of 4.9M)
  let r = pnl.bookPending(pnl.emptyPosition(), [], { id: "0xbuy", side: "buy", est });
  ok(near(r.pos.size, 50 * (1 - pnl.FEE) / (50 / 3e6)), "optimistic estimate booked immediately");
  r = pnl.bookPending(r.pos, r.pending, { id: "0xsell", side: "sell", est: { usd: 27, price: 1.1e-5, gas, at: 2, frac: 0.5 } });
  const r2 = pnl.reconcileFill(r.pending, "0xbuy", buy);
  ok(r2 && near(r2.pending[0].before.size, 4.9e6) && r2.pending.length === 1, "buy receipt: rebuilt from its `before`, later pending sell replayed on top");
  const r3 = pnl.reconcileFill(r2.pending, "0xsell", sell);
  ok(r3 && r3.pending.length === 0 && near(r3.pos.size, 2.45e6) && near(r3.pos.realized, 27 + 0.27 - 25.005, 1e-9), "both receipts in: ledger == exact booking, pending empty");
  ok(pnl.reconcileFill([], "0xnope", buy) === null, "unknown txHash → null (HUD keeps it as an early receipt)"); }
// paper keeps curve-average booking
{ const q = pnl.applyFill(pnl.emptyPosition(), "buy", 50, 1e-5, gas, 1); ok(near(q.size, 50 * (1 - pnl.FEE) / 1e-5), "paper/sim: applyFill (curve-average) unchanged"); }
const hud = fs.readFileSync(path.join(web, "components/PnlHud.tsx"), "utf8"), tb = fs.readFileSync(path.join(web, "components/TradeBridge.tsx"), "utf8");
ok(/disciple:fillreceipt/.test(hud) && /disciple:fillreceipt/.test(tb) && /txHash:live\?r\.txHash/.test(eng), "wiring: engine paperfill carries txHash → TradeBridge receipt → PnlHud reconcile");

// ───────────── Fix 4: dump real balance ─────────────
{ const bal = 123_456_789_000_000_000_000_001n;
  ok(LS.sellAmountFor(bal, { all: true }) === bal && LS.sellAmountFor(bal, { frac: 1 }) === bal, "DUMP ALL sells the exact balanceOf (no 1e-6 rounding dust)");
  ok(LS.sellAmountFor(bal, { frac: 0.25 }) === LS.sellAmount(bal, 0.25), "% sell = frac of the real balance");
  let reads = 0; const b1 = await LS.freshSellBalance(async () => { reads++; return 500n; }, async () => 900n, 0, 1e9, async () => {});
  ok(b1 === 500n && reads === 1, "stale cached hint (no recent own trade) → fresh balanceOf wins");
  reads = 0; const b2 = await LS.freshSellBalance(async () => (++reads === 1 ? 0n : 0n), async () => 700n, 1e9 - 2000, 1e9, async () => {});
  ok(b2 === 700n && reads === 2, "lagging node right after our own buy: re-read once, then trust the receipt-bumped cache");
  const b3 = await LS.freshSellBalance(async () => 700n, async () => { throw new Error("x"); }, 0, 1e9, async () => {});
  ok(b3 === 700n, "no cache → fresh balanceOf"); }
ok(/freshSellBalance\(\(\) => ownBalance\(pc, token as Address, me, \(\) => tokenBalance\(/.test(tb), "TradeBridge: sells size from a fresh tokenBalance (balanceOf) read (through the own-balance ledger: never a stale pre-fill value)");
{ // engine trade(): live DUMP ALL → frac 1 to the bridge, not blocked by the fuelers stack / MIN_SHOT
  function tradeEnv({ live, liveTokens = 0, hold = { tokens: 0, valueUsd: 0 }, fuel = 0 }) {
    const E = { submits: [], flashes: [] };
    const S = { fuelers: { you: fuel }, hold, liveBag: live ? { tokens: liveTokens } : null, flashes: E.flashes, mode: 2, balance: 0, confirmed: { mcap: 7e4 }, promoLeft: 0 };
    const env = { S, MODES: [1, 2, 3].map((u) => ({ usd: u })), hasTokens: () => true, noTokens() {}, isLive: () => live, markMcap: () => 7e4, source: { supply: 7e9 },
      MIN_SHOT: 0.5, PROMO_GAS: false, GAS_USD: 0.01, applyThrust() {}, srcImpact: () => 1, fmtShot: String, window: live ? { __discipleTrade() {} } : {},
      submit: (side, usd, force, opt) => E.submits.push({ side, usd, opt }) };
    E.trade = new Function(...Object.keys(env), block("/* @trade", "/* @trade-end */") + "\nreturn trade;")(...Object.values(env));
    return E; }
  let E = tradeEnv({ live: true, liveTokens: 1e6 });   // $10 at mcap 70K / 7B
  E.trade("sell", { usd: 0.01, frac: 1, all: true });
  ok(E.submits.length === 1 && E.submits[0].opt.frac === 1 && near(E.submits[0].usd, 10), "live DUMP ALL: frac 1 of the real bag ($ from balanceOf × mark), no 'NO PAPER STACK'");
  E = tradeEnv({ live: true, liveTokens: 10 });         // dust ($0.0001): still goes out
  E.trade("sell", { usd: 0.01, frac: 1, all: true });
  ok(E.submits.length === 1 && !E.flashes.some((f) => /NO PAPER STACK|BELOW MIN/.test(f.txt)), "live DUMP ALL never blocked by the session fuelers stack / MIN_SHOT");
  E = tradeEnv({ live: true, liveTokens: 1e7 }); E.trade("sell", { usd: 0.01, frac: 0.25 });
  ok(E.submits.length === 1 && near(E.submits[0].usd, 25) && E.submits[0].opt.frac === 0.25, "live 25% sell: $ from the real balance (was $0.01 placeholder → MIN_SHOT block)");
  E = tradeEnv({ live: false, hold: { tokens: 5e6, valueUsd: 50 } }); E.trade("sell", { all: true });
  ok(E.submits.length === 1 && E.submits[0].opt.frac === 1 && near(E.submits[0].usd, 50), "paper DUMP ALL: whole ledger bag");
  E = tradeEnv({ live: false }); E.trade("sell", { all: true });
  ok(E.submits.length === 0 && E.flashes.some((f) => /NO PAPER STACK/.test(f.txt)), "paper DUMP ALL with nothing held: refused"); }
ok(/all:!!d\.all/.test(eng) && /p\.frac >= 1 \? \{ all: true \}/.test(tb), "100% / DUMP ALL reaches the engine as opt.all");

cleanup();
console.log(bad ? `\n${bad} FAILED` : "\nall live-fix checks passed");
process.exit(bad ? 1 : 0);
