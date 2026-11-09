// Item c (#229 "buys over the cap fill the gap"): sizing + minOut ceiling are pure and sync (no RPC on the tap).
import { describe, expect, it } from "vitest";
import { buyFill, FILL_OVERSHOOT, nextAlert, ROOM_MARGIN_BPS } from "../lib/trade/tradeGuards";
import { roomCappedRange, tokensToWei } from "../lib/trade/queuePricing";

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
});
