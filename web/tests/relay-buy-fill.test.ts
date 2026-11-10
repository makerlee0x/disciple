// Item c (#229 "buys over the cap fill the gap"): sizing + minOut ceiling are pure and sync (no RPC on the tap).
import { describe, expect, it } from "vitest";
import { buyFill, FILL_OVERSHOOT, nextAlert, ROOM_MARGIN_BPS } from "../lib/trade/tradeGuards";
import { cappedBuyRange, roomCappedRange, tokensToWei, tradeMinOut } from "../lib/trade/queuePricing";
import { meetsPolicyFloor, sessionCapBps } from "../lib/aa/slippage";

const cap = (holding: number) => ({ capBps: 100, supply: 1_000_000, holding, pendingBuyTokens: 0, priceUsd: 0.0025 });   // 1 % cap = 10k tokens = $25
describe("over-cap buys fill the room", () => {
  it("under the room: unchanged", () => { expect(buyFill(10, cap(0))).toEqual({ usd: 10, capped: false, fillUsd: 10 }); });
  it("over the room: sends room × overshoot (≤ typed), minOut ceiling = room − margin, not held", () => {
    const f = buyFill(50, cap(280));   // room 9,720 tokens ≈ $24.30
    expect(f.capped).toBe(true);
    expect(f.usd).toBeCloseTo(Math.ceil(24.3 * FILL_OVERSHOOT * 100) / 100, 2);
    expect(f.roomOut).toBeCloseTo(9720 * (1 - ROOM_MARGIN_BPS / 10_000), 6);
    expect(f.fillUsd).toBeCloseTo(24.3, 6);
    expect(nextAlert("buy", 50, { cap: cap(280) })).toBeNull();
  });
  it("cash caps the overshoot; a full wallet is still held", () => {
    expect(buyFill(50, cap(280), 26).usd).toBe(26);
    expect(nextAlert("buy", 5, { cap: cap(10_000) })?.kind).toBe("walletcap");
    expect(buyFill(5, cap(10_000)).capped).toBe(false);
  });
  it("minOut never asks for more than the room", () => {
    const room = tokensToWei(9672.4, 18);
    expect(roomCappedRange({ lo: room * 2n, hi: room * 3n }, room)).toEqual({ lo: room, hi: room });
    expect(roomCappedRange({ lo: 5n, hi: 9n }, room)).toEqual({ lo: 5n, hi: 9n });
    expect(roomCappedRange({ lo: 5n, hi: 9n }, null)).toEqual({ lo: 5n, hi: 9n });
    expect(tokensToWei(1.5, 18)).toBe(15n * 10n ** 17n);
    expect(tokensToWei(-1, 18)).toBe(0n);
  });
  // lee, Nov 9 21:24 CT: "if their buy goes over, whatever just refund them back on that" ⇒ never revert for going over.
  // The curve fills EXACTLY the on-chain room (partial fill) and refunds the rest; minOut must be ≤ that fill, and under
  // a one-tap session ≥ the policy floor (capped live quote × (1 − max)).
  const E = 10n ** 18n;
  const chainRoom = 9_000n * E;           // what the curve will fill (quoteUsdgRouteFor / quoteBuyFor, capped)
  const uncapped = { lo: 12_000n * E, hi: 12_100n * E };   // memory / model quote for the sent $, cap-unaware
  const staleRoom = tokensToWei(9_720 * (1 - ROOM_MARGIN_BPS / 10_000), 18);   // client cache overstates the room by 8 %
  for (const max of [500, 1500]) {
    it(`over-cap buy, session max ${max} bps: minOut from the capped chain quote is within [policy floor, fill]`, () => {
      const mo = tradeMinOut(cappedBuyRange(uncapped, chainRoom, staleRoom), sessionCapBps(max), max);
      expect(mo <= chainRoom).toBe(true);                   // curve: tokensOut (= room) ≥ minOut ⇒ no Slippage revert
      expect(meetsPolicyFloor(mo, chainRoom, max)).toBe(true);   // policy: no MinOutTooLow
      // the old room − 0.5 % ceiling on a stale room would have asked for more than the fill (5 % session)
      if (max === 500) expect(tradeMinOut(roomCappedRange(uncapped, staleRoom), sessionCapBps(max), max) > chainRoom).toBe(true);
    });
  }
  it("owner-signed (no session): minOut is a dust floor ≤ the fill; own buys in flight keep the cached-room ceiling", () => {
    const mo = tradeMinOut(cappedBuyRange(uncapped, chainRoom, staleRoom), 9_999, null);
    expect(mo > 0n && mo <= chainRoom).toBe(true);
    expect(cappedBuyRange(uncapped, 9_900n * E, 9_500n * E, true)).toEqual({ lo: 9_500n * E, hi: 9_500n * E });
    expect(cappedBuyRange(uncapped, 9_900n * E, 9_500n * E, false)).toEqual({ lo: 9_900n * E, hi: 9_900n * E });
    expect(cappedBuyRange(uncapped, undefined, staleRoom)).toEqual({ lo: staleRoom, hi: staleRoom });   // unreadable ⇒ as before
  });
});
