// SIMULATOR parity test: fails if the sim's tier ladder / launch params drift from the live game's sources of truth.
//   contracts/src/libraries/Constants.sol  (read-only here: supply, curve %, start/graduation mcap, wallet cap,
//                                           anti-snipe, trade fee, tier ladder numbers in order)
//   contracts/src/TrampWallManager.sol     (default keeper tip)
//   lib/config.ts CURVE + TIERS, lib/curveMath.ts TRADE_FEE_BPS + quoteBuy/quoteSell, lib/flight/tiers.ts FLIGHT_TIERS,
//   contracts/src/libraries/FloorBands.sol (graduation floor band weights)
//   public/flight/engine.js (start / floor / graduation mcap, curve %, paper wallet cap, generated tier block)
//   vs lib/sim/config.ts LAUNCH + TIERS, lib/sim/pool.ts FLOOR and lib/sim/market.ts (the steep curve itself, against
//   curveMath's bigint mirror incl. the g^30 tail).
// Constants.sol tier NAMES are the legacy constitution names; only the numbers (lo/hi, in order) are compared.
// Run: node scripts/test-sim-parity.mjs   (also part of `npm run test:flightdata`)
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { loadLib } from "./lib/load-ts.mjs";
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), repo = path.resolve(web, "..");
let bad = 0; const ok = (c, m) => { if (c) console.log("ok   " + m); else { bad++; console.error("FAIL " + m); } };
const { mods, cleanup } = await loadLib(undefined, "parity-");
const { CURVE, TIERS: CFG_TIERS } = mods["config"], CM = mods["curveMath"], { FLIGHT_TIERS, tierIndexAt } = mods["flight/tiers"];
const { LAUNCH, TIERS: SIM_TIERS, tierOf, cloneConfig, mergeTune, SIM_STORAGE } = mods["sim/config"], { Market } = mods["sim/market"], { FLOOR, floorBandRanges } = mods["sim/pool"];

// ---- Constants.sol (parsed, numbers only; 1e18-scaled values are de-scaled) ----
const sol = fs.readFileSync(path.join(repo, "contracts/src/libraries/Constants.sol"), "utf8");
const C = {}; for (const m of sol.matchAll(/constant\s+(\w+)\s*=\s*([\d_]+)(\s*\*\s*1e18)?\s*;/g)) C[m[1]] = Number(m[2].replace(/_/g, ""));
const need = ["TOTAL_SUPPLY", "CURVE_SOLD_BPS", "START_MCAP_USD", "CURVE_MID_MCAP_USD", "GRADUATION_MCAP_USD", "MAX_FLOOR_BANDS", "FLOOR_FLAT_BANDS", "FLOOR_FLAT_SPACINGS", "FLOOR_BOTTOM_SPACINGS", "FLOOR_FLAT_BPS", "WALLET_CAP_BPS", "WALLET_CAP_BPS_DEFAULT", "ANTI_SNIPE_START_BPS", "ANTI_SNIPE_END_BPS", "ANTI_SNIPE_DURATION", "TRADE_FEE_BPS"];
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
eq(Math.round(CURVE.antiSnipeStartPct * 100), C.ANTI_SNIPE_START_BPS, "anti-snipe start  config ⇄ Constants"); eq(LAUNCH.antiSnipeStartBps, C.ANTI_SNIPE_START_BPS, "anti-snipe start  sim ⇄ Constants");
eq(CURVE.antiSnipeWindowSec, C.ANTI_SNIPE_DURATION, "anti-snipe window  config ⇄ Constants"); eq(LAUNCH.antiSnipeDurationS, C.ANTI_SNIPE_DURATION, "anti-snipe window  sim ⇄ Constants");
eq(C.ANTI_SNIPE_END_BPS, 0, "anti-snipe ends at 0 (sim decays to 0)");
// anti-snipe schedule: one source (lib/config CURVE → sim LAUNCH → Market.antiSnipe), linear 99% → 0 over 77 s, buys only, curve only
{ const AS0 = C.ANTI_SNIPE_START_BPS / 10_000, D = C.ANTI_SNIPE_DURATION, m = new Market(cloneConfig());
  const pts = [[0, AS0], [D / 2, AS0 / 2], [D - 1, AS0 / D], [D, 0], [D + 60, 0]], off = pts.filter(([t, v]) => Math.abs(m.antiSnipe(t) - v) > 1e-12);
  ok(!off.length, `sim anti-snipe ${AS0 * 100}% → 0 linear over ${D} s (t=0,${D / 2},${D - 1},${D},${D + 60})${off.length ? " differs at t=" + off.map((x) => x[0]).join(",") : ""}`);
  ok(!/antiSnipe/.test(m.sell.toString()), "Market.sell does not read the anti-snipe clock (buys only)");
  // every written schedule in GAME's sim + engine sources (comments included) must match Constants — catches stale "7 s" / "77.7%"
  const files = ["lib/sim/market.ts", "lib/sim/run.ts", "lib/sim/config.ts", "public/flight/engine.js", "scripts/test-sim.mjs"], stale = [];
  for (const f of files) { const src = fs.readFileSync(path.join(web, f), "utf8").split("\n");
    src.forEach((ln, i) => { if (!/snipe|sniper tax/i.test(ln)) return;
      for (const mm of ln.matchAll(/(\d+(?:\.\d+)?)\s*%\s*(?:→|->|to)\s*0%?/g)) if (+mm[1] !== AS0 * 100) stale.push(`${f}:${i + 1} ${mm[0]}`);
      for (const mm of ln.matchAll(/(\d+(?:\.\d+)?)\s*(?:s|sec|seconds)\b(?=[^a-z]*(?:anti-snipe|sniper tax|tax))|over\s+(\d+(?:\.\d+)?)\s*s\b|\((\d+(?:\.\d+)?)\s*s\)/gi)) { const v = +(mm[1] ?? mm[2] ?? mm[3]); if (v !== D) stale.push(`${f}:${i + 1} ${mm[0]}`); } }); }
  ok(!stale.length, `anti-snipe prose in ${files.length} GAME files says ${AS0 * 100}% → 0 over ${D} s${stale.length ? " — stale: " + stale.join(" | ") : ""}`);
  eq(/ANTI_SNIPE|antiSnipe/.test(fs.readFileSync(path.join(web, "public/flight/engine.js"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), false, "engine.js charges no anti-snipe of its own (live: contract; paper: no launch clock) — nothing to drift"); }
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
ok(FLIGHT_TIERS[0].lo === C.START_MCAP_USD && C.TIER_LAUNCH_PAD_LO_USD === C.START_MCAP_USD, `tier ladder  Launch Pad low ${FLIGHT_TIERS[0].lo} = START_MCAP ${C.START_MCAP_USD} (Constants TIER_LAUNCH_PAD_LO_USD ${C.TIER_LAUNCH_PAD_LO_USD})`);
{ const probes = [0, 3332, 3333, 6999, 7000, 11999, 12000, 32999, 33000, 99_999, 1.2e6, 7.77e9, 1e11]; for (const t of FLIGHT_TIERS) probes.push(t.lo, t.lo - 1, t.hi - 1);
  const off = probes.filter((m) => tierOf(m) !== tierIndexAt(m)); ok(!off.length, `sim tierOf ≡ flight tierIndexAt on ${probes.length} probes${off.length ? " (differs at " + off.join(", ") + ")" : ""}`); }
ok(FLIGHT_TIERS[FLIGHT_TIERS.findIndex((t) => t.lo === CURVE.graduationMcap)] != null, "graduation mcap is a tier boundary (OUTER SPACE)");
const eng = fs.readFileSync(path.join(web, "public/flight/engine.js"), "utf8");
{ const g = eng.match(/const GRADUATION_MCAP\s*=\s*([\d.e]+)/), ft = eng.match(/const FLIGHT_TIERS=(\[.*?\]);/);
  ok(g && +g[1] === C.GRADUATION_MCAP_USD, `engine.js GRADUATION_MCAP ${g && g[1]} ⇄ Constants`);
  const en = (k) => { const m = eng.match(new RegExp(`const ${k}\\s*=\\s*([\\d.e]+)`)); return m ? +m[1] : NaN; };
  eq(en("START_MCAP"), C.START_MCAP_USD, "engine.js START_MCAP  ⇄ Constants START_MCAP_USD");
  eq(en("FLOOR_MCAP"), C.TIER_LAUNCH_PAD_LO_USD, "engine.js FLOOR_MCAP  ⇄ Constants TIER_LAUNCH_PAD_LO_USD");
  eq(en("CURVE_MID_MCAP"), C.CURVE_MID_MCAP_USD, "engine.js CURVE_MID_MCAP  ⇄ Constants CURVE_MID_MCAP_USD");
  eq(Math.round(en("CURVE_SOLD_PCT") * 100), C.CURVE_SOLD_BPS, "engine.js CURVE_SOLD_PCT  ⇄ Constants CURVE_SOLD_BPS");
  ok(C.WALLET_CAP_BPS_DEFAULT === 0 && !/WALLET_CAP_FRAC|paperCap|capFilledUsd/.test(eng), "engine.js: no paper wallet cap (Constants default 0)");
  ok(ft && nums(JSON.parse(ft[1])) === nums(FLIGHT_TIERS), "engine.js generated FLIGHT_TIERS ⇄ lib/flight/tiers"); }

// ---- the sim curve ≡ curveMath (bigint mirror of CurveMath.sol) ----
{ const m = new Market(cloneConfig()), wei = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
  // the sim is a float port of the full steep curve #1 (CP part + g^30 tail): compare with the exact bigint mirror
  const p = CM.paramsFromQuotePrice(10n ** 18n);
  ok(Math.abs(Number(p.sCurve) / 1e18 - m.sC) < 1e-6 && Math.abs(Number(p.tail) / 1e18 - m.T) < 1e-6 * m.T, `sim curve params ≡ CurveMath.makeParams (sCurve ${m.sC}, tail $${m.T.toFixed(2)})`);
  eq(LAUNCH.curveMidMcapUsd, C.CURVE_MID_MCAP_USD, "curve mid mcap  sim ⇄ Constants");
  ok(Math.abs(m.mcap() / LAUNCH.startMcapUsd - 1) < 1e-9, `sim curve starts at $${m.mcap().toFixed(2)}`);
  let worst = 0; for (const [soldFrac, usd] of [[0, 50], [0.1, 300], [0.4, 1000], [0.7, 2500], [0.95, 100]]) {
    const q = new Market(cloneConfig()); q.sold = q.sC * soldFrac; const f = q.buy(usd, 120, 0); // t past the 77s sniper window
    const ref = Number(CM.quoteBuy(p, wei(q.sC * soldFrac), wei(usd), 0n)) / 1e18, eb = Math.abs(f.tokens / ref - 1);
    const s = new Market(cloneConfig()); s.sold = s.sC * Math.max(soldFrac, 0.2); const tk = s.sold * 0.05, sold0 = s.sold, fs2 = s.sell(tk);
    const ref2 = Number(CM.quoteSell(p, wei(sold0), wei(tk), 0n)) / 1e18, es = Math.abs(fs2.usd * (1 - LAUNCH.tradeFeeBps / 1e4) / ref2 - 1);
    if (process.env.DEBUG) console.log(soldFrac, usd, f.tokens, ref, fs2.usd, ref2);
    worst = Math.max(worst, eb, es); }
  ok(worst < 1e-6, `sim curve (steep) buys/sells ≡ curveMath quoteBuy/quoteSell (worst rel. error ${worst.toExponential(1)})`);
  { const full = new Market(cloneConfig()), ref = Number(CM.curveCost(p, 0n, p.sCurve, true)) / 1e18;
    ok(Math.abs(full.reserveAt(1) / ref - 1) < 1e-9, `sim curve reserve at graduation $${full.reserveAt(1).toFixed(4)} ≡ CurveMath $${ref.toFixed(4)}`); }
  const g = new Market(cloneConfig()); g.sold = g.sC * (1 - 1e-12); ok(Math.abs(g.mcap() / LAUNCH.graduationMcapUsd - 1) < 1e-6, `sim curve ends at $${g.mcap().toFixed(0)} (graduation)`); }

// ---- steep curve #1: curveMath ≡ CurveMath.sol (exact bigints from forge test CurveMathSteep, 18-dec + 6-dec USDG) ----
{ const p18 = CM.paramsFromQuotePrice(10n ** 18n), p6 = CM.paramsFromQuotePrice(10n ** 30n);
  eq(CM.marketCapQuote(p18, p18.sCurve), 33_333n * 10n ** 18n, "steep: curve-end mcap = $33,333 exactly (18-dec)");
  eq(CM.marketCapQuote(p6, p6.sCurve), 33_333n * 10n ** 6n, "steep: curve-end mcap = $33,333 exactly (6-dec)");
  eq(CM.curveCost(p18, 0n, p18.sCurve, true), 6454554174215614495292n, "steep: full-curve raise ≡ CurveMath.sol quoteInForTokens (wei-exact)");
  ok(Math.abs(Number(CM.marketCapQuote(p18, 0n)) / 1e18 - 3_333) < 1e-3, "steep: start mcap $3,333");
  let mono = true, last = -1n; for (let i = 0; i <= 200; i++) { const m = CM.marketCapQuote(p18, (p18.sCurve * BigInt(i)) / 200n); if (m <= last) mono = false; last = m; }
  ok(mono, "steep: price strictly increasing over 200 steps");
  let worst = 0n; for (const [s, u] of [[0n, 50n], [100_000n, 300n], [400_000n, 1000n], [700_000n, 2500n], [840_000n, 100n]]) {
    const sold = s * 10n ** 18n, q = u * 10n ** 18n, dt = CM.tokensOutForQuote(p18, sold, q), back = CM.quoteOutForTokens(p18, sold + dt, dt);
    ok(CM.curveCost(p18, sold, sold + dt, true) <= q && back <= q, `steep: $${u} @ ${s / 1000n}K sold → ${(Number(dt) / 1e18).toFixed(2)} tokens, never more than paid, sells back ≤ in`); } }

// ---- graduation floor: sim FLOOR ⇄ Constants.sol + FloorBands.sol ----
{ const fb = fs.readFileSync(path.join(repo, "contracts/src/libraries/FloorBands.sol"), "utf8"), pk = fb.match(/BOTTOM_BPS_PACKED\s*=\s*(0x[0-9a-fA-F]+)/), sp = fb.match(/SPACING\s*=\s*(\d+)/);
  eq(FLOOR.maxBands, C.MAX_FLOOR_BANDS, "floor bands  sim ⇄ Constants MAX_FLOOR_BANDS"); eq(FLOOR.flatBands, C.FLOOR_FLAT_BANDS, "floor flat bands  sim ⇄ Constants");
  eq(FLOOR.flatSpacings, C.FLOOR_FLAT_SPACINGS, "floor flat spacings  sim ⇄ Constants"); eq(FLOOR.bottomSpacings, C.FLOOR_BOTTOM_SPACINGS, "floor bottom spacings  sim ⇄ Constants");
  eq(FLOOR.flatBps, C.FLOOR_FLAT_BPS, "floor flat bps  sim ⇄ Constants"); eq(FLOOR.tickSpacing, sp ? +sp[1] : NaN, "floor tick spacing  sim ⇄ FloorBands.SPACING");
  const n = C.MAX_FLOOR_BANDS - C.FLOOR_FLAT_BANDS, w = pk ? Array.from({ length: n }, (_, j) => Number((BigInt(pk[1]) >> BigInt(16 * j)) & 0xffffn)) : [];
  ok(JSON.stringify(w) === JSON.stringify(FLOOR.bottomBps), `floor bottom weights  sim ⇄ FloorBands.BOTTOM_BPS_PACKED (${w.join(" ")})`);
  ok(w.reduce((a, b) => a + b, 0) + C.FLOOR_FLAT_BPS === 10_000, "floor weights sum to 100%");
  // band split: 4 flat + 12 bottom-heavy, per Constants.sol (read-only) — the sim can't drift from the contract
  ok(C.FLOOR_FLAT_BANDS === 4 && C.MAX_FLOOR_BANDS - C.FLOOR_FLAT_BANDS === 12 && FLOOR.flatBands === C.FLOOR_FLAT_BANDS && FLOOR.bottomBps.length === C.MAX_FLOOR_BANDS - C.FLOOR_FLAT_BANDS,
    `floor split  sim ${FLOOR.flatBands} flat / ${FLOOR.bottomBps.length} bottom ⇄ Constants ${C.FLOOR_FLAT_BANDS} / ${C.MAX_FLOOR_BANDS - C.FLOOR_FLAT_BANDS} (= 4 / 12)`);
  ok(Math.abs(FLOOR.flatBps / FLOOR.flatBands - 750) < 1e-9 && Math.abs(FLOOR.bottomBps[n - 1] / FLOOR.bottomBps[0] - 4) < 0.01, `floor bps  flat ${FLOOR.flatBps / FLOOR.flatBands} each, bottom/top ${(FLOOR.bottomBps[n - 1] / FLOOR.bottomBps[0]).toFixed(3)}× (4× bottom-heavy)`);
  // geometry at graduation: the sim's bands seeded at the curve-end price reach $25K (flat) and the $3,333 bottom
  const g = new Market(cloneConfig()); g.buy(1e9, 1e9, 0); const sv = g.pool.s, rs = floorBandRanges(sv), mc = (x) => x * x * g.S * LAUNCH.quotePriceUsd;
  const flatLo = Math.min(...rs.slice(0, C.FLOOR_FLAT_BANDS).map((r) => r.a)), botLo = Math.min(...rs.map((r) => r.a)), top = Math.max(...rs.map((r) => r.b));
  ok(rs.length === C.MAX_FLOOR_BANDS && Math.abs(mc(top) / C.GRADUATION_MCAP_USD - 1) < 0.01, `floor top  $${mc(top).toFixed(0)} ≈ graduation $${C.GRADUATION_MCAP_USD} (${rs.length} bands)`);
  ok(Math.abs(mc(flatLo) / (0.75 * C.GRADUATION_MCAP_USD) - 1) < 0.01, `floor flat layer bottom  $${mc(flatLo).toFixed(0)} ≈ 0.75 × graduation ($25K)`);
  ok(Math.abs(mc(botLo) / C.START_MCAP_USD - 1) < 0.01, `floor bottom  $${mc(botLo).toFixed(0)} ≈ Constants START_MCAP_USD $${C.START_MCAP_USD.toLocaleString()} (within 1%; ${C.FLOOR_BOTTOM_SPACINGS} spacings × ${FLOOR.tickSpacing} ticks below a tick-aligned base)`); }

cleanup();
if (bad) { console.error(bad + " FAILED"); process.exit(1); } console.log("PASS");
