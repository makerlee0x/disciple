/**
 * Gasless fills emit UsdgTrade / UsdgRefund on deployment().gaslessRouter, but the
 * indexer only watched d.router. Realized P&L then used quote-value `usd` instead of
 * real USDG. Fixture: wallet 0x9292…d028 on GTNEAR 0x443C…b1E9, read from testnet 46630.
 *
 * Fail-before / pass-after: watching only the regular router yields realized ≈ -$6.78;
 * watching both routers (the usdgRouters() path) yields ≈ -$8.99.
 */
import { describe, expect, it } from "vitest";
import { attachRefunds, quoteUsd, usdgAmounts, usdgIndex, usdgKey, type Fill, type UsdgRefundArgs, type UsdgTradeArgs } from "../lib/trades";
import { positionFromFills, view, DEFAULT_SUPPLY, type ChainFill } from "../lib/pnl";
import { usdgRouters } from "../lib/server/trades";
import { DEPLOYMENTS, ZERO } from "../lib/chains";
import fx from "./fixtures/gtnear-usdg-pnl.json";

const REGULAR = fx.regularRouter;
const GASLESS = fx.gaslessRouter;

/** Mirror of indexTrades: collect UsdgTrade/UsdgRefund from the given routers, attach refunds, apply to Trade fills. */
type IndexedFill = ChainFill & Pick<Fill, "usdInGross">;
function chainFills(routers: readonly string[]): IndexedFill[] {
  const allow = new Set(routers.map((r) => r.toLowerCase()));
  const trades: { tx: string; args: UsdgTradeArgs }[] = [];
  const refunds: { tx: string; args: UsdgRefundArgs }[] = [];
  for (const f of fx.fills) {
    if (f.usdgTrade && allow.has(f.usdgTrade.address.toLowerCase())) {
      trades.push({
        tx: f.tx,
        args: {
          trader: fx.wallet,
          token: fx.coin,
          isBuy: f.usdgTrade.isBuy,
          amountIn: BigInt(f.usdgTrade.amountIn),
          amountOut: BigInt(f.usdgTrade.amountOut),
        },
      });
    }
    if (f.usdgRefund && allow.has(f.usdgRefund.address.toLowerCase())) {
      refunds.push({
        tx: f.tx,
        args: {
          trader: fx.wallet,
          token: fx.coin,
          quoteRefund: BigInt(f.usdgRefund.quoteRefund),
          usdgRefund: BigInt(f.usdgRefund.usdgRefund),
        },
      });
    }
  }
  const idx = usdgIndex(attachRefunds(trades, refunds));
  return fx.fills.map((f) => {
    const usd = quoteUsd(BigInt(f.quoteAmt), BigInt(fx.quotePriceUsd));
    const tokens = Number(BigInt(f.tokenAmt)) / 1e18;
    const u = idx.get(usdgKey(f.tx, fx.coin, f.isBuy))?.shift();
    return {
      side: f.isBuy ? "buy" as const : "sell" as const,
      tokens,
      usd,
      ...usdgAmounts(u, fx.usdgDecimals),
      block: f.block,
      logIndex: f.tradeLogIndex,
    };
  });
}

const sellIdx = fx.fills.findIndex((f) => !f.isBuy);

describe("gasless UsdgTrade PnL (GTNEAR fixture)", () => {
  it("usdgRouters watches gaslessRouter with the same d.router pattern", () => {
    // GTNEAR fixture stack (v5: separate regular and gasless routers)
    const r = usdgRouters({ router: REGULAR, gaslessRouter: GASLESS });
    expect(r.map((a) => a.toLowerCase())).toEqual([REGULAR.toLowerCase(), GASLESS.toLowerCase()]);
    // v6 fallbacks: one DiscipleRouter is both ⇒ watched once
    expect(usdgRouters(DEPLOYMENTS[46630]).map((a) => a.toLowerCase())).toEqual([DEPLOYMENTS[46630].router.toLowerCase()]);
    expect(usdgRouters({ router: ZERO, gaslessRouter: GASLESS }).map((a) => a.toLowerCase())).toEqual([GASLESS.toLowerCase()]);
    expect(usdgRouters({ router: REGULAR, gaslessRouter: ZERO })).toEqual([REGULAR]);
  });

  it("watching only the regular router books quote-value usd and realized ≈ -$6.78 (fail-before)", () => {
    const fills = chainFills([REGULAR]);
    expect(fills.every((f) => f.usdIn === undefined && f.usdOut === undefined)).toBe(true);
    const first = fills[0]!;
    const sell = fills[sellIdx]!;
    const lastBuyBeforeSell = fills[sellIdx - 1]!;
    expect(first.usd).toBeCloseTo(8.84, 2);
    expect(lastBuyBeforeSell.side).toBe("buy");
    expect(lastBuyBeforeSell.usd).toBeCloseTo(9.95, 2);
    expect(sell.side).toBe("sell");
    expect(sell.usd).toBeCloseTo(345.30, 2);
    const p = positionFromFills(fills);
    expect(p.realized).toBeCloseTo(-6.78, 2);
  });

  it("watching gaslessRouter books real USDG and realized ≈ -$8.99 (pass-after)", () => {
    const fills = chainFills(usdgRouters({ router: REGULAR, gaslessRouter: GASLESS }));
    expect(fills[0]!.usdIn).toBeCloseTo(8.97863, 5);
    expect(fills[0]!.usdInGross).toBeCloseTo(25, 6);
    expect(fills[1]!.usdIn).toBe(50);
    expect(fills[3]!.usdIn).toBe(100);
    expect(fills[sellIdx - 1]!.usdIn).toBe(10);
    const sell = fills[sellIdx]!;
    expect(sell.usdOut).toBeCloseTo(344.990689, 6);
    // later $10 buys also book real USDG, not ~$9.95 quote value
    expect(fills[sellIdx + 1]!.usdIn).toBe(10);
    const p = positionFromFills(fills);
    expect(p.realized).toBeCloseTo(-8.99, 2);
    expect(p.realized).toBeCloseTo(-8.987941, 5);
  });

  it("avg entry and cost basis reset to the new buy after a full sell (unchanged)", () => {
    const fills = chainFills(usdgRouters({ router: REGULAR, gaslessRouter: GASLESS }));
    const throughSell = fills.slice(0, sellIdx + 1);
    const closed = positionFromFills(throughSell);
    expect(closed.size).toBe(0);
    expect(closed.costBasis).toBe(0);
    expect(closed.realized).toBeCloseTo(-8.99, 2);
    expect(view(closed, 1, DEFAULT_SUPPLY).avgEntryUsd).toBe(0);

    const firstNew = positionFromFills(fills.slice(0, sellIdx + 2));
    const newBuy = fills[sellIdx + 1]!;
    expect(firstNew.costBasis).toBe(10);
    expect(firstNew.size).toBeCloseTo(newBuy.tokens, 12);
    expect(firstNew.costBasis / firstNew.size).toBeCloseTo(10 / newBuy.tokens, 12);
    expect(view(firstNew, 1, DEFAULT_SUPPLY).avgEntryUsd).toBeCloseTo(10 / newBuy.tokens, 12);
    expect(firstNew.realized).toBeCloseTo(closed.realized, 12);
  });
});
