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

// steep coin: per-second table (lib/config CURVE.antiSnipeBpsBySec = Constants.ANTI_SNIPE_TABLE), 99% … 0.03%, 0 from 7s
eq("steep params come from lib/config CURVE (incl. the table)", snipeParamsFor(steepCoin), { startPct: CURVE.antiSnipeStartPct, windowSec: CURVE.antiSnipeWindowSec, bpsBySec: CURVE.antiSnipeBpsBySec });
eq("table = 99 · 25 · 3 · 1 · 0.3 · 0.1 · 0.03 %, 7 s", [CURVE.antiSnipeBpsBySec, CURVE.antiSnipeWindowSec], [[9900, 2500, 300, 100, 30, 10, 3], 7]);
const steps = ["ANTI-SNIPE 0:07 · 99%", "ANTI-SNIPE 0:06 · 25%", "ANTI-SNIPE 0:05 · 3%", "ANTI-SNIPE 0:04 · 1%", "ANTI-SNIPE 0:03 · 0.3%", "ANTI-SNIPE 0:02 · 0.1%", "ANTI-SNIPE 0:01 · 0.03%"];
steps.forEach((want, e) => eq(`t=${e} → ${want}`, chip(steepCoin, e), want));
eq("lee: t=4 → ANTI-SNIPE 0:03 · 0.3%", chip(steepCoin, 4), "ANTI-SNIPE 0:03 · 0.3%");
eq("lee: t=5 → ANTI-SNIPE 0:02 · 0.1%", chip(steepCoin, 5), "ANTI-SNIPE 0:02 · 0.1%");
eq("lee: t=6 → ANTI-SNIPE 0:01 · 0.03%", chip(steepCoin, 6), "ANTI-SNIPE 0:01 · 0.03%");
eq("mid-second t=4.5 holds the step (floor) → 0:03 · 0.3%", chip(steepCoin, 4.5), "ANTI-SNIPE 0:03 · 0.3%");
eq("t=6.9 still shown → 0:01 · 0.03%", chip(steepCoin, 6.9), "ANTI-SNIPE 0:01 · 0.03%");
eq("t=0.99 still 99%", chip(steepCoin, 0.99), "ANTI-SNIPE 0:07 · 99%");
eq("t=1 steps to 25%", chip(steepCoin, 1), "ANTI-SNIPE 0:06 · 25%");
eq("0 from 7s: t=7 → hidden", chip(steepCoin, 7), null);
eq("after window t=77 → hidden (no 77 s window any more)", chip(steepCoin, 77), null);
eq("after window t=500 → hidden", chip(steepCoin, 500), null);
eq("before launch (clock skew) clamps to the first step", chip(steepCoin, -30), "ANTI-SNIPE 0:07 · 99%");
{ // 250 ms sweep (the live tick/poll rate): shown through 6.75 s, never "0%" while a tax applies, hidden from 7 s
  const seen = []; let zero = 0, gap = 0;
  for (let q = 0; q < 40; q++) { const t = q / 4, c = chip(steepCoin, t); if (t < 7) { if (!c) gap++; else if (/· 0%$/.test(c)) zero++; if (c && !seen.includes(c)) seen.push(c); } else if (c) gap++; }
  eq("250 ms sweep shows exactly the 7 table steps in order", seen, steps);
  eq("250 ms sweep: never 0% while taxed", zero, 0);
  eq("250 ms sweep: shown for t < 7, hidden from 7", gap, 0);
}
// old v4 testnet coin keeps its params: 77.7% linear over 7 s, no table
eq("old-coin params 77.7% / 7 s", snipeParamsFor(oldCoin), { startPct: 77.7, windowSec: 7 });
eq("old coin by tail only (curveTail() missing → 0)", snipeParamsFor({ tail: BigInt(0) }), { startPct: 77.7, windowSec: 7 });
eq("old coin t=0 → 78% · 0:07", chip(oldCoin, 0), "ANTI-SNIPE 0:07 · 78%");
eq("old coin t=3.5 → 0:04 · 39%", chip(oldCoin, 3.5), "ANTI-SNIPE 0:04 · 39%");
eq("old coin t=7 → hidden", chip(oldCoin, 7), null);
eq("old coin t=30 → hidden", chip(oldCoin, 30), null);
eq("old coin is linear, not the table: t=1 → 0:06 · 67%", chip(oldCoin, 1), "ANTI-SNIPE 0:06 · 67%");
eq("old coin t=6.5 → 0:01 · 6% (linear tail)", chip(oldCoin, 6.5), "ANTI-SNIPE 0:01 · 6%");
// live snapshot override (snapshot.snipeFeeBps → liveFeeBps), formatted by SITE's formatSnipePct
eq("snapshot wins for the % (2500 bps at t=0.9 → 25%)", chip(steepCoin, 0.9, 2500), "ANTI-SNIPE 0:07 · 25%");
eq("snapshot 30 bps → 0.3%", chip(steepCoin, 4, 30), "ANTI-SNIPE 0:03 · 0.3%");
eq("snapshot 10 bps → 0.1%", chip(steepCoin, 5, 10), "ANTI-SNIPE 0:02 · 0.1%");
eq("snapshot 3 bps → 0.03% (never 0%)", chip(steepCoin, 6, 3), "ANTI-SNIPE 0:01 · 0.03%");
eq("snapshot 0 bps → hidden even inside the window", chip(steepCoin, 4, 0), null);
eq("snapshot null → table %", chip(steepCoin, 0, null), "ANTI-SNIPE 0:07 · 99%");
// clock format (m:ss)
eq("clock 7 → 0:07", formatSnipeClock(7), "0:07");
eq("clock 2.5 → 0:03", formatSnipeClock(2.5), "0:03");
eq("clock 1 → 0:01", formatSnipeClock(1), "0:01");
// gate + hide rules
eq("SHOW_SNIPE_COUNTDOWN defaults true on this branch", G.SHOW_SNIPE_COUNTDOWN, true);
eq("flag off → hidden", G.snipeChipText(snipeState({ launchTs: L, nowSec: L, startPct: 99, windowSec: 7, bpsBySec: CURVE.antiSnipeBpsBySec }), false), null);
eq("!active → hidden", G.snipeChipText({ active: false, secondsLeft: 10, feePct: 50, feePctRaw: 50 }), null);
eq("null state → hidden", G.snipeChipText(null), null);
// SIMULATOR: launch at run t=0 via SIM_LAUNCH_TS (snipeState treats launchTs ≤ 0 as unknown)
const sim = (t) => G.snipeChipText(snipeState({ launchTs: G.SIM_LAUNCH_TS, nowSec: G.SIM_LAUNCH_TS + t, startPct: Math.round(CURVE.antiSnipeStartPct * 100) / 100, windowSec: CURVE.antiSnipeWindowSec, bpsBySec: CURVE.antiSnipeBpsBySec }));
ok("SIM_LAUNCH_TS > 0", G.SIM_LAUNCH_TS > 0);
eq("sim t=0", sim(0), "ANTI-SNIPE 0:07 · 99%");
eq("sim t=4 → 0:03 · 0.3%", sim(4), "ANTI-SNIPE 0:03 · 0.3%");
eq("sim t=6 → 0:01 · 0.03%", sim(6), "ANTI-SNIPE 0:01 · 0.03%");
eq("sim t=7 hidden (0 from 7s)", sim(7), null);
// copy: no chain / tx jargon in the chip
for (const t of [chip(steepCoin, 0), chip(steepCoin, 6), chip(oldCoin, 0)]) ok(`no on-chain/tx/op/gas/ETH/USDG wording in "${t}"`, !/on-?chain|\btx\b|\bop\b|gas|\bETH\b|USDG/i.test(t));

// static wiring checks
const simMode = read("components/sim/SimMode.tsx"), live = read("components/flight/SnipeCountdown.tsx"), chipTsx = read("components/flight/SnipeChip.tsx");
const coinPage = read("app/coin/[address]/page.tsx"), simCfg = read("lib/sim/config.ts"), i18n = read("lib/game/i18n.ts");
ok("coin page mounts <SnipeCountdown token>", /<SnipeCountdown token=\{address\} \/>/.test(coinPage));
ok("SimMode mounts <SnipeChip state={snipe}>", /<SnipeChip state=\{snipe\} \/>/.test(simMode));
ok("SimMode uses the run's launch config incl. the table (= lib/config via lib/sim/config)", /run\.cfg\.launch\.antiSnipeStartBps \/ 100/.test(simMode) && /run\.cfg\.launch\.antiSnipeDurationS/.test(simMode) && /bpsBySec: run\.cfg\.launch\.antiSnipeBpsBySec/.test(simMode));
ok("SimMode counts from SIM_LAUNCH_TS + run.t, curve phase only", /SIM_LAUNCH_TS \+ run\.t/.test(simMode) && /run\.m\.phase === "curve"/.test(simMode));
ok("sim config takes anti-snipe from CURVE", /CURVE\.antiSnipeStartPct/.test(simCfg) && /CURVE\.antiSnipeWindowSec/.test(simCfg) && /CURVE\.antiSnipeBpsBySec/.test(simCfg));
ok("live: re-reads the snapshot ~every 250 ms while taxed (not 2 s), one read in flight", G.SNIPE_POLL_MS === 250 && G.SNIPE_TICK_MS === 250 && /setInterval\(step, SNIPE_TICK_MS\)/.test(live) && /\}, SNIPE_POLL_MS\)/.test(live) && !/\b2000\)/.test(live) && /inflight/.test(live));
ok("no GAME adapter: % via SITE's formatSnipeChip/formatSnipePct, table via snipeParamsFor spread", !/toPrecision|formatSnipePct\s*=|bpsBySec\[/.test(live + read("lib/game/snipeCountdown.ts") + chipTsx) && /\.\.\.sched/.test(live));
{ const prose = [live, simMode, chipTsx, read("lib/game/snipeCountdown.ts")].join("\n");
  ok('explanatory text says "0 from 7s" (no 77 s / "0 after")', /0 from 7s/.test(live) && /0 from 7s/.test(simMode) && /0 from 7s/.test(read("lib/game/snipeCountdown.ts")) && !/\b77 ?s\b|99%\/77|0 after 7/.test(prose)); }
ok("live: schedule from snipeParamsFor(curveParams)", /snipeParamsFor\(params\)/.test(live) && /curveParams\(pc, curve\)/.test(live));
ok("live: snapshot.snipeFeeBps passed as liveFeeBps", /snap\.snipeFeeBps/.test(live) && /st\.snipeFeeBps/.test(live) && /liveFeeBps \}\)/.test(live));
ok("live: launchTime() from the curve + chain-clock offset", /functionName: "launchTime"/.test(live) && /block\.timestamp/.test(live));
ok("live/sim: no hardcoded 77 / 7 s window", !/\b77\b|windowSec: 7\b/.test(live.replace(/\/\*[\s\S]*?\*\//g, "")) && !/windowSec: 77/.test(simMode));
ok("chip text = SITE's formatSnipeChip (no separate i18n label)", /formatSnipeChip/.test(read("lib/game/snipeCountdown.ts")) && !/snipe\.chip|ANTI-SNIPE/.test(i18n) && /\{text\}/.test(chipTsx));
ok("chip gated by SHOW_SNIPE_COUNTDOWN (live never polls when off)", /SHOW_SNIPE_COUNTDOWN/.test(live) && /snipeChipText\(state\)/.test(chipTsx));
ok("chip re-broadcasts state on window for the engine", /SNIPE_STATE_EVENT/.test(chipTsx));

if (fail) { console.error(`FAIL ${fail}/${n}`); process.exit(1); }
console.log(`PASS ${n}/${n}`);
