// GAME: ANTI-SNIPE countdown chip wiring (lib/game/snipeCountdown.ts + components/flight/SnipeChip|SnipeCountdown.tsx + SimMode).
// The math is SITE's lib/snipe.ts (scripts/test-snipe.mjs); this checks what the HUD chip shows / hides for live, sim and old coins.
//   Run: node scripts/test-snipe-countdown.mjs   (offline: no chain, no browser)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(web, rel), "utf8");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snipecd-")); fs.mkdirSync(path.join(tmp, "game"));
for (const rel of ["config", "snipe", "game/snipeCountdown"]) {
  const src = read(`lib/${rel}.ts`).replace(/from "(\.{1,2}\/[^"]+)"/g, 'from "$1.mjs"');
  fs.writeFileSync(path.join(tmp, rel + ".mjs"), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText);
}
const { snipeState, snipeParamsFor, formatSnipeClock } = await import(pathToFileURL(path.join(tmp, "snipe.mjs")).href);
const G = await import(pathToFileURL(path.join(tmp, "game/snipeCountdown.mjs")).href);
const { CURVE } = await import(pathToFileURL(path.join(tmp, "config.mjs")).href);
let fail = 0, n = 0;
const eq = (name, got, want) => { n++; const g = JSON.stringify(got), w = JSON.stringify(want); const ok = g === w; if (!ok) fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${g}${ok ? "" : ` (want ${w})`}`); };
const ok = (name, cond) => eq(name, !!cond, true);

const L = 1_800_000_000;
const E18 = BigInt(1e18);
const steepCoin = { totalSupply: BigInt(1_000_000) * E18, tail: BigInt(18_333) * E18 };   // CurveParams shape (protocol-viem curveParams)
const oldCoin = { totalSupply: BigInt(7_000_000_000) * E18, tail: BigInt(0) };              // pre-steep v4 testnet curve
const chip = (coin, dt, liveFeeBps) => G.snipeChipText(snipeState({ launchTs: L, nowSec: L + dt, ...snipeParamsFor(coin), liveFeeBps }));

// steep coin (99% over 77 s, from lib/config CURVE)
eq("steep params come from lib/config CURVE", snipeParamsFor(steepCoin), { startPct: CURVE.antiSnipeStartPct, windowSec: CURVE.antiSnipeWindowSec });
eq("t=0 → 99% · 1:17", chip(steepCoin, 0), "ANTI-SNIPE 1:17 · 99%");
eq("midpoint t=38.5 → ~49.5% (feePctRaw)", +snipeState({ launchTs: L, nowSec: L + 38.5, ...snipeParamsFor(steepCoin) }).feePctRaw.toFixed(2), 49.5);
eq("midpoint chip (whole %)", chip(steepCoin, 38.5), "ANTI-SNIPE 0:39 · 50%");
eq("lee's example t=29 → 0:48 · 62%", chip(steepCoin, 29), "ANTI-SNIPE 0:48 · 62%");
eq("t=76 still shown", chip(steepCoin, 76), "ANTI-SNIPE 0:01 · 1%");
eq("window end t=77 → hidden", chip(steepCoin, 77), null);
eq("after window t=500 → hidden", chip(steepCoin, 500), null);
eq("before launch (clock skew) clamps to full fee / full window", chip(steepCoin, -30), "ANTI-SNIPE 1:17 · 99%");
// old v4 testnet coin (77.7% over 7 s) — never the 77 s schedule
eq("old-coin params 77.7% / 7 s", snipeParamsFor(oldCoin), { startPct: 77.7, windowSec: 7 });
eq("old coin by tail only (curveTail() missing → 0)", snipeParamsFor({ tail: BigInt(0) }), { startPct: 77.7, windowSec: 7 });
eq("old coin t=0 → 78% · 0:07", chip(oldCoin, 0), "ANTI-SNIPE 0:07 · 78%");
eq("old coin t=3.5 → 0:04 · 39%", chip(oldCoin, 3.5), "ANTI-SNIPE 0:04 · 39%");
eq("old coin t=7 → hidden", chip(oldCoin, 7), null);
eq("old coin t=30 → hidden (would still show on a 77 s schedule)", chip(oldCoin, 30), null);
// live snapshot override (snapshot.snipeFeeBps → liveFeeBps)
eq("snapshot wins for the %", chip(steepCoin, 10, 6150), "ANTI-SNIPE 1:07 · 62%");
eq("snapshot 0 bps → hidden even inside the window", chip(steepCoin, 10, 0), null);
eq("snapshot null → schedule %", chip(steepCoin, 0, null), "ANTI-SNIPE 1:17 · 99%");
// clock format (m:ss)
eq("clock 77 → 1:17", formatSnipeClock(77), "1:17");
eq("clock 48 → 0:48", formatSnipeClock(48), "0:48");
eq("clock 5 → 0:05", formatSnipeClock(5), "0:05");
// gate + hide rules
eq("SHOW_SNIPE_COUNTDOWN defaults true on this branch", G.SHOW_SNIPE_COUNTDOWN, true);
eq("flag off → hidden", G.snipeChipText(snipeState({ launchTs: L, nowSec: L, startPct: 99, windowSec: 77 }), false), null);
eq("!active → hidden", G.snipeChipText({ active: false, secondsLeft: 10, feePct: 50, feePctRaw: 50 }), null);
eq("null state → hidden", G.snipeChipText(null), null);
// SIMULATOR: launch at run t=0 via SIM_LAUNCH_TS (snipeState treats launchTs ≤ 0 as unknown)
const sim = (t) => G.snipeChipText(snipeState({ launchTs: G.SIM_LAUNCH_TS, nowSec: G.SIM_LAUNCH_TS + t, startPct: Math.round(CURVE.antiSnipeStartPct * 100) / 100, windowSec: CURVE.antiSnipeWindowSec }));
ok("SIM_LAUNCH_TS > 0", G.SIM_LAUNCH_TS > 0);
eq("sim t=0", sim(0), "ANTI-SNIPE 1:17 · 99%");
eq("sim t=77 hidden", sim(77), null);
// copy: no chain / tx jargon in the chip
for (const t of [chip(steepCoin, 0), chip(oldCoin, 0)]) ok(`no on-chain/tx/op/gas/ETH/USDG wording in "${t}"`, !/on-?chain|\btx\b|\bop\b|gas|\bETH\b|USDG/i.test(t));

// static wiring checks
const simMode = read("components/sim/SimMode.tsx"), live = read("components/flight/SnipeCountdown.tsx"), chipTsx = read("components/flight/SnipeChip.tsx");
const coinPage = read("app/coin/[address]/page.tsx"), simCfg = read("lib/sim/config.ts"), i18n = read("lib/game/i18n.ts");
ok("coin page mounts <SnipeCountdown token>", /<SnipeCountdown token=\{address\} \/>/.test(coinPage));
ok("SimMode mounts <SnipeChip state={snipe}>", /<SnipeChip state=\{snipe\} \/>/.test(simMode));
ok("SimMode uses the run's launch config (= lib/config via lib/sim/config)", /run\.cfg\.launch\.antiSnipeStartBps \/ 100/.test(simMode) && /run\.cfg\.launch\.antiSnipeDurationS/.test(simMode));
ok("SimMode counts from SIM_LAUNCH_TS + run.t, curve phase only", /SIM_LAUNCH_TS \+ run\.t/.test(simMode) && /run\.m\.phase === "curve"/.test(simMode));
ok("sim config takes anti-snipe from CURVE", /CURVE\.antiSnipeStartPct/.test(simCfg) && /CURVE\.antiSnipeWindowSec/.test(simCfg));
ok("live: schedule from snipeParamsFor(curveParams)", /snipeParamsFor\(params\)/.test(live) && /curveParams\(pc, curve\)/.test(live));
ok("live: snapshot.snipeFeeBps passed as liveFeeBps", /snap\.snipeFeeBps/.test(live) && /st\.snipeFeeBps/.test(live) && /liveFeeBps \}\)/.test(live));
ok("live: launchTime() from the curve + chain-clock offset", /functionName: "launchTime"/.test(live) && /block\.timestamp/.test(live));
ok("live/sim: no hardcoded 77 / 7 s window", !/\b77\b|windowSec: 7\b/.test(live.replace(/\/\*[\s\S]*?\*\//g, "")) && !/windowSec: 77/.test(simMode));
ok("chip text = SITE's formatSnipeChip (no separate i18n label)", /formatSnipeChip/.test(read("lib/game/snipeCountdown.ts")) && !/snipe\.chip|ANTI-SNIPE/.test(i18n) && /\{text\}/.test(chipTsx));
ok("chip gated by SHOW_SNIPE_COUNTDOWN (live never polls when off)", /SHOW_SNIPE_COUNTDOWN/.test(live) && /snipeChipText\(state\)/.test(chipTsx));
ok("chip re-broadcasts state on window for the engine", /SNIPE_STATE_EVENT/.test(chipTsx));

if (fail) { console.error(`FAIL ${fail}/${n}`); process.exit(1); }
console.log(`PASS ${n}/${n}`);
