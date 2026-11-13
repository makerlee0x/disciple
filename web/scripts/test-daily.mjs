// DAILY FLIGHT (Free play, lib/sim/daily.ts): the day number, the fair seed screen, the input-log check and the
// server's replay verdict. A live run scored on the client must equal the server's replay of its input log; a
// tampered log must not reproduce the score. Run: node scripts/test-daily.mjs
import { loadLib } from "./lib/load-ts.mjs";
const { mods, cleanup } = await loadLib(undefined, "daily-");
const { cloneConfig, PLAYER } = mods["sim/config"];
const { SimRun } = mods["sim/run"];
const { makePilot } = mods["sim/pilots"];
const D = mods["sim/daily"];
const SALT = "test-salt-0123456789abcdef";
let fail = 0; const bad = (m) => { fail++; console.error("FAIL " + m); };

// day numbers: #1 is 2026-11-13 UTC, turning at 00:00 UTC
if (D.dailyIdAt(Date.UTC(2026, 10, 13, 0, 0, 1)) !== 1 || D.dailyIdAt(Date.UTC(2026, 10, 13, 23, 59)) !== 1 || D.dailyIdAt(Date.UTC(2026, 10, 14)) !== 2) bad("day numbering");
if (D.dailyEndsAt(1) !== Date.UTC(2026, 10, 14)) bad("dailyEndsAt");
if (PLAYER.dailyMinutes !== 2) bad(`daily is ${PLAYER.dailyMinutes} min, want 2`);

// seeds: deterministic, differ by day, and every one passes the screen (tell, a 2× climb, a Reader can win)
const t0 = Date.now(), seeds = []; let screened = 0;
for (let id = 1; id <= 40; id++) { const s = D.dailySeed(id, SALT); seeds.push(s); if (D.dailySeed(id, SALT) !== s) bad(`seed of day ${id} not stable`); }
if (new Set(seeds).size !== seeds.length) bad("two days share a seed");
if (D.dailySeed(1, "another-salt-000000") === seeds[0]) bad("the salt does not change the seed");
for (let id = 1; id <= 40; id++) { const r = new SimRun(cloneConfig(), D.DAILY.difficulty, seeds[id - 1], { minutes: 2 }); let tells = 0; r.on(({ event }) => { if (event?.kind === "tell") tells++; });
  while (r.t < 120) r.step(1); if (tells >= 1 && r.peak >= r.cfg.launch.startMcapUsd * 2) screened++; }
if (screened < 38) bad(`only ${screened}/40 daily seeds pass the screen`);
console.log(`seeds: 40 days in ${Date.now() - t0} ms, ${screened}/40 pass the screen (tell + 2× climb + Reader green)`);

// a live run, played by a pilot through the same API the page uses, scores the same on the server's replay
const fly = (id, pilot) => { const seed = D.dailySeed(id, SALT), r = new SimRun(cloneConfig(), D.DAILY.difficulty, seed, { minutes: 2 }), p = makePilot(pilot, r, 120, seed);
  while (r.blk < 1200) { p.tick(); r.step(0.1); } return r; };
let same = 0, scored = 0;
for (let id = 1; id <= 20; id++) for (const pilot of ["newbie", "casual", "reader"]) {
  const live = fly(id, pilot), mine = D.scoreRun(live), srv = D.verifyDaily(D.dailySeed(id, SALT), live.inputs);
  if (!D.validInputs(live.inputs)) bad(`day ${id} ${pilot}: a real input log failed validation`);
  if (JSON.stringify(mine) === JSON.stringify(srv)) same++; else bad(`day ${id} ${pilot}: client ${JSON.stringify(mine)} ≠ server ${JSON.stringify(srv)}`);
  if (srv.invested > 0) scored++;
  if (srv.goals.cash2x !== (srv.multiple >= 2) || srv.goals.green !== (srv.pnl > 0.005)) bad("goals disagree with the score"); }
console.log(`verify: ${same}/60 live runs reproduce exactly on the server's replay (${scored} boarded)`);

// tampering: a buy moved earlier, a bigger buy than the cash, ops that Free play doesn't have, junk
{ const live = fly(3, "reader"), base = D.verifyDaily(D.dailySeed(3, SALT), live.inputs), ins = live.inputs;
  const moved = ins.map((x, i) => (i === 0 ? { ...x, blk: Math.max(0, x.blk - 150) } : x));
  if (JSON.stringify(D.verifyDaily(D.dailySeed(3, SALT), moved)) === JSON.stringify(base)) bad("a moved buy reproduced the same score");
  const greedy = [{ blk: 90, op: "trade", side: "buy", usd: 1e5 }, { blk: 900, op: "trade", side: "sell", usd: 0, frac: 1 }];
  if (D.verifyDaily(D.dailySeed(3, SALT), greedy).invested > 0) bad("a buy bigger than the $250 practice cash filled");
  const bads = [[{ blk: 10, op: "place", kind: "tramp", mcapUsd: 1, widthPct: 2, sizeUsd: 5 }], [{ blk: 20, op: "trade", side: "buy", usd: 10 }, { blk: 5, op: "trade", side: "buy", usd: 10 }],
    [{ blk: 99999, op: "trade", side: "buy", usd: 10 }], [{ blk: 1, op: "trade", side: "buy", usd: -1 }], [{ blk: 1, op: "trade", side: "sell", usd: 0, frac: 2 }], [{ blk: 1, op: "trade", side: "buy", usd: 5, x: 1 }],
    Array.from({ length: D.DAILY.maxInputs + 1 }, (_, i) => ({ blk: i, op: "trade", side: "buy", usd: 1 })), "nope", [null]];
  bads.forEach((b, i) => { if (D.validInputs(b)) bad(`bad input log #${i} passed validation`); });
  if (!D.validInputs([])) bad("an empty log (never boarded) should be valid");
  const none = D.verifyDaily(D.dailySeed(3, SALT), []); if (none.multiple !== 0 || none.invested !== 0) bad("never boarded should score 0×");
  console.log(`tamper: moved buy ${D.verifyDaily(D.dailySeed(3, SALT), moved).multiple}× vs ${base.multiple}× · over-cash buy rejected · ${bads.length} bad logs rejected`); }
// the recap the result screen and share card draw re-flies to the same score
{ const live = fly(5, "reader"), rc = D.dailyRecap(D.dailySeed(5, SALT), live.inputs);
  if (JSON.stringify(rc.score) !== JSON.stringify(D.verifyDaily(D.dailySeed(5, SALT), live.inputs))) bad("recap score differs from verify");
  if (rc.path.length !== 121) bad(`recap path has ${rc.path.length} points, want 121`);
  console.log(`recap: ${rc.path.length} points, dumper ${rc.dumper}`); }
// human checks: no pilot run is flagged; instant reactions, bursts and a metronome are
{ let flagged = 0;
  for (let id = 1; id <= 20; id++) for (const pilot of ["newbie", "casual", "reader"]) { const live = fly(id, pilot), f = D.verifyDailyFull(D.dailySeed(id, SALT), live.inputs).flags; if (f.length) { flagged++; bad(`day ${id} ${pilot} flagged ${f}`); } }
  const seed = D.dailySeed(4, SALT), live = new SimRun(cloneConfig(), D.DAILY.difficulty, seed, { minutes: 2 }); let told = false, tells = 0;
  live.on(({ event }) => { if (event?.kind === "tell") told = true; });   // a bot: sells the instant a tell shows, buys back later
  let back = -1; live.playerTrade("buy", 100);
  while (live.blk < 1200) { live.step(0.1); if (told) { told = false; tells++; if (live.player.pos.size > 0) live.playerTrade("sell", 0, { frac: 0.5 }); back = live.blk + 30; }
    if (live.blk === back) live.playerTrade("buy", 20); }
  const bot = live.inputs;
  const fl = (ins) => D.verifyDailyFull(seed, ins).flags;
  if (!fl(bot).includes("instant")) bad(`a bot selling on every tell (${tells}) was not flagged`);
  if (!fl(Array.from({ length: 10 }, (_, i) => ({ blk: 100 + i, op: "trade", side: "buy", usd: 5 }))).includes("burst")) bad("10 trades in a second not flagged");
  if (fl(Array.from({ length: 6 }, (_, i) => ({ blk: 100 + i * 2, op: "trade", side: "buy", usd: 5 }))).includes("burst")) bad("a 5-a-second masher was flagged as a burst");
  if (!fl(Array.from({ length: 8 }, (_, i) => ({ blk: 50 + i * 37, op: "trade", side: "buy", usd: 5 }))).includes("metronome")) bad("perfectly even trades not flagged");
  console.log(`human checks: 0/60 pilot runs flagged (${flagged}), tell-sniping bot (${tells} tells) ${fl(bot)}, burst and metronome caught`); }
cleanup();
if (fail) process.exit(1); else console.log("PASS");
