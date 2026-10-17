// SIMULATOR parity test: fails if the sim's tier ladder / launch params drift from the live game's sources of truth.
//   contracts/src/libraries/Constants.sol  (read-only here: supply, curve %, start/graduation mcap, wallet cap,
//                                           anti-snipe, trade fee, tier ladder numbers in order)
//   contracts/src/TrampWallManager.sol     (default keeper tip)
//   lib/config.ts CURVE + TIERS, lib/curveMath.ts TRADE_FEE_BPS + quoteBuy/quoteSell, lib/flight/tiers.ts FLIGHT_TIERS,
//   public/flight/engine.js (graduation mcap, paper wallet cap, generated tier block)
//   vs lib/sim/config.ts LAUNCH + TIERS and lib/sim/market.ts (the curve itself, against curveMath's bigint mirror).
// Constants.sol tier NAMES are the legacy constitution names; only the numbers (lo/hi, in order) are compared.
// Run: node scripts/test-sim-parity.mjs   (also part of `npm run test:flightdata`)
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { loadLib } from "./lib/load-ts.mjs";
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), repo = path.resolve(web, "..");
let bad = 0; const ok = (c, m) => { if (c) console.log("ok   " + m); else { bad++; console.error("FAIL " + m); } };
const { mods, cleanup } = await loadLib(undefined, "parity-");
const { CURVE, TIERS: CFG_TIERS } = mods["config"], CM = mods["curveMath"], { FLIGHT_TIERS, tierIndexAt } = mods["flight/tiers"];
const { LAUNCH, TIERS: SIM_TIERS, tierOf, cloneConfig, mergeTune, SIM_STORAGE } = mods["sim/config"], { Market } = mods["sim/market"];

// ---- Constants.sol (parsed, numbers only; 1e18-scaled values are de-scaled) ----
const sol = fs.readFileSync(path.join(repo, "contracts/src/libraries/Constants.sol"), "utf8");
const C = {}; for (const m of sol.matchAll(/constant\s+(\w+)\s*=\s*([\d_]+)(\s*\*\s*1e18)?\s*;/g)) C[m[1]] = Number(m[2].replace(/_/g, ""));
const need = ["TOTAL_SUPPLY", "CURVE_SOLD_BPS", "START_MCAP_USD", "GRADUATION_MCAP_USD", "WALLET_CAP_BPS", "WALLET_CAP_BPS_DEFAULT", "ANTI_SNIPE_START_BPS", "ANTI_SNIPE_END_BPS", "ANTI_SNIPE_DURATION", "TRADE_FEE_BPS"];
for (const k of need) ok(Number.isFinite(C[k]), `Constants.sol: ${k} = ${C[k]}`);
const solTiers = []; for (const m of sol.matchAll(/constant\s+TIER_(\w+?)_LO_USD\s*=\s*([\d_]+)\s*;/g)) { const hi = sol.match(new RegExp(`constant\\s+TIER_${m[1]}_HI_USD\\s*=\\s*([\\d_]+)\\s*;`));
  solTiers.push({ key: m[1], lo: Number(m[2].replace(/_/g, "")), hi: hi ? Number(hi[1].replace(/_/g, "")) : NaN }); }
const twm = fs.readFileSync(path.join(repo, "contracts/src/TrampWallManager.sol"), "utf8").match(/keeperTipBps\s*=\s*(\d+)\s*;/);

// ---- launch params: Constants.sol ⇄ lib/config CURVE ⇄ curveMath ⇄ sim LAUNCH ----
const eq = (a, b, m) => ok(a === b, `${m}: ${a} ${a === b ? "=" : "≠"} ${b}`);
eq(CURVE.totalSupply, C.TOTAL_SUPPLY, "total supply  config ⇄ Constants");       eq(LAUNCH.totalSupply, C.TOTAL_SUPPLY, "total supply  sim ⇄ Constants");
eq(Math.round(CURVE.soldPctAtGrad * 100), C.CURVE_SOLD_BPS, "curve sold bps  config ⇄ Constants"); eq(LAUNCH.curveSoldBps, C.CURVE_SOLD_BPS, "curve sold bps  sim ⇄ Constants");
eq(CURVE.startMcap, C.START_MCAP_USD, "start mcap  config ⇄ Constants");          eq(LAUNCH.startMcapUsd, C.START_MCAP_USD, "start mcap  sim ⇄ Constants");
eq(CURVE.graduationMcap, C.GRADUATION_MCAP_USD, "graduation mcap  config ⇄ Constants"); eq(LAUNCH.graduationMcapUsd, C.GRADUATION_MCAP_USD, "graduation mcap  sim ⇄ Constants");
eq(CURVE.walletCapDefaultBps, C.WALLET_CAP_BPS_DEFAULT, "wallet cap default bps  config ⇄ Constants"); eq(LAUNCH.walletCapBps, C.WALLET_CAP_BPS_DEFAULT, "wallet cap  sim ⇄ Constants default (no cap)");
eq(Math.round(CURVE.walletCapPct * 100), C.WALLET_CAP_BPS, "paper wallet cap (config walletCapPct) ⇄ Constants.WALLET_CAP_BPS (max)");
eq(Math.round(CURVE.antiSnipeStartPct * 100), C.ANTI_SNIPE_START_BPS, "anti-snipe start  config ⇄ Constants"); eq(LAUNCH.antiSnipeStartBps, C.ANTI_SNIPE_START_BPS, "anti-snipe start  sim ⇄ Constants");
eq(CURVE.antiSnipeWindowSec, C.ANTI_SNIPE_DURATION, "anti-snipe window  config ⇄ Constants"); eq(LAUNCH.antiSnipeDurationS, C.ANTI_SNIPE_DURATION, "anti-snipe window  sim ⇄ Constants");
eq(C.ANTI_SNIPE_END_BPS, 0, "anti-snipe ends at 0 (sim decays to 0)");
eq(Number(CM.TRADE_FEE_BPS), C.TRADE_FEE_BPS, "trade fee  curveMath ⇄ Constants");  eq(LAUNCH.tradeFeeBps, C.TRADE_FEE_BPS, "trade fee  sim ⇄ Constants");
ok(!!twm, "TrampWallManager.sol: keeperTipBps default found"); if (twm) eq(LAUNCH.keeperTipBps, +twm[1], "keeper tip  sim ⇄ TrampWallManager default");
// a stale saved tuning can never override launch params
{ const t = cloneConfig(); t.launch.walletCapBps = 700; t.launch.graduationMcapUsd = 69_000; const m = mergeTune(t);
  ok(m.launch.walletCapBps === LAUNCH.walletCapBps && m.launch.graduationMcapUsd === LAUNCH.graduationMcapUsd, "mergeTune: saved tuning cannot override launch params"); }
ok(SIM_STORAGE.tw !== "disciple.tw.v1" && SIM_STORAGE.tw.startsWith("disciple.sim."), `sim tramps/walls namespace ${SIM_STORAGE.tw} (not the live disciple.tw.v1)`);

// ---- tier ladder: Constants.sol (numbers) ⇄ lib/flight/tiers ⇄ lib/config TIERS ⇄ sim TIERS ⇄ engine.js ----
const nums = (a) => JSON.stringify(a.map((t) => [t.lo, t.hi]));
ok(solTiers.length === FLIGHT_TIERS.length && nums(solTiers) === nums(FLIGHT_TIERS), `tier ladder numbers  FLIGHT_TIERS ⇄ Constants.sol (${solTiers.length} vs ${FLIGHT_TIERS.length} tiers)`);
ok(JSON.stringify(CFG_TIERS.map((t) => [t.name, t.lo, t.hi])) === JSON.stringify(FLIGHT_TIERS.map((t) => [t.name, t.lo, t.hi])), "tier ladder  lib/config TIERS ⇄ FLIGHT_TIERS");
ok(JSON.stringify(SIM_TIERS.map((t) => [t.name, t.lo])) === JSON.stringify(FLIGHT_TIERS.map((t) => [t.name, t.lo])), "tier ladder  sim TIERS ⇄ FLIGHT_TIERS");
{ const probes = [0, 6999, 7000, 11999, 12000, 32999, 33000, 99_999, 1.2e6, 7.77e9, 1e11]; for (const t of FLIGHT_TIERS) probes.push(t.lo, t.lo - 1, t.hi - 1);
  const off = probes.filter((m) => tierOf(m) !== tierIndexAt(m)); ok(!off.length, `sim tierOf ≡ flight tierIndexAt on ${probes.length} probes${off.length ? " (differs at " + off.join(", ") + ")" : ""}`); }
ok(FLIGHT_TIERS[FLIGHT_TIERS.findIndex((t) => t.lo === CURVE.graduationMcap)] != null, "graduation mcap is a tier boundary (OUTER SPACE)");
const eng = fs.readFileSync(path.join(web, "public/flight/engine.js"), "utf8");
{ const g = eng.match(/const GRADUATION_MCAP\s*=\s*([\d.e]+)/), w = eng.match(/const WALLET_CAP_FRAC\s*=\s*([\d.]+)/), ft = eng.match(/const FLIGHT_TIERS=(\[.*?\]);/);
  ok(g && +g[1] === C.GRADUATION_MCAP_USD, `engine.js GRADUATION_MCAP ${g && g[1]} ⇄ Constants`);
  ok(w && Math.round(+w[1] * 1e4) === C.WALLET_CAP_BPS, `engine.js paper WALLET_CAP_FRAC ${w && w[1]} ⇄ Constants.WALLET_CAP_BPS (paper only)`);
  ok(/const capApplies=m=>!isLive\(\)&&!source\.isSim&&/.test(eng), "engine.js: the paper cap is skipped for the SIMULATOR");
  ok(ft && nums(JSON.parse(ft[1])) === nums(FLIGHT_TIERS), "engine.js generated FLIGHT_TIERS ⇄ lib/flight/tiers"); }

// ---- the sim curve ≡ curveMath (bigint mirror of CurveMath.sol) ----
{ const m = new Market(cloneConfig()), wei = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
  const p = { totalSupply: wei(m.S), sCurve: wei(m.sC), x0: wei(m.x0), y0: wei(m.y0) };
  ok(Math.abs(m.mcap() / LAUNCH.startMcapUsd - 1) < 1e-9, `sim curve starts at $${m.mcap().toFixed(2)}`);
  let worst = 0; for (const [soldFrac, usd] of [[0, 50], [0.1, 300], [0.4, 1000], [0.7, 2500], [0.95, 100]]) {
    const q = new Market(cloneConfig()); q.sold = q.sC * soldFrac; const f = q.buy(usd, 60, 0);
    const ref = Number(CM.quoteBuy(p, wei(q.sC * soldFrac), wei(usd), 0n)) / 1e18, eb = Math.abs(f.tokens / ref - 1);
    const s = new Market(cloneConfig()); s.sold = s.sC * Math.max(soldFrac, 0.2); const tk = s.sold * 0.05, sold0 = s.sold, fs2 = s.sell(tk);
    const ref2 = Number(CM.quoteSell(p, wei(sold0), wei(tk), 0n)) / 1e18, es = Math.abs(fs2.usd * (1 - LAUNCH.tradeFeeBps / 1e4) / ref2 - 1);
    if (process.env.DEBUG) console.log(soldFrac, usd, f.tokens, ref, fs2.usd, ref2);
    worst = Math.max(worst, eb, es); }
  ok(worst < 1e-6, `sim curve buys/sells ≡ curveMath quoteBuy/quoteSell (worst rel. error ${worst.toExponential(1)})`);
  const g = new Market(cloneConfig()); g.sold = g.sC * (1 - 1e-12); ok(Math.abs(g.mcap() / LAUNCH.graduationMcapUsd - 1) < 1e-6, `sim curve ends at $${g.mcap().toFixed(0)} (graduation)`); }

cleanup();
if (bad) { console.error(bad + " FAILED"); process.exit(1); } console.log("PASS");
