// Sniper-tax countdown helper (lib/snipe.ts): ramp, boundaries, live override, old-coin params, clock/chip formatting.
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
const { snipeState, snipeParamsFor, formatSnipeClock, formatSnipeChip, SNIPE_CHIP_LABEL } = S;
let fail = 0, n = 0;
const eq = (name, got, want) => { n++; const g = JSON.stringify(got), w = JSON.stringify(want); if (g !== w) { fail++; console.error(`FAIL ${name}: got ${g}, want ${w}`); } };
const L = 1_800_000_000, NEW = { startPct: 99, windowSec: 77 };
const at = (dt, extra = {}) => snipeState({ launchTs: L, nowSec: L + dt, ...NEW, ...extra });
const pick = (s) => [s.active, s.secondsLeft, s.feePct];

// new params
eq("new params (1M supply bigint)", snipeParamsFor({ totalSupply: BigInt(1_000_000) * BigInt(1e18) }), NEW);
eq("new params (unknown coin)", snipeParamsFor(undefined), NEW);
eq("new params (tail > 0)", snipeParamsFor({ tail: BigInt(18333) * BigInt(1e18) }), NEW);
// ramp
eq("t=0 → 99% / 77s", pick(at(0)), [true, 77, 99]);
eq("before launch (skew) clamps to t=0", pick(at(-5)), [true, 77, 99]);
eq("mid-window t=38.5 → 49.5% / 39s", pick(at(38.5)), [true, 39, 49.5]);
eq("t=29 → 61.7% / 48s", pick(at(29)), [true, 48, 61.7]);
eq("t=76 → 1.3% / 1s", pick(at(76)), [true, 1, 1.3]);
eq("t=76.9 → ceil 1s", pick(at(76.9)), [true, 1, 0.1]);
eq("end boundary t=77 inactive", pick(at(77)), [false, 0, 0]);
eq("after window t=500 inactive", pick(at(500)), [false, 0, 0]);
// live override
eq("liveFeeBps 6237 wins → 62.4%", pick(at(10, { liveFeeBps: 6237 })), [true, 67, 62.4]);
eq("liveFeeBps raw kept", at(10, { liveFeeBps: 6237 }).feePctRaw, 62.37);
eq("liveFeeBps 0 → inactive", pick(at(10, { liveFeeBps: 0 })), [false, 0, 0]);
eq("liveFeeBps NaN ignored", pick(at(0, { liveFeeBps: NaN })), [true, 77, 99]);
eq("liveFeeBps null ignored", pick(at(0, { liveFeeBps: null })), [true, 77, 99]);
eq("liveFeeBps after window still inactive", pick(at(80, { liveFeeBps: 500 })), [false, 0, 0]);
// invalid
eq("NaN now", pick(snipeState({ launchTs: L, nowSec: NaN, ...NEW })), [false, 0, 0]);
eq("launchTs 0", pick(snipeState({ launchTs: 0, nowSec: L, ...NEW })), [false, 0, 0]);
eq("windowSec 0", pick(snipeState({ launchTs: L, nowSec: L, startPct: 99, windowSec: 0 })), [false, 0, 0]);
eq("negative startPct", pick(snipeState({ launchTs: L, nowSec: L, startPct: -1, windowSec: 77 })), [false, 0, 0]);
eq("undefined launchTs", pick(snipeState({ launchTs: undefined, nowSec: L, ...NEW })), [false, 0, 0]);
// old v4 testnet coins: 77.7% over 7s
const OLD = { startPct: 77.7, windowSec: 7 };
eq("old params (7B supply bigint wei)", snipeParamsFor({ totalSupply: BigInt(7_000_000_000) * BigInt(1e18) }), OLD);
eq("old params (7B supply number tokens)", snipeParamsFor({ totalSupply: 7e9 }), OLD);
eq("old params (7e27 number wei)", snipeParamsFor({ totalSupply: 7e27 }), OLD);
eq("new params (1e24 number wei)", snipeParamsFor({ totalSupply: 1e24 }), NEW);
eq("old params (tail 0n, no supply)", snipeParamsFor({ tail: BigInt(0) }), OLD);
eq("supply wins over tail", snipeParamsFor({ totalSupply: 1e6, tail: BigInt(0) }), NEW);
const old = (dt) => pick(snipeState({ launchTs: L, nowSec: L + dt, ...OLD }));
eq("old t=0 → 77.7% / 7s", old(0), [true, 7, 77.7]);
eq("old t=3.5 → 38.9% / 4s", old(3.5), [true, 4, 38.9]);
eq("old t=7 inactive", old(7), [false, 0, 0]);
// clock
for (const [x, w] of [[77, "1:17"], [48, "0:48"], [5, "0:05"], [0, "0:00"], [-3, "0:00"], [NaN, "0:00"], [4.2, "0:05"], [59.5, "1:00"], [600, "10:00"]])
  eq(`clock(${x})`, formatSnipeClock(x), w);
// chip
eq("label constant", SNIPE_CHIP_LABEL, "ANTI-SNIPE");
eq("chip t=29", formatSnipeChip(at(29)), "ANTI-SNIPE 0:48 · 62%");
eq("chip t=0", formatSnipeChip(at(0)), "ANTI-SNIPE 1:17 · 99%");
eq("chip plain object", formatSnipeChip({ secondsLeft: 48, feePct: 61.6 }), "ANTI-SNIPE 0:48 · 62%");

if (fail) { console.error(`test-snipe: ${fail}/${n} FAILED`); process.exit(1); }
console.log(`test-snipe: ${n} checks passed`);
