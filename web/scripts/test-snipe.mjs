// Sniper-tax countdown helper (lib/snipe.ts): per-second table (= FeeMath.snipeBps), boundaries, live override, old-coin params, clock/chip formatting.
//   Run: node scripts/test-snipe.mjs
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
const dir = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snipe-"));
for (const f of ["snipe", "config"]) {
  const src = fs.readFileSync(path.join(dir, `../lib/${f}.ts`), "utf8").replace(/from "\.\/config"/g, 'from "./config.mjs"');
  fs.writeFileSync(path.join(tmp, f + ".mjs"), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText);
}
const S = await import(pathToFileURL(path.join(tmp, "snipe.mjs")).href);
const { snipeState, snipeParamsFor, snipeFeeBpsAt, formatSnipeClock, formatSnipeChip, formatSnipePct, SNIPE_CHIP_LABEL, STEEP_SNIPE } = S;
const { CURVE } = await import(pathToFileURL(path.join(tmp, "config.mjs")).href);
let fail = 0, n = 0;
const eq = (name, got, want) => { n++; const g = JSON.stringify(got), w = JSON.stringify(want); if (g !== w) { fail++; console.error(`FAIL ${name}: got ${g}, want ${w}`); } };
// Contract: FeeMath.snipeBps(elapsed) = elapsed >= 7 ? 0 : ANTI_SNIPE_TABLE[elapsed], elapsed = whole seconds since launch.
const TABLE = [9900, 2500, 300, 100, 30, 10, 3];
const L = 1_800_000_000, NEW = { startPct: 99, windowSec: 7, bpsBySec: TABLE };
const at = (dt, extra = {}) => snipeState({ launchTs: L, nowSec: L + dt, ...NEW, ...extra });
const pick = (s) => [s.active, s.secondsLeft, s.feePct];

// config mirrors the contract table
eq("CURVE.antiSnipeBpsBySec", [...CURVE.antiSnipeBpsBySec], TABLE);
eq("CURVE.antiSnipeWindowSec", CURVE.antiSnipeWindowSec, 7);
eq("STEEP_SNIPE", { ...STEEP_SNIPE, bpsBySec: [...STEEP_SNIPE.bpsBySec] }, NEW);
// snipeFeeBpsAt = FeeMath.snipeBps
for (let e = 0; e <= 7; e++) eq(`snipeFeeBpsAt(${e})`, snipeFeeBpsAt(e, TABLE), e < 7 ? TABLE[e] : 0);
eq("snipeFeeBpsAt(1.5) floors → 1s", snipeFeeBpsAt(1.5, TABLE), 2500);
eq("snipeFeeBpsAt(6.999) → 6s", snipeFeeBpsAt(6.999, TABLE), 3);
eq("snipeFeeBpsAt(7) boundary → 0", snipeFeeBpsAt(7, TABLE), 0);
eq("snipeFeeBpsAt(500) → 0", snipeFeeBpsAt(500, TABLE), 0);
eq("snipeFeeBpsAt(-2) skew → t=0", snipeFeeBpsAt(-2, TABLE), 9900);
eq("snipeFeeBpsAt(NaN) → 0", snipeFeeBpsAt(NaN, TABLE), 0);
eq("snipeFeeBpsAt explicit window", snipeFeeBpsAt(3, TABLE, 3), 0);
eq("snipeFeeBpsAt(CURVE table)", [0, 1, 2, 3, 4, 5, 6, 7].map((t) => snipeFeeBpsAt(t, CURVE.antiSnipeBpsBySec)), [...TABLE, 0]);

// new params
eq("new params (1M supply bigint)", snipeParamsFor({ totalSupply: BigInt(1_000_000) * BigInt(1e18) }), NEW);
eq("new params (unknown coin)", snipeParamsFor(undefined), NEW);
eq("new params (tail > 0)", snipeParamsFor({ tail: BigInt(18333) * BigInt(1e18) }), NEW);
// per-second table, each second 0..7
eq("t=0 → 99% / 7s", pick(at(0)), [true, 7, 99]);
eq("t=1 → 25% / 6s", pick(at(1)), [true, 6, 25]);
eq("t=2 → 3% / 5s", pick(at(2)), [true, 5, 3]);
eq("t=3 → 1% / 4s", pick(at(3)), [true, 4, 1]);
eq("t=4 → 0.3% / 3s", pick(at(4)), [true, 3, 0.3]);
eq("t=5 → 0.1% / 2s", pick(at(5)), [true, 2, 0.1]);
eq("t=6 → 0.03% / 1s (feePct 1-dp rounds to 0)", pick(at(6)), [true, 1, 0]);
eq("t=6 raw 0.03%", at(6).feePctRaw, 0.03);
eq("t=7 boundary inactive", pick(at(7)), [false, 0, 0]);
eq("fractional t=1.5 → 1s step (25%) / ceil 6s", pick(at(1.5)), [true, 6, 25]);
eq("t=0.999 still 99%", pick(at(0.999)), [true, 7, 99]);
eq("t=6.9 → 0.03% / ceil 1s", at(6.9).feePctRaw, 0.03);
eq("before launch (skew) clamps to t=0", pick(at(-5)), [true, 7, 99]);
eq("after window t=500 inactive", pick(at(500)), [false, 0, 0]);
eq("no table → linear fallback (t=3.5 → 49.5%)", pick(snipeState({ launchTs: L, nowSec: L + 3.5, startPct: 99, windowSec: 7 })), [true, 4, 49.5]);
eq("empty table → linear fallback", pick(snipeState({ launchTs: L, nowSec: L + 3.5, startPct: 99, windowSec: 7, bpsBySec: [] })), [true, 4, 49.5]);
// live override (wins over the table)
eq("liveFeeBps 6237 wins → 62.4%", pick(at(1, { liveFeeBps: 6237 })), [true, 6, 62.4]);
eq("liveFeeBps raw kept", at(1, { liveFeeBps: 6237 }).feePctRaw, 62.37);
eq("liveFeeBps 2500 at t=1.5", pick(at(1.5, { liveFeeBps: 2500 })), [true, 6, 25]);
eq("liveFeeBps 0 → inactive", pick(at(1, { liveFeeBps: 0 })), [false, 0, 0]);
eq("liveFeeBps NaN ignored", pick(at(0, { liveFeeBps: NaN })), [true, 7, 99]);
eq("liveFeeBps null ignored", pick(at(2, { liveFeeBps: null })), [true, 5, 3]);
eq("liveFeeBps after window still inactive", pick(at(8, { liveFeeBps: 500 })), [false, 0, 0]);
// invalid
eq("NaN now", pick(snipeState({ launchTs: L, nowSec: NaN, ...NEW })), [false, 0, 0]);
eq("launchTs 0", pick(snipeState({ launchTs: 0, nowSec: L, ...NEW })), [false, 0, 0]);
eq("windowSec 0", pick(snipeState({ launchTs: L, nowSec: L, startPct: 99, windowSec: 0 })), [false, 0, 0]);
eq("negative startPct", pick(snipeState({ launchTs: L, nowSec: L, startPct: -1, windowSec: 7 })), [false, 0, 0]);
eq("undefined launchTs", pick(snipeState({ launchTs: undefined, nowSec: L, ...NEW })), [false, 0, 0]);
// old v4 testnet coins: 77.7% linear over 7s (unchanged)
const OLD = { startPct: 77.7, windowSec: 7 };
eq("old params (7B supply bigint wei)", snipeParamsFor({ totalSupply: BigInt(7_000_000_000) * BigInt(1e18) }), OLD);
eq("old params (7B supply number tokens)", snipeParamsFor({ totalSupply: 7e9 }), OLD);
eq("old params (7e27 number wei)", snipeParamsFor({ totalSupply: 7e27 }), OLD);
eq("new params (1e24 number wei)", snipeParamsFor({ totalSupply: 1e24 }), NEW);
eq("old params (tail 0n, no supply)", snipeParamsFor({ tail: BigInt(0) }), OLD);
eq("supply wins over tail", snipeParamsFor({ totalSupply: 1e6, tail: BigInt(0) }), NEW);
const oldS = (dt) => snipeState({ launchTs: L, nowSec: L + dt, ...OLD });
const old = (dt) => pick(oldS(dt));
eq("old t=0 → 77.7% / 7s", old(0), [true, 7, 77.7]);
eq("old t=1 → 66.6% / 6s (linear)", old(1), [true, 6, 66.6]);
eq("old t=3.5 → 38.9% / 4s", old(3.5), [true, 4, 38.9]);
eq("old t=7 inactive", old(7), [false, 0, 0]);
eq("old coin via snipeParamsFor stays linear", pick(snipeState({ launchTs: L, nowSec: L + 1, ...snipeParamsFor({ totalSupply: 7e9 }) })), [true, 6, 66.6]);
// clock (pure formatter)
for (const [x, w] of [[7, "0:07"], [65, "1:05"], [5, "0:05"], [0, "0:00"], [-3, "0:00"], [NaN, "0:00"], [4.2, "0:05"], [59.5, "1:00"], [600, "10:00"]])
  eq(`clock(${x})`, formatSnipeClock(x), w);
// fee % text: whole % from 1%, one significant digit below 1% (never "0%" while taxed)
for (const [x, w] of [[99, "99%"], [25, "25%"], [3, "3%"], [1, "1%"], [0.995, "1%"], [0.3, "0.3%"], [0.1, "0.1%"], [0.03, "0.03%"], [0.555, "0.6%"], [0, "0%"], [-1, "0%"], [NaN, "0%"]])
  eq(`pct(${x})`, formatSnipePct(x), w);
// chip
eq("label constant", SNIPE_CHIP_LABEL, "ANTI-SNIPE");
eq("chip t=0", formatSnipeChip(at(0)), "ANTI-SNIPE 0:07 · 99%");
eq("chip t=1", formatSnipeChip(at(1)), "ANTI-SNIPE 0:06 · 25%");
eq("chip t=2", formatSnipeChip(at(2)), "ANTI-SNIPE 0:05 · 3%");
eq("chip t=3", formatSnipeChip(at(3)), "ANTI-SNIPE 0:04 · 1%");
eq("chip t=4", formatSnipeChip(at(4)), "ANTI-SNIPE 0:03 · 0.3%");
eq("chip t=5", formatSnipeChip(at(5)), "ANTI-SNIPE 0:02 · 0.1%");
eq("chip t=6", formatSnipeChip(at(6)), "ANTI-SNIPE 0:01 · 0.03%");
eq("chip live 6237", formatSnipeChip(at(1, { liveFeeBps: 6237 })), "ANTI-SNIPE 0:06 · 62%");
eq("chip plain object", formatSnipeChip({ secondsLeft: 48, feePct: 61.6 }), "ANTI-SNIPE 0:48 · 62%");
eq("chip plain object < 1%", formatSnipeChip({ secondsLeft: 3, feePct: 0.3 }), "ANTI-SNIPE 0:03 · 0.3%");
eq("old chip t=3.5", formatSnipeChip(oldS(3.5)), "ANTI-SNIPE 0:04 · 39%");

if (fail) { console.error(`test-snipe: ${fail}/${n} FAILED`); process.exit(1); }
console.log(`test-snipe: ${n} checks passed`);
