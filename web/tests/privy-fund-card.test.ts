/** Card / Apple Pay: the Relay deposit-address quote (USDC on Base → USDG cash), the server answer the checkout pays,
 *  backing out says nothing, Apple devices open on Apple Pay. */
import { describe, expect, it, vi } from "vitest";
import { fundErrorResult, parseCardTarget, payHint, FUND_COPY } from "../lib/fund";
import { BASE_USDC, cardDepositAddress, cardQuoteBody } from "../lib/server/cardDeposit";
import { RH_USDG } from "../lib/server/lighter/bridge";

const W = "0x1111111111111111111111111111111111111111";
const DEP = "0x2222222222222222222222222222222222222222";

describe("cardQuoteBody", () => {
  it("USDC on Base in, USDG on Robinhood Chain out, into and refunded to the player's own wallet", () => {
    expect(cardQuoteBody(W, 9.55)).toEqual({
      user: W, recipient: W, refundTo: W, useDepositAddress: true, tradeType: "EXACT_INPUT",
      originChainId: 8453, originCurrency: BASE_USDC, destinationChainId: 4663, destinationCurrency: RH_USDG, amount: "9550000",
    });
  });
});

describe("cardDepositAddress", () => {
  const ok = { steps: [{ id: "deposit", depositAddress: DEP }], details: { currencyOut: { amount: "9500000" } }, fees: { relayer: { amountUsd: "0.04" } } };
  it("returns Relay's deposit address", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(ok), { status: 200 }));
    await expect(cardDepositAddress(W, 10, f as unknown as typeof fetch)).resolves.toEqual({ address: DEP, outUsd: 9.5, feeUsd: 0.04 });
  });
  it("refuses amounts out of range before calling Relay", async () => {
    const f = vi.fn();
    await expect(cardDepositAddress(W, 2, f as unknown as typeof fetch)).rejects.toThrow(/Pick/);
    await expect(cardDepositAddress(W, Number.NaN, f as unknown as typeof fetch)).rejects.toThrow(/Pick/);
    expect(f).not.toHaveBeenCalled();
  });
  it("a Relay error or odd answer fails", async () => {
    const bad = vi.fn(async () => new Response(JSON.stringify({ message: "no route" }), { status: 400 }));
    await expect(cardDepositAddress(W, 10, bad as unknown as typeof fetch)).rejects.toThrow("no route");
    const odd = vi.fn(async () => new Response(JSON.stringify({ steps: [] }), { status: 200 }));
    await expect(cardDepositAddress(W, 10, odd as unknown as typeof fetch)).rejects.toThrow(/didn't answer/);
  });
});

describe("parseCardTarget", () => {
  it("reads the server's answer", () => {
    expect(parseCardTarget({ ok: true, address: DEP, chain: "eip155:8453", asset: BASE_USDC })).toEqual({ address: DEP, chain: "eip155:8453", asset: BASE_USDC });
  });
  it("null on a failure or a bad shape", () => {
    expect(parseCardTarget({ ok: false, reason: "Sign in first." })).toBeNull();
    expect(parseCardTarget({ ok: true, address: "nope", chain: "eip155:8453", asset: BASE_USDC })).toBeNull();
    expect(parseCardTarget({ ok: true, address: DEP, chain: "base", asset: BASE_USDC })).toBeNull();
    expect(parseCardTarget(null)).toBeNull();
  });
});

describe("fundErrorResult", () => {
  it("closing the checkout is silent", () => {
    expect(fundErrorResult(new Error("User exited flow"))).toEqual({ ok: false, closed: true });
  });
  it("anything else is the one unavailable line", () => {
    expect(fundErrorResult(new Error("no quotes"))).toEqual({ ok: false, message: FUND_COPY.unavailable });
    expect(fundErrorResult(undefined)).toEqual({ ok: false, message: FUND_COPY.unavailable });
  });
});

describe("payHint", () => {
  it("Apple Pay on iPhone and Mac, card elsewhere", () => {
    expect(payHint("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("APPLE_PAY");
    expect(payHint("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("APPLE_PAY");
    expect(payHint("Mozilla/5.0 (Linux; Android 15)")).toBe("CREDIT_DEBIT_CARD");
  });
});
