/**
 * Data retest #2: ONE mcap source (lib/mcap.ts) — every surface must show the same number for the same chain state.
 * A mocked chain (graduated coin whose live QuotePricer is +0.10% vs its launch quote price, like RPGD; plus a 1M-supply
 * coin) is read through each surface's real code path:
 *   header (readCurveState) · home/launchpad cards (listLaunches) · HUD self-heal (reconcileMcap read) · portfolio
 *   price (readMarket) · holders (readCoinMcap + rankHolders) · live/backfilled hook Trade (hookTradeMcapUsd) ·
 *   /api/trades fill (toFill with the coinBasis the indexer passes).
 * Run: pnpm test:mcap
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PublicClient } from "viem";

const B = BigInt, WAD = B(10) ** B(18), Q96 = B(1) << B(96), Q128 = B(1) << B(128), Q64 = B(1) << B(64);
// Solidity McapMath.mcapQuoteFromSqrt (two mulDivs, floor each) — what curve.marketCapQuote() returns post-grad
const mcapQuoteFromSqrt = (sp: bigint, c0: boolean, supply: bigint) => c0 ? ((sp * sp) / Q64) * supply / Q128 : ((supply * Q96) / sp) * Q96 / sp;

type Coin = { token: `0x${string}`; curve: `0x${string}`; quote: `0x${string}`; supply: bigint; sqrtP: bigint; launchQp: bigint; liveQp: bigint };
const STRAT = "0xd4d0eb01960aace441bfcb323bfaf7c3d8b555a3" as const;   // 18-dec test STRATEGY (config-known decimals)
const mk = (n: number, supplyTokens: bigint, sqrtP: bigint): Coin => ({
  token: `0x${"0".repeat(38)}${n.toString(16).padStart(2, "0")}` as `0x${string}`, curve: `0x${"c".repeat(38)}${n.toString(16).padStart(2, "0")}` as `0x${string}`,
  quote: STRAT, supply: supplyTokens * WAD, sqrtP, launchQp: B("3100000000000000"), liveQp: B("3103100000000000"),   // live = launch × 1.001
});
// token < quote ⇒ currency0. price (quote/token) chosen so mcap ≈ $34K on 7B and ≈ $34K on 1M
const RPGD = mk(1, B(7_000_000_000), B("3487000000000000000000000000"));
const NEW1M = mk(2, B(1_000_000), B("230000000000000000000000000000"));
const COINS = [RPGD, NEW1M];
const byCurve = (a: string) => COINS.find((c) => c.curve.toLowerCase() === a.toLowerCase());
const byToken = (a: string) => COINS.find((c) => c.token.toLowerCase() === a.toLowerCase());

const { deployment } = await import("../lib/chains");
const d = deployment();
const mq = (c: Coin) => mcapQuoteFromSqrt(c.sqrtP, true, c.supply);
const pc = {
  async readContract({ address, functionName, args }: { address: string; functionName: string; args?: unknown[] }): Promise<unknown> {
    const a = address.toLowerCase();
    if (a === d.launchpad.toLowerCase()) {
      if (functionName === "curveOf") return byToken(String(args![0]))!.curve;
      if (functionName === "metaOf") return ["", "", ""];
    }
    if (a === d.marketLens.toLowerCase() && functionName === "market") {   // the OLD source: live pricer
      const c = byToken(String(args![0]))!; const m = (mq(c) * c.liveQp) / WAD; return [(mq(c) * WAD) / c.supply, m, true];
    }
    const c = byCurve(a);
    if (c) switch (functionName) {
      case "quote": return c.quote;
      case "quotePriceUsd": return c.launchQp;
      case "graduated": return true;
      case "marketCapQuote": return mq(c);
      case "marketCapUsd": case "mcapNow": return (mq(c) * c.liveQp) / WAD;   // post-grad curve uses the live pricer too
      case "quoteReserve": case "tokensSold": return B(0);
      case "creatorTaxBps": case "currentSnipeFeeBps": return B(0);
      case "progressBps": return B(10000);
      case "curveParams": return [c.supply, (c.supply * B(72)) / B(100), B(1), B(1)];
    }
    const t = byToken(a);
    if (t && functionName === "totalSupply") return t.supply;
    if (functionName === "decimals") return 18;
    throw new Error(`unmocked ${address}.${functionName}`);
  },
  async getContractEvents() {
    return COINS.map((c, i) => ({ args: { token: c.token, curve: c.curve, creator: c.token, quote: c.quote, name: "X", ticker: "X" }, blockNumber: B(10 + i), eventName: "Launched" }));
  },
  async getBlockNumber() { return B(100); },
} as unknown as PublicClient;

const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${what}: ${a} ≠ ${b}`);

test("every surface agrees on the launch-basis mcap (curve.marketCapQuote × launch quote price × the coin's own supply)", async () => {
  const { readCoinMcap, coinBasis } = await import("../lib/mcap");
  const { readCurveState, readMarket } = await import("../lib/protocol-viem");
  const { listLaunches, hookTradeMcapUsd, reconcileMcap, mcapOrderer } = await import("../lib/events");
  const { rankHolders } = await import("../lib/holders");
  const { toFill } = await import("../lib/server/trades");
  const cards = await listLaunches(pc, async () => new Map());
  for (const c of COINS) {
    const truth = Number((mq(c) * c.launchQp) / WAD) / 1e18;
    const lensOld = Number((mq(c) * c.liveQp) / WAD) / 1e18;
    assert.ok(Math.abs(lensOld / truth - 1.001) < 1e-6, "fixture: the old lens value is +0.10%");

    const helper = await readCoinMcap(pc, c.token);
    near(helper.mcapUsd, truth, "readCoinMcap");
    assert.equal(helper.supplyTokens, Number(c.supply / WAD), "supply comes from the coin");
    near((await readCurveState(pc, c.token)).mcapUsd, truth, "coin page header (readCurveState)");
    near(cards.find((x) => x.token === c.token)!.mcapUsd, truth, "home/launchpad card (listLaunches)");   // µ$ rounding
    const m = await readMarket(pc, c.token);
    near(m!.mcapUsd, truth, "readMarket"); near(m!.priceUsd * Number(c.supply / WAD), truth, "portfolio priceUsd × supply");

    // HUD self-heal: reconcileMcap's default read → orderer State
    const states: number[] = [];
    const ord = mcapOrderer((e) => { if ((e as { type: string }).type === "State") states.push((e as unknown as { mcapUsd: number }).mcapUsd); });
    const stop = reconcileMcap(c.token, ord, pc, 10); await new Promise((r) => setTimeout(r, 40)); stop();
    near(states[0], truth, "HUD self-heal (reconcileMcap)");

    // holders: /api/holders mcap = readCoinMcap; usd of a 10% holder
    const h = rankHolders({ ["0x" + "ab".repeat(20)]: (c.supply / B(10)).toString() }, { totalSupply: c.supply, mcapUsd: helper.mcapUsd, labels: {}, limit: 5 });
    near(h[0].usd!, truth / 10, "holders usd");

    // the trade at the current pool price: live/backfilled hook Trade event and the /api/trades fill
    const b = await coinBasis(pc, c.token, c.curve);
    near(hookTradeMcapUsd({ token: c.token, sqrtPriceAfter: c.sqrtP, priceAfterX18: B(1) }, c.launchQp, { quote: b.quote, supplyTokens: b.supplyTokens }), truth, "hook Trade event (chart)");
    const f = toFill({ transactionHash: "0x1", logIndex: 0, blockNumber: B(1) }, "hook",
      { token: c.token, trader: c.token, isBuy: true, tokenAmt: WAD, priceBeforeX18: B(1), priceAfterX18: B(1), sqrtPriceAfter: c.sqrtP, quotePriceUsd: b.launchQuoteUsd, quote: b.quote, supplyTokens: b.supplyTokens }, 0);
    near(f.mcapUsd, truth, "/api/trades fill"); near(f.priceUsd * Number(c.supply / WAD), truth, "/api/trades fill priceUsd");
  }
});

test("mcapUsdFromQuote: exact integer math, zero-safe", async () => {
  const { mcapUsdFromQuote } = await import("../lib/mcap");
  // RPGD on 46630 (read-only probe 2026-10-24): marketCapQuote 10996100321580795975772913 × launch price = $33,916.75,
  // the last /api/trades fill; MarketLens (live pricer) said $33,951.55.
  const q = B("10996100321580795975772913"), qp = B("3084434186546977");
  assert.equal(mcapUsdFromQuote(q, qp).toFixed(2), "33916.75");
  assert.equal(mcapUsdFromQuote(B(0), WAD), 0); assert.equal(mcapUsdFromQuote(WAD, B(0)), 0);
});
