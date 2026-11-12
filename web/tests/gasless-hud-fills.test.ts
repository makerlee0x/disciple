/**
 * The live HUD (decodeTradeFill) only trusted UsdgTrade / UsdgRefund on d.router, so a
 * fresh gasless fill fell back to quote-value (or null). Fixture: real GTNEAR receipt
 * logs for wallet 0x9292…d028, testnet 46630.
 *
 * Fail-before / pass-after: watching only the regular router yields quote-value (or no
 * usdg fill); passing usdgRouters() (regular + gasless) yields real USDG.
 */
import { describe, expect, it } from "vitest";
import { decodeTradeFill, type LogLike } from "../lib/flight/fills";
import { usdgRouters } from "../lib/chains";
import fx from "./fixtures/gtnear-hud-fills.json";

const REGULAR = fx.regularRouter;
const GASLESS = fx.gaslessRouter;
const both = usdgRouters({ router: REGULAR, gaslessRouter: GASLESS });

function logsOf(name: string): LogLike[] {
  const r = fx.receipts.find((x) => x.name === name);
  if (!r) throw new Error(name);
  return r.logs;
}
function expected(name: string) {
  const r = fx.receipts.find((x) => x.name === name);
  if (!r) throw new Error(name);
  return r.expected;
}

const base = { token: fx.coin, trader: fx.wallet, usdgDecimals: fx.usdgDecimals, supply: 1_000_000 };

describe("live HUD decodeTradeFill watches gaslessRouter", () => {
  it("usdgRouters is the same regular + gasless list the indexer uses", () => {
    expect(both.map((a) => a.toLowerCase())).toEqual([REGULAR.toLowerCase(), GASLESS.toLowerCase()]);
  });

  it("graduating gasless buy: regular router only books quote-value; usdgRouters books real USDG net of refund (fail-before / pass-after)", () => {
    const logs = logsOf("gradBuy");
    const want = expected("gradBuy");
    const before = decodeTradeFill(logs, { ...base, router: REGULAR });
    expect(before).not.toBeNull();
    expect(before!.source).toBe("curve");
    expect(before!.usd).toBeCloseTo(8.839825630365986, 8);
    expect(before!.refundUsd).toBeUndefined();
    expect(before!.usd).not.toBeCloseTo(want.usd, 3);

    const after = decodeTradeFill(logs, { ...base, router: both });
    expect(after!.source).toBe("usdg");
    expect(after!.side).toBe("buy");
    expect(after!.usd).toBeCloseTo(want.usd, 5);
    expect(after!.refundUsd).toBeCloseTo(want.refundUsd!, 5);
    expect(after!.tokens).toBeCloseTo(want.tokens, 8);

    // a single gasless address also works; the HUD passes the full list
    const gaslessOnly = decodeTradeFill(logs, { ...base, router: GASLESS });
    expect(gaslessOnly).toEqual(after);
  });

  it("gasless hook buy and sell: regular router only misses UsdgTrade; usdgRouters books $10 in / $344.990689 out", () => {
    const buyLogs = logsOf("buy10");
    const sellLogs = logsOf("sell");
    const buyWant = expected("buy10");
    const sellWant = expected("sell");

    const buyBefore = decodeTradeFill(buyLogs, { ...base, router: REGULAR });
    const sellBefore = decodeTradeFill(sellLogs, { ...base, router: REGULAR });
    // no mark → venue fallback cannot price a hook Trade, so the HUD would keep the estimate
    expect(buyBefore).toBeNull();
    expect(sellBefore).toBeNull();

    const buyAfter = decodeTradeFill(buyLogs, { ...base, router: both });
    expect(buyAfter!.source).toBe("usdg");
    expect(buyAfter!.usd).toBe(buyWant.usd);
    expect(buyAfter!.tokens).toBeCloseTo(buyWant.tokens, 8);

    const sellAfter = decodeTradeFill(sellLogs, { ...base, router: both });
    expect(sellAfter!.source).toBe("usdg");
    expect(sellAfter!.usd).toBeCloseTo(sellWant.usd, 6);
    expect(sellAfter!.tokens).toBeCloseTo(sellWant.tokens, 8);
  });

  it("regular-router receipts still decode the same when the allow-list also includes gaslessRouter", () => {
    const want = expected("gradBuy");
    const asRegular: LogLike[] = logsOf("gradBuy").map((l) =>
      l.address.toLowerCase() === GASLESS.toLowerCase() ? { ...l, address: REGULAR } : l,
    );
    const historical = decodeTradeFill(asRegular, { ...base, router: REGULAR });
    expect(historical!.source).toBe("usdg");
    expect(historical!.usd).toBeCloseTo(want.usd, 5);
    expect(historical!.refundUsd).toBeCloseTo(want.refundUsd!, 5);

    const widened = decodeTradeFill(asRegular, { ...base, router: both });
    expect(widened).toEqual(historical);
  });
});
