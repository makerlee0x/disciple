/** lib/fund: where the card buys (USDC on Base first), backing out says nothing, Apple devices open on Apple Pay. */
import { describe, expect, it } from "vitest";
import { cardSource, fundErrorResult, payHint, FUND_COPY } from "../lib/fund";

const usdc = (chains: Array<[string, string, boolean?]>) => ({
  currencies: [
    { symbol: "ETH", chains: [{ caip2: "eip155:8453", address: "0xeee" }] },
    { symbol: "usdc", chains: chains.map(([caip2, address, ok]) => ({ caip2, address, ...(ok === undefined ? {} : { can_be_relay_deposit_source: ok }) })) },
  ],
});

describe("cardSource", () => {
  it("picks USDC on Base when the config has it", () => {
    expect(cardSource(usdc([["eip155:1", "0xeth"], ["eip155:8453", "0xbase"], ["eip155:42161", "0xarb"]]))).toEqual({ chain: "eip155:8453", usdc: "0xbase" });
  });
  it("falls back to Arbitrum, then Polygon, then Ethereum", () => {
    expect(cardSource(usdc([["eip155:1", "0xeth"], ["eip155:42161", "0xarb"]]))).toEqual({ chain: "eip155:42161", usdc: "0xarb" });
    expect(cardSource(usdc([["eip155:1", "0xeth"]]))).toEqual({ chain: "eip155:1", usdc: "0xeth" });
  });
  it("skips a chain that can't be a deposit source", () => {
    expect(cardSource(usdc([["eip155:8453", "0xbase", false], ["eip155:137", "0xpoly", true]]))).toEqual({ chain: "eip155:137", usdc: "0xpoly" });
  });
  it("null with no config, no USDC, or only other chains", () => {
    expect(cardSource(null)).toBeNull();
    expect(cardSource({ currencies: [] })).toBeNull();
    expect(cardSource(usdc([["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "EPjF"]]))).toBeNull();
  });
});

describe("fundErrorResult", () => {
  it("closing the checkout is silent", () => {
    expect(fundErrorResult(new Error("User exited the flow"))).toEqual({ ok: false, closed: true });
    expect(fundErrorResult(Object.assign(new Error("x"), { name: "UserExitedError" }))).toEqual({ ok: false, closed: true });
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
