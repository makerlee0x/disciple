// PAPER TRADING headless tests (spec v0.2 Sec. 11): determinism by seed, money + token conservation, ledger safety,
// difficulty ordering (Hard bots beat Easy bots on average), real mechanics parity with main (curveMath / sim market /
// sniper tax / holding caps / crew tip vs contracts/src/libraries/Constants.sol), fees + gas on every trade, tie-break,
// quit actions. Run: npm run test:paper
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PaperRound, PLAYER_ID, CREW_TIP_PPM } from "../lib/paper/engine";
import { roundJson, tradesCsv, curveCsv } from "../lib/paper/export";
import { DIFFICULTIES, START_CASH } from "../lib/paper/config";
import { paramsFromQuotePrice, quoteBuy, quoteSell, curveMcapAtFrac, WAD, TRADE_FEE_BPS } from "../lib/curveMath";
import { snipeFeeBpsAt } from "../lib/snipe";
import { CURVE } from "../lib/config";
import { HOLDING_CAP_BPS, MODE } from "../lib/modeRules";

const scripted = (r: PaperRound) => { // fixed player inputs by tick
  while (!r.ended) {
    if (r.tick === 40) r.intent({ kind: "buy", amountUsd: 25 });
    if (r.tick === 400) r.intent({ kind: "buy", amountUsd: 10 });
    if (r.tick === 1200) r.intent({ kind: "sell", pct: 50 });
    r.step();
  }
  return r;
};
const near = (a: number, b: number, rel = 1e-6) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));

test("determinism: same seed + same player inputs → identical standings and trade log", () => {
  for (const d of DIFFICULTIES) {
    const a = scripted(new PaperRound(d, 777)), b = scripted(new PaperRound(d, 777));
    assert.equal(a.trades.length, b.trades.length);
    assert.deepEqual(a.standings(), b.standings());
    assert.equal(JSON.stringify(roundJson(a)), JSON.stringify(roundJson(b)));
    const c = scripted(new PaperRound(d, 778));
    assert.notDeepEqual(c.standings().map((s) => s.finalNetWorth), a.standings().map((s) => s.finalNetWorth));
  }
});

test("conservation + ledger: money and tokens balance, no negative cash / tokens, 201 wallets, equal start", () => {
  for (const d of DIFFICULTIES) for (const seed of [1, 2, 3]) {
    const r = scripted(new PaperRound(d, seed));
    assert.equal(r.wallets.length, 201);
    assert.equal(r.startMoney, 201 * START_CASH[d]);
    const m = r.moneyCheck(); assert.ok(near(m.accounted, m.start, 1e-9), `${d}/${seed} money ${m.accounted} vs ${m.start}`);
    const t = r.tokenCheck(); assert.ok(near(t.held, t.sold, 1e-9), `${d}/${seed} tokens ${t.held} vs ${t.sold}`);
    for (const w of r.wallets) { assert.ok(w.cash >= -1e-9, `neg cash ${w.id}`); assert.ok(w.tokens >= 0); }
    assert.ok(["timer", "graduation"].includes(r.ended!));
    if (r.ended === "graduation") assert.ok(r.graduated && r.gradT! <= 600);
    else assert.equal(r.tick, 2400);
  }
});

test("fees: every trade carries the 1% trade fee and the $0.25 sample gas; wallet fee lines sum to the ledger", () => {
  const r = scripted(new PaperRound("medium", 5));
  for (const t of r.trades) { assert.equal(t.gasFee, 0.25); assert.ok(near(t.fee, t.cashAmount * 0.01, 1e-9)); }
  const fees = r.wallets.reduce((a, w) => a + w.feesPaid, 0), gas = r.wallets.reduce((a, w) => a + w.gasPaid, 0);
  assert.ok(near(fees, r.totals.fees, 1e-9)); assert.ok(near(gas, 0.25 * r.trades.length, 1e-9));
});

test("difficulty ordering: Hard bots beat Easy bots on average", () => {
  for (const d of DIFFICULTIES) {
    let easy = 0, hard = 0;
    for (let s = 0; s < 8; s++) {
      const r = new PaperRound(d, 500 + s).run(), st = r.standings();
      const avg = (tier: string) => { const xs = st.filter((x) => x.tier === tier); return xs.reduce((a, x) => a + x.finalNetWorth, 0) / xs.length; };
      easy += avg("easy"); hard += avg("hard");
    }
    assert.ok(hard > easy, `${d}: hard ${hard / 8} vs easy ${easy / 8}`);
  }
});

test("real mechanics parity with main: curve, fee, sniper tax, caps, crew tip", () => {
  const r = new PaperRound("medium", 1);
  // curve endpoints + shape = lib/curveMath (CurveMath.sol mirror)
  assert.ok(near(r.mcap, CURVE.startMcap, 1e-9));
  for (const g of [0.1, 0.3, 0.5, 0.8, 0.95]) assert.ok(near(r.m.mcapAt(g), curveMcapAtFrac(g), 1e-9));
  assert.ok(Math.abs(r.m.reserveAt(1) - 6454.55) < 1, `net buy to graduation ${r.m.reserveAt(1)}`);
  assert.equal(r.m.fee, Number(TRADE_FEE_BPS) / 10_000);
  // a paper buy fills the same tokens as the bigint quote (after the 7 s sniper window)
  const P = paramsFromQuotePrice(WAD);
  while (r.t < 8) r.tick++;
  const tr = r.buy(r.player, 30)!;
  const want = Number(quoteBuy(P, BigInt(0), BigInt(30) * WAD, BigInt(0))) / 1e18;
  assert.ok(near(tr.tokenAmount, want, 1e-6), `buy ${tr.tokenAmount} vs ${want}`);
  const soldWei = BigInt(Math.round(r.m.sold * 1e6)) * BigInt(1e12), inWei = BigInt(Math.round(tr.tokenAmount / 2 * 1e6)) * BigInt(1e12);
  const sWant = Number(quoteSell(P, soldWei, inWei, BigInt(0))) / 1e18;
  const before = r.player.cash, s = r.sell(r.player, Number(inWei) / 1e18)!;
  assert.ok(near(r.player.cash - before + s.crewTip + 0.25, sWant, 1e-5), `sell ${r.player.cash - before + 0.25} vs ${sWant}`);
  // sniper tax: the contract's per-second table
  for (let e = 0; e < 9; e++) assert.equal(Math.round(r.m.antiSnipe(e + 0.5) * 10_000), snipeFeeBpsAt(e + 0.5, CURVE.antiSnipeBpsBySec));
  const r2 = new PaperRound("easy", 2); assert.equal(r2.buy(r2.player, 10), null);   // t = 0: 1% + 99% → nothing left to buy with
  r2.tick = 4; const tx = r2.buy(r2.player, 10)!;                                        // t = 1 s → 25% sniper tax
  assert.ok(near(tx.snipeTax, tx.cashAmount * 0.25, 1e-9)); assert.equal(r2.totals.snipeHits, 1);
  // holding cap = BondingCurve.netCapNow (Easy coin: 1% → 3.33% of supply)
  const c = HOLDING_CAP_BPS[MODE.EASY]!;
  assert.ok(near(new PaperRound("easy", 3).capTokensNow(), 1e6 * c.start / 1e4));
  // constants straight from the contracts
  const sol = fs.readFileSync(new URL("../../contracts/src/libraries/Constants.sol", import.meta.url), "utf8");
  assert.equal(+sol.match(/PVE_CREW_TIP_PPM = (\d+)/)![1], CREW_TIP_PPM);
  assert.equal(+sol.match(/CREW_TIP_THRESHOLD_BPS_DEFAULT = (\d+)/)![1], r.cfg.crewTipThresholdBps);
  assert.equal(+sol.match(/PVE_CAP_START_BPS = (\d+)/)![1], c.start);
});

test("holding cap: a buy past the cap partially fills, never exceeds it", () => {
  const r = new PaperRound("hard", 4); while (r.t < 8) r.tick++;
  const t = r.buy(r.player, 900)!;
  assert.ok(t.capped); assert.ok(r.player.tokens <= r.capTokensNow() + 1e-6);
  assert.ok(r.player.cash > 900 - 900 * 0.5);
});

test("tie-break: identical net worth → higher realized PnL first, then fewer fees", () => {
  const r = new PaperRound("easy", 9), [a, b] = [r.wallets[1], r.wallets[2]];
  for (const w of r.wallets) { w.cash = 1; w.tokens = 0; }
  a.cash = b.cash = 150; a.realizedPnl = 10; b.realizedPnl = 20;
  let s = r.standings(); assert.equal(s[0].walletId, b.id); assert.equal(s[1].walletId, a.id);
  a.realizedPnl = 20; a.feesPaid = 1; b.feesPaid = 2; s = r.standings(); assert.equal(s[0].walletId, a.id);
});

test("quit: Leave freezes the wallet while the lobby runs; End Session ends with player_ended; rate limit 5/s", () => {
  const r = new PaperRound("medium", 11); r.intent({ kind: "buy", amountUsd: 10 }); r.step(); r.leave();
  const tok = r.player.tokens; assert.equal(r.intent({ kind: "sell", pct: 100 }), false);
  for (let i = 0; i < 100; i++) r.step();
  assert.equal(r.player.tokens, tok); assert.equal(r.ended, null);
  r.endSession(); assert.equal(r.ended, "player_ended"); r.step(); assert.equal(r.tick, 101);
  const q = new PaperRound("easy", 12); let ok = 0; for (let i = 0; i < 9; i++) ok += +q.intent({ kind: "buy", amountUsd: 10 }); assert.equal(ok, 5);
});

test("export: JSON + CSV carry curve path, fees, sniper tax, crew tips, archetype PnL", () => {
  const r = scripted(new PaperRound("easy", 13)), j = roundJson(r);
  assert.equal(j.simulated, true); assert.ok(j.curvePath.length > 100); assert.ok(j.summary.byArchetype.fomo);
  for (const k of ["fees", "gas", "sniperTax", "sniperTaxHits", "crewTipsTotal", "graduationSec", "leaderChanges"]) assert.ok(k in j.summary, k);
  assert.equal(tradesCsv(r).split("\n").length, r.trades.length + 1);
  assert.ok(curveCsv(r).startsWith("t,mcap"));
  assert.equal(j.standings.find((s) => s.walletId === PLAYER_ID)!.kind, "human");
});
