/** Included-revert strike policy and gasless gas-cap helper. */
import { describe, expect, it } from "vitest";
import { toBytes, keccak256, slice } from "viem";
import { shouldStrikeIncludedRevert, revertSelector, TRADER_FAULT_SELECTORS } from "../lib/server/gaslessStrike";
import { GASLESS_GAS_LIMIT, GASLESS_GRAD_GAS_LIMIT, gaslessTxGasLimit } from "../lib/trade/gaslessPermit2";

const sel = (sig: string) => slice(keccak256(toBytes(sig)), 0, 4);

describe("shouldStrikeIncludedRevert", () => {
  it("does not strike a revert that is not the trader's fault (gas cap / slippage / price / unknown)", () => {
    const osh = "0x" + "ff".repeat(32);
    expect(shouldStrikeIncludedRevert({ revertData: sel("Slippage()") })).toBe(false);
    expect(shouldStrikeIncludedRevert({ revertData: sel("Expired()") })).toBe(false);
    expect(shouldStrikeIncludedRevert({ revertData: sel("PriceImpactTooHigh(uint256,uint256)") + "0".repeat(128) })).toBe(false);
    expect(shouldStrikeIncludedRevert({ revertData: sel("BadParam()") })).toBe(false);
    expect(shouldStrikeIncludedRevert({ revertData: undefined, gasUsed: 882_527n, gasLimit: 900_000n })).toBe(false);
    expect(shouldStrikeIncludedRevert({ revertData: osh, gasUsed: 900_000n, gasLimit: 900_000n })).toBe(false);
    expect(shouldStrikeIncludedRevert({})).toBe(false);
  });

  it("still strikes a trader-caused failure (bad signature or reused nonce)", () => {
    expect(shouldStrikeIncludedRevert({ revertData: sel("InvalidNonce()") })).toBe(true);
    expect(shouldStrikeIncludedRevert({ revertData: sel("BadSigner()") })).toBe(true);
    expect(shouldStrikeIncludedRevert({ revertData: sel("BadPermit()") })).toBe(true);
    expect(shouldStrikeIncludedRevert({ revertData: sel("InvalidSignature()") })).toBe(true);
    expect(TRADER_FAULT_SELECTORS.has(revertSelector(sel("InvalidNonce()"))!)).toBe(true);
  });
});

describe("gaslessTxGasLimit", () => {
  it("keeps the normal cap unless the buy fills the curve", () => {
    expect(GASLESS_GAS_LIMIT).toBe(900_000n);
    expect(GASLESS_GRAD_GAS_LIMIT).toBe(3_000_000n);
    expect(gaslessTxGasLimit(false)).toBe(900_000n);
    expect(gaslessTxGasLimit(true)).toBe(3_000_000n);
  });
});
