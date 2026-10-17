// SIMULATOR headless test (maker lee): runs each difficulty for N simulated minutes at fixed seeds through
// lib/sim (market + bots) and lib/pnl, then asserts:
//   curve mirrors CurveMath.sol ($7K at launch, $33K at graduation, no price jump into the pool),
//   determinism (same seed → identical run), PnL invariants for every wallet,
//   and the difficulty shape: PvE climbs most reliably, PvP is volatile but can go high, TRENCH is hardest with rugs.
// Plus (feat/sim-parity): tramps/walls are real range liquidity (absorb trades, fill, keeper pull + tip, revert rule),
//   per-run reset (sim-only storage), bots place and react to orders, NO wallet cap, adaptive bots that profit more
//   off an aggressive player at higher difficulty, and replay determinism (seed + player-input log incl. place/cancel).
// Run: node scripts/test-sim.mjs [minutes=10] [seedsPerDifficulty=12]      (SIM_JSON=path writes the raw runs)
import fs from "node:fs";
import { loadLib } from "./lib/load-ts.mjs";
const { mods, cleanup } = await loadLib(undefined, "sim-");
const { SIM_CONFIG, cloneConfig, LAUNCH, DIFFICULTIES, resetSimStorage, SIM_STORAGE, mergeTune } = mods["sim/config"];
const { Market } = mods["sim/market"];
const { SimRun, fmt, YOU } = mods["sim/run"];
const { Pool, KEEPER_TIP_BPS } = mods["sim/pool"];
const { createSimTrampWallAdapter, SIM_ME } = mods["sim/twAdapter"];
const MIN = +(process.argv[2] || 10), N = +(process.argv[3] || 12);
let fail = 0; const bad = (m) => { fail++; console.error("FAIL " + m); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e * Math.max(1, Math.abs(a), Math.abs(b));

// ---- curve mirrors the contracts ----
{ const m = new Market(cloneConfig());
  if (!near(m.mcap(), LAUNCH.startMcapUsd)) bad(`launch mcap ${m.mcap()}`);
  const pre = m.price(); let usd = 0; while (m.phase === "curve") { const f = m.buy(100, 60, 0); usd += f.usd; if (!f.ok) { m.sold = 0; break; } }
  if (m.phase !== "pool") bad("never graduated");
  if (!(Math.abs(m.mcap() / LAUNCH.graduationMcapUsd - 1) < 0.01)) bad(`graduation mcap ${m.mcap()}`);
  const raised = usd; console.log(`curve: $${LAUNCH.startMcapUsd} → graduation ${fmt(m.mcap())} after ${fmt(raised)} of buys (pool seeded at the curve-end price, ${fmt(m.X)} quote depth)`);
  const q = new Market(cloneConfig()); const a = q.buy(50, 0, 0), b = new Market(cloneConfig()).buy(50, 8, 0);
  if (!(a.tokens < b.tokens * 0.3)) bad("anti-snipe fee not applied at t=0");
  // NO wallet cap in the sim (live Launchpad default WALLET_CAP_BPS_DEFAULT = 0): one wallet can take > 7%
  if (LAUNCH.walletCapBps !== 0) bad(`sim walletCapBps should be 0 (live default), is ${LAUNCH.walletCapBps}`);
  const c = new Market(cloneConfig()); const big = c.buy(3000, 60, 0);
  if (!(big.ok && big.tokens > LAUNCH.totalSupply * 0.07)) bad(`no-cap: one $3K buy should exceed 7% of supply (got ${(big.tokens / LAUNCH.totalSupply * 100).toFixed(2)}%, ${big.reason || ""})`);
  else console.log(`no wallet cap: one wallet bought ${(big.tokens / LAUNCH.totalSupply * 100).toFixed(1)}% of supply in one $3K buy`);
  { const r = new SimRun(cloneConfig(), "trench", 5, { balance: 1e5 }); while (r.t < 8) r.step(0.1); const f = r.playerTrade("buy", 3000);
    if (!(f.ok && r.player.pos.size > LAUNCH.totalSupply * 0.07)) bad("no-cap: SimRun player buy was capped"); }
  const rt = new Market(cloneConfig()); const f1 = rt.buy(200, 60, 0), f2 = rt.sell(f1.tokens); if (!(f2.usd * 0.99 < 200 && f2.usd * 0.99 > 196)) bad(`round trip ${f2.usd}`); }

// ---- determinism ----
// chart stats via a trade listener (r.trades is a capped ring): first trade, rate, buy share, ≥10% drawdowns (zigzag)
const statsOf = (r) => { const st = { first: null, n: 0, n60: 0, buyUsd: 0, usd: 0, buys: 0, dd: 0, hi: 0, lo: Infinity, down: false };
  r.on(({ trade: tr }) => { if (!tr || tr.mine) return; if (st.first == null) st.first = tr.t; st.n++; if (tr.t <= 60) st.n60++; st.usd += tr.usd; if (tr.side === "buy") { st.buys++; st.buyUsd += tr.usd; }
    const m = tr.mcap; if (!st.down) { if (m > st.hi) st.hi = m; if (m < st.hi * 0.9) { st.dd++; st.down = true; st.lo = m; } }
    else { if (m < st.lo) st.lo = m; if (m > st.lo * 1.1) { st.down = false; st.hi = m; } } });
  return st; };
const runOnce = (d, seed, minutes = MIN, play, stats) => { const r = new SimRun(cloneConfig(), d, seed); if (stats) stats.s = statsOf(r); if (play) play(r); for (let s = 0; s < minutes * 60; s++) { r.step(1); if (play && play.tick) play.tick(r); } return r; };
{ const a = JSON.stringify(runOnce("trench", 42, 4).summary()), b = JSON.stringify(runOnce("trench", 42, 4).summary());
  if (a !== b) bad("same seed produced a different run"); else console.log("determinism: trench seed 42 ×2 identical"); }

// ---- PnL invariants on a played run ----
{ const play = (r) => { r.playerTrade("buy", 100); }; play.tick = (r) => { if (Math.abs(r.t - 120) < 0.5) r.playerTrade("sell", 0, { frac: 0.4 }); };
  const r = runOnce("pvp", 7, 4, play);
  for (const w of [...r.bots, { pos: r.player.pos, name: "you" }]) { const p = w.pos; if (p.size > 0) { const v = r.pnlOf(p), avg = p.costBasis / p.size; if (!near(v.uPnl, p.size * (r.m.price() - avg), 1e-9)) bad(`uPnL rule broken for ${w.name}`); } }
  const before = r.pnlOf(r.player.pos), sz = r.player.pos.size, f = r.playerTrade("sell", 0, { frac: 0.5 }), after = r.pnlOf(r.player.pos);
  // selling at the fill price: realized += tokens × (fill − avg); the price-move portion stays in uPnL of the rest
  const avg = (before.uPnl / sz) ; void avg;
  if (!(f.ok && after.fees > before.fees)) bad("player sell did not book fees separately");
  console.log(`pnl: player ${JSON.stringify(r.summary().you)}`); }

// ---- tramps & walls: pool math (TrampWallManager semantics) ----
{ const S = LAUNCH.totalSupply, Y = S * 0.28, p0 = LAUNCH.graduationMcapUsd / S, s0 = Math.sqrt(p0), mk = () => new Pool(p0 * Y, Y);
  const ord = (kind, lo, hi, deposit) => ({ id: 1, owner: "x", kind, a: s0 * Math.sqrt(lo), b: s0 * Math.sqrt(hi), deposit, sizeUsd: 0, basis: 0, placedT: 0, placedBlk: 0 });
  { const P = mk(); if (typeof P.place(ord("tramp", 1.01, 1.03, 100)) !== "string") bad("tramp above the price was accepted");
    if (typeof P.place(ord("wall", 0.97, 0.99, 1e6)) !== "string") bad("wall below the price was accepted"); }
  // wall above absorbs BUYS: the same buy moves the price less and the buyer gets more tokens
  { const A = mk(), B = mk(), o = B.place(ord("wall", 1.02, 1.08, Y * 0.04)); const ta = A.buy(4000), tb = B.buy(4000);
    if (!(B.price() < A.price() && tb > ta)) bad(`wall did not absorb buys (${A.price()} vs ${B.price()})`);
    const mvA = (A.price() / p0 - 1) * 100, mvB = (B.price() / p0 - 1) * 100;
    const g = B.amounts(o); if (!(g.quote > 0)) bad("wall sold no tokens into the buy");
    B.buy(1e6); if (!B.isFilled(o)) bad("wall not filled after the price crossed its top");
    const out = B.remove(o, KEEPER_TIP_BPS), g2 = { quote: out.quote + out.tipQuote, tokens: out.tokens + out.tipTokens };
    if (!(g2.tokens < 1e-6 * Y && near(out.tipQuote, g2.quote * KEEPER_TIP_BPS / 1e4, 1e-9))) bad("filled wall: all quote, 0.1% keeper tip");
    console.log(`pool wall: the same $4K buy moves the price +${mvA.toFixed(1)}% bare vs +${mvB.toFixed(1)}% into a wall at +2…8% · filled wall paid out $${out.quote.toFixed(2)} (+$${out.tipQuote.toFixed(2)} keeper tip)`); }
  // tramp below absorbs SELLS; if the price comes back it is no longer filled (a keeper pull would revert)
  { const A = mk(), B = mk(), o = B.place(ord("tramp", 0.9, 0.97, 2000)); const qa = A.sell(Y * 0.05), qb = B.sell(Y * 0.05);
    if (!(B.price() > A.price() && qb > qa)) bad("tramp did not absorb sells");
    const sA = (A.price() / p0 - 1) * 100, sB = (B.price() / p0 - 1) * 100;
    B.sell(Y * 2); if (!B.isFilled(o)) bad("tramp not filled after the price crossed its bottom");
    B.buy(1e6); if (B.isFilled(o)) bad("tramp still 'filled' after the price came back (pull should revert)");
    console.log(`pool tramp: the same sell moves the price ${sA.toFixed(1)}% bare vs ${sB.toFixed(1)}% onto a tramp at −3…10% · filled → unfilled when the price returns (keeper pull would revert)`); } }

// ---- tramps & walls in a SimRun: player orders are real liquidity, keeper pulls, per-run reset ----
const graduated = (d, seed, bal = 1e5) => { const r = new SimRun(cloneConfig(), d, seed, { balance: bal }); while (r.t < 8) r.step(0.1); r.playerTrade("buy", 20000); r.step(0.5); return r; };
{ // A/B at the same block: identical runs, one places a tramp first; the player's own big sell lands softer on it
  const A = graduated("pve", 77), B = graduated("pve", 77), m = B.m.mcap();
  const pl = B.playerPlace("tramp", m * 0.96, 4, 1500); if (!pl.ok) bad(`player tramp rejected: ${pl.reason}`);
  if (!(B.player.cash < A.player.cash - 1499)) bad("tramp did not take its quote from the sim balance");
  A.playerTrade("sell", 0, { frac: 0.6 }); B.playerTrade("sell", 0, { frac: 0.6 });
  if (!(B.m.mcap() > A.m.mcap())) bad("player tramp did not absorb the sell");
  console.log(`sim tramp: same sell → ${fmt(A.m.mcap())} without vs ${fmt(B.m.mcap())} with a $1.5K tramp at −4%`);
  for (let i = 0; i < 80 && B.tw.filled.you === 0; i++) B.step(0.1);
  if (!(B.tw.filled.you === 1 && B.keeper.pulls >= 1 && B.keeper.tips > 0)) bad(`keeper did not close the filled tramp (filled ${B.tw.filled.you}, pulls ${B.keeper.pulls})`);
  const o = B.m.pool.orders.find((x) => x.owner === YOU); if (!(o && o.status === "filled" && o.outTokens > 0 && o.closedBy === "KEEPER")) bad("filled tramp did not deliver tokens to the owner");
  if (!(B.summary().achievements.includes("LIMIT LEGEND") && B.tw.youPoints > 0)) bad("filled tramp: no achievement/points");
  console.log(`keeper pull after ${(o.closedT - o.crossedT).toFixed(1)} s: +${(o.outTokens / 1e6).toFixed(2)}M tokens to you, tip $${B.keeper.tips.toFixed(2)}`);
  // wall absorbs the player's buy at the same block
  const C = graduated("pve", 78), D2 = graduated("pve", 78), mc = D2.m.mcap(); const wl = D2.playerPlace("wall", mc * 1.05, 4, 1500); if (!wl.ok) bad(`player wall rejected: ${wl.reason}`);
  C.playerTrade("buy", 5000); D2.playerTrade("buy", 5000); if (!(D2.m.mcap() < C.m.mcap())) bad("player wall did not absorb the buy");
  // cancel returns the current mix; cancelling twice fails
  const id = D2.m.pool.orders.find((x) => x.owner === YOU).id; if (!D2.playerCancel(id).ok || D2.playerCancel(id).ok) bad("cancel semantics");
  // per-run reset: a new run has no orders; resetSimStorage clears sim keys only (never the live disciple.tw.v1)
  const fresh = new SimRun(cloneConfig(), "pve", 77); if (fresh.m.pool || fresh.tw.placed.you) bad("orders leaked into a new run");
  const st = new Map([[SIM_STORAGE.tw, "[]"], [SIM_STORAGE.pnlPrefix + "run-1", "{}"], ["disciple.tw.v1", "[]"], ["disciple.pnl.x", "{}"]]);
  const stub = { get length() { return st.size; }, key: (i) => [...st.keys()][i] ?? null, removeItem: (k) => st.delete(k), getItem: (k) => st.get(k) ?? null, setItem: (k, v) => st.set(k, String(v)) };
  if (SIM_STORAGE.tw === "disciple.tw.v1") bad("sim tramps/walls share the live namespace");
  resetSimStorage(stub); if (st.has(SIM_STORAGE.tw) || st.has(SIM_STORAGE.pnlPrefix + "run-1") || !st.has("disciple.tw.v1") || !st.has("disciple.pnl.x")) bad("resetSimStorage cleared the wrong keys");
  // the panel adapter drives the same SimRun, mirrors to the sim-only key
  const E = graduated("pvp", 79), ad = createSimTrampWallAdapter(() => E, stub), me = E.m.mcap();
  const pv = await ad.preview({ token: "SIMULATOR", kind: "tramp", mcapUsd: me * 1.02, rangeWidthPct: 2, amount: 0n, sizeUsd: 100 }, me); if (pv.valid) bad("adapter preview accepted a tramp above price");
  let evs = 0; const off = ad.onEvent("SIMULATOR", () => evs++);
  const pr = await ad.place({ token: "SIMULATOR", kind: "tramp", mcapUsd: me * 0.95, rangeWidthPct: 3, amount: 0n, sizeUsd: 200 });
  const mine = await ad.listMine(SIM_ME, "SIMULATOR"), all = await ad.list("SIMULATOR"); off();
  if (!(pr.ok && mine.length === 1 && mine[0].owner === SIM_ME && all.some((t) => t.id === pr.id) && evs === 1 && st.has(SIM_STORAGE.tw) && !(JSON.parse(st.get("disciple.tw.v1")).length))) bad("sim adapter place/list/mirror");
  console.log(`per-run reset + sim adapter OK (mirror key ${SIM_STORAGE.tw}, ${all.length} live orders incl. bots)`); }

// ---- bots use tramps/walls and react to yours (more competitively at higher difficulty) ----
{ const R = { pve: {}, pvp: {}, trench: {} };
  for (const d of Object.keys(R)) for (let i = 0; i < 6; i++) { const r = graduated(d, 500 + i), m = r.m.mcap();
    r.playerPlace("wall", m * 1.06, 3, 800); r.playerPlace("tramp", m * 0.95, 3, 800); for (let s = 0; s < 120; s++) r.step(1);
    for (const [k, v] of Object.entries(r.reacts)) R[d][k] = (R[d][k] || 0) + v; R[d].botsPlaced = (R[d].botsPlaced || 0) + r.tw.placed.bots; }
  const hostile = (x) => (x.frontrun || 0) + (x.undercut || 0) + (x.exitInto || 0);
  for (const d of Object.keys(R)) { console.log(`${d.padEnd(6)} vs your tramp+wall (6 seeds × 2 min): bots placed ${R[d].botsPlaced} · front-run ${R[d].frontrun || 0} · undercut ${R[d].undercut || 0} · exit-into ${R[d].exitInto || 0} · stack ${R[d].stack || 0}`);
    if (!(R[d].botsPlaced > 0)) bad(`${d}: bots never placed tramps/walls`); }
  if (!(hostile(R.trench) > hostile(R.pve) && hostile(R.pvp) > hostile(R.pve))) bad("bots should exploit your orders more in PvP/TRENCH than in PvE");
  if (!((R.pve.stack || 0) > (R.trench.stack || 0))) bad("PvE bots should cooperate (stack tramps) more than TRENCH"); }

// ---- adaptive bots: an aggressive player feeds the bots more at higher difficulty; a passive one feeds nobody ----
{ const AN = 8, AM = 6, mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
  const aggressive = (r) => { const t = Math.round(r.t * 10); if (t >= 50 && t <= 1500 && t % 30 === 0) r.playerTrade("buy", 25); if (t === 3000) r.playerTrade("sell", 0, { frac: 1 }); };
  const go = (d, seed, play) => { const r = new SimRun(cloneConfig(), d, seed); for (let i = 0; i < AM * 600; i++) { if (play) play(r); r.step(0.1); } return r; };
  const A = {};
  for (const d of ["pve", "pvp", "trench"]) { const rp = [], you = [], pas = [];
    for (let i = 0; i < AN; i++) { const r = go(d, 2000 + i, aggressive); rp.push(r.reactPnl); you.push(r.pnlOf(YOU).total); if (i < 3) pas.push(go(d, 2000 + i).reactPnl); }
    A[d] = { mean: mean(rp), med: med(rp), you: med(you), pas: Math.max(...pas.map(Math.abs)) };
    console.log(`${d.padEnd(6)} aggressive player ($25 every 3 s, dump at 5:00; ${AN} seeds): bots' reaction PnL mean $${A[d].mean.toFixed(0)} (median $${A[d].med.toFixed(0)}) · your PnL median $${A[d].you.toFixed(0)} · passive player → bots' reaction PnL $${A[d].pas.toFixed(2)}`); }
  if (!(A.trench.mean > A.pvp.mean && A.pvp.mean > A.pve.mean)) bad("bots should profit more off an aggressive player as difficulty rises (TRENCH > PvP > PvE)");
  if (!(A.pvp.med > A.pve.med && A.trench.med > A.pve.med)) bad("median reaction PnL: PvP/TRENCH should beat PvE");
  if (!(A.pve.pas === 0 && A.pvp.pas === 0 && A.trench.pas === 0)) bad("bots reacted to a player who never traded (omniscience?)");
  if (!(A.trench.you < A.pve.you)) bad("the same aggressive play should do worse in TRENCH than in PvE"); }

// ---- determinism: seed + player-input log (trades, tramp/wall place & cancel) ⇒ identical run, independent of step size ----
{ const play = (r) => { const t = Math.round(r.t * 10);
    if (t === 80) r.playerTrade("buy", 20000);
    if (t === 120) r.playerPlace("tramp", r.m.mcap() * 0.94, 3, 400);
    if (t === 125) r.playerPlace("wall", r.m.mcap() * 1.08, 3, 300);
    if (t === 600) { const o = r.m.pool?.active.find((x) => x.owner === YOU && x.kind === "wall"); if (o) r.playerCancel(o.id); }
    if (t === 900) r.playerTrade("sell", 0, { frac: 0.3 }); };
  const live = new SimRun(cloneConfig(), "trench", 4242, { balance: 1e5 }); for (let i = 0; i < 1800; i++) { play(live); live.step(0.1); }
  const ops = live.inputs.map((x) => x.op).join(",");
  const rep = SimRun.replay(cloneConfig(), "trench", 4242, live.inputs, 180, { balance: 1e5 });
  const coarse = new SimRun(cloneConfig(), "trench", 4242, { balance: 1e5 }); for (let i = 0; i < 360; i++) coarse.step(0.5);
  const fine = new SimRun(cloneConfig(), "trench", 4242, { balance: 1e5 }); for (let i = 0; i < 1800; i++) fine.step(0.1);
  if (JSON.stringify(rep.summary()) !== JSON.stringify(live.summary())) bad(`replay of the input log (${ops}) diverged`);
  else if (JSON.stringify(coarse.summary()) !== JSON.stringify(fine.summary())) bad("step size changed the run (block clock)");
  else console.log(`determinism: replay of ${live.inputs.length} inputs (${ops}) identical · step 0.5 s ≡ 0.1 s · you placed ${live.tw.placed.you}, cancelled ${live.m.pool.orders.filter((o) => o.owner === YOU && o.status === "cancelled").length}`); }

// ---- difficulty distributions ----
const D = ["pve", "pvp", "trench"], out = {}, raw = [];
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const t0 = Date.now();
for (const d of D) { const peaks = [], fin = [], rugs = [], ctos = [], bots = [], grads = [];
  const ST = [];
  for (let i = 0; i < N; i++) { const box = {}; const s = runOnce(d, 1000 + i, MIN, undefined, box).summary(); ST.push(box.s); raw.push(s); peaks.push(s.peakMcap); fin.push(s.finalMcap); rugs.push(!!s.rug); ctos.push(!!s.cto); bots.push(s.bots); grads.push(s.graduatedAtS != null); }
  out[d] = { peaks, fin, rugs: rugs.filter(Boolean).length, ctos: ctos.filter(Boolean).length, grads: grads.filter(Boolean).length, bots: Math.round(bots.reduce((a, b) => a + b) / N), med: q(peaks, 0.5), p10: q(peaks, 0.1), p90: q(peaks, 0.9), max: Math.max(...peaks), min: Math.min(...peaks), finMed: q(fin, 0.5) };
  { const f = ST.map((x) => x.first ?? MIN * 60), tpm = ST.map((x) => x.n / MIN), bs = ST.reduce((a, x) => a + x.buys, 0) / Math.max(1, ST.reduce((a, x) => a + x.n, 0)), dd = ST.map((x) => x.dd);
    out[d].stats = { firstMed: q(f, 0.5), firstMax: Math.max(...f), tpm: q(tpm, 0.5), buyShare: bs, ddMed: q(dd, 0.5), ddMean: dd.reduce((a, b) => a + b, 0) / N, tpm1: q(ST.map((x) => x.n60), 0.5), buyUsd: ST.reduce((a, x) => a + x.buyUsd, 0) / ST.reduce((a, x) => a + x.usd, 0) };
    const S = out[d].stats; console.log(`${d.padEnd(6)} stats: first trade median ${S.firstMed.toFixed(1)} s (max ${S.firstMax.toFixed(1)} s) · ${S.tpm.toFixed(0)} trades/min (median; ${S.tpm1} in minute 1) · buys ${(S.buyShare * 100).toFixed(1)}% by count (${(S.buyUsd * 100).toFixed(0)}% by $) · drawdowns >10% per run median ${S.ddMed} (mean ${S.ddMean.toFixed(1)})`); }
  const o = out[d], cv = Math.sqrt(peaks.reduce((s, v) => s + Math.log(v / o.med) ** 2, 0) / N);
  o.logSpread = cv;
  console.log(`${d.padEnd(6)} ${MIN} min × ${N} seeds: peak median ${fmt(o.med)}  p10 ${fmt(o.p10)}  p90 ${fmt(o.p90)}  min ${fmt(o.min)}  max ${fmt(o.max)}  · final median ${fmt(o.finMed)} · graduated ${o.grads}/${N} · rugs ${o.rugs} · CTO ${o.ctos} · ~${o.bots} bots · log-spread ${cv.toFixed(2)}`); }
for (const d of D) { const s = raw.find((r) => r.difficulty === d); console.log(`  ${d} seed ${s.seed}: peak ${fmt(s.peakMcap)} (${s.peakTier}) · events ${s.events.filter((e) => e.kind !== "tier").map((e) => `${e.t}s ${e.kind}`).join(", ")} · bots ${JSON.stringify(s.botsByArchetype)}`); }
console.log(`(${((Date.now() - t0) / 1000).toFixed(1)} s wall for ${3 * N} runs)`);
const P = out.pve, V = out.pvp, T = out.trench;
if (!(P.p10 >= LAUNCH.graduationMcapUsd)) bad(`PvE should graduate reliably (p10 ${fmt(P.p10)})`);
if (!(P.p10 > V.p10 && P.p10 > T.p10)) bad("PvE should have the best floor (p10)");
// #49 retuned PvE with profit-taking + pullback waves, so PvP whales can now END higher on some seeds; what PvE must
// keep is a reliable, calm hold: final median above graduation and above TRENCH, and more of its peak kept than PvP
// (TRENCH is excluded from retention: rug + CTO leave a low peak that is trivially "kept").
const keep = (o) => o.finMed / o.med;
if (!(P.finMed >= LAUNCH.graduationMcapUsd && P.finMed > T.finMed)) bad(`PvE should hold its altitude (final median ${fmt(P.finMed)} ≥ graduation, > TRENCH)`);
if (!(keep(P) > keep(V))) bad(`PvE should keep more of its peak than PvP (final/peak PvE ${keep(P).toFixed(2)} · PvP ${keep(V).toFixed(2)} · TRENCH ${keep(T).toFixed(2)})`);
if (!(V.logSpread > P.logSpread)) bad("PvP should be more volatile than PvE");
if (!(V.max >= 100_000)) bad(`PvP should be able to go high (max ${fmt(V.max)})`);
if (!(T.med < P.med)) bad("TRENCH should be harder than PvE (median peak)");
if (!(T.rugs >= N * 0.5)) bad(`TRENCH should rug often (${T.rugs}/${N})`);
if (!(T.ctos >= 1)) bad("TRENCH never had a CTO");
if (!(out.pve.rugs === 0 && out.pvp.rugs === 0)) bad("rugs outside TRENCH");
if (process.env.SIM_JSON) fs.writeFileSync(process.env.SIM_JSON, JSON.stringify(raw, null, 1));
cleanup();
if (fail) process.exit(1); else console.log("PASS");
