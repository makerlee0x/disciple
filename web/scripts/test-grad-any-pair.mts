// site/grad-any-pair: stable trade error kinds (GAME), out-of-gas detection, and minOut vs the session policy floor.
//   pnpm test:grad-any-pair   (pure: no RPC)
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeErrorResult, encodeEventTopics, parseAbi, toFunctionSelector, type Hex } from "viem";
import { friendlyError, isOutOfGas, ProtocolError, tradeErrorKind, tradeErrorKindOf, type TradeErrorKind } from "../lib/protocol-viem";
import { AAError } from "../lib/aa/core";
import { opGasUsed } from "../lib/aa/mav2";
import { ENTRYPOINT_V07 } from "../lib/aa/constants";
import { applySlippage } from "../lib/curveMath";
import { clampSlippage, meetsPolicyFloor, policyMinOutFloor } from "../lib/aa/slippage";
import { scaledQuote } from "../lib/trade/hotCache";
import { GRAD_QUOTE_MARGIN_BPS, withGradMargin } from "../lib/trade/gradNeed";

const E = parseAbi([
  "error MinOutTooLow(uint256 minOut, uint256 required)", "error PreExecHookReverted(bytes24 moduleFunction, bytes revertReason)",
  "error PriceImpactTooHigh(uint256 impactBps, uint256 maxImpactBps)", "error Slippage()",
]);
const POLICY = ("0x92b38057bb7bfa7d640e836e9b3aa8c7365720ac" + "00000000" + "0000000000000000") as Hex;   // bytes24 module fn
const minOutErr = encodeErrorResult({ abi: E, errorName: "MinOutTooLow", args: [BigInt("4114000000000000000"), BigInt("7896000000000000000")] });
const hooked = encodeErrorResult({ abi: E, errorName: "PreExecHookReverted", args: [POLICY.slice(0, 50) as Hex, minOutErr] });
const impact = encodeErrorResult({ abi: E, errorName: "PriceImpactTooHigh", args: [BigInt(12931), BigInt(5000)] });

test("PriceImpactTooHigh selector is the router's (0x1afa833a)", () => {
  assert.equal(impact.slice(0, 10), "0x1afa833a");
  assert.equal(hooked.slice(0, 10), "0x74a1a72c");
  assert.equal(minOutErr.slice(0, 10), "0x6c34de9d");
});
test("kinds: PRICE_IMPACT / MIN_OUT (also wrapped in PreExecHookReverted) / OTHER; messages unchanged", () => {
  const pi = friendlyError(new AAError("Reverted", "x", { revertData: impact }));
  assert.equal(pi.code, "PriceImpactTooHigh"); assert.equal(pi.kind, "PRICE_IMPACT");
  assert.equal(pi.message, "Price impact too high for the router cap. Try a smaller shot.");
  const mo = friendlyError(new AAError("Reverted", "x", { revertData: hooked }));
  assert.equal(mo.code, "MinOutTooLow"); assert.equal(mo.kind, "MIN_OUT");
  assert.equal(mo.message, "Price moved, trade not sent. Try again.");
  const est = friendlyError(new AAError("Estimate", "simulation failed: x", { revertData: hooked }));
  assert.equal(est.kind, "MIN_OUT");
  assert.equal(friendlyError(new AAError("Reverted", "x", { revertData: encodeErrorResult({ abi: E, errorName: "Slippage" }) })).kind, "MIN_OUT");
  // raw errors classify the same, without going through friendlyError
  assert.equal(tradeErrorKind(new AAError("Reverted", "x", { revertData: hooked })), "MIN_OUT");
  assert.equal(tradeErrorKind(new AAError("Estimate", "x", { revertData: impact })), "PRICE_IMPACT");
  assert.equal(tradeErrorKind(new Error("boom")), "OTHER");
  assert.equal(tradeErrorKind(new ProtocolError("InsufficientBalance", "x")), "OTHER");
  const k: TradeErrorKind[] = ["PRICE_IMPACT", "MIN_OUT", "OUT_OF_GAS", "OTHER"];
  assert.deepEqual(k.map((x) => typeof x), ["string", "string", "string", "string"]);
  assert.equal(tradeErrorKindOf("V4TooLittleReceived"), "MIN_OUT");
  assert.equal(tradeErrorKindOf("Whatever", true), "OUT_OF_GAS");
});
test("OUT_OF_GAS: UserOperation reverted with empty data and gas used ≈ the limit (IRON 18:46–18:55 CDT shape)", () => {
  // IRON: callGasLimit 1.8M (STATIC_GAS), actualGasUsed ≈ 1.915M (verification + execution + 10% unused penalty), no reason
  const oog = new AAError("Reverted", "That didn't go through. Try again.", { userOpHash: "0x01", revertData: undefined, actualGasUsed: BigInt(1_915_000), callGasLimit: BigInt(1_800_000) });
  assert.equal(isOutOfGas(oog.extra), true);
  const pe = friendlyError(oog);
  assert.equal(pe.code, "Reverted"); assert.equal(pe.kind, "OUT_OF_GAS");
  assert.equal(pe.message, "That didn't go through. Try again.");   // copy unchanged (GAME owns new copy)
  assert.equal(tradeErrorKind(oog), "OUT_OF_GAS");
  // "0x" revert data counts as empty
  assert.equal(isOutOfGas({ revertData: "0x", actualGasUsed: BigInt(1_800_000), callGasLimit: BigInt(1_800_000) }), true);
  // a reverted op that used little gas / has a reason / lacks gas numbers is NOT out of gas
  assert.equal(isOutOfGas({ actualGasUsed: BigInt(700_000), callGasLimit: BigInt(1_800_000) }), false);
  assert.equal(isOutOfGas({ revertData: hooked, actualGasUsed: BigInt(1_900_000), callGasLimit: BigInt(1_800_000) }), false);
  assert.equal(isOutOfGas({}), false);
  assert.equal(friendlyError(new AAError("Reverted", "x", {})).kind, "OTHER");
  assert.equal("outOfGas" in friendlyError(new AAError("Reverted", "x", {})), false);   // no own key unless OOG
});
test("opGasUsed reads UserOperationEvent.actualGasUsed for the op", () => {
  const ev = parseAbi(["event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"]);
  const h = ("0x" + "ab".repeat(32)) as Hex;
  const topics = encodeEventTopics({ abi: ev, eventName: "UserOperationEvent", args: { userOpHash: h, sender: "0x3267000000000000000000000000000000000000", paymaster: "0xB3DB53C1E94F146194756FF456479ea0577E7d7E" } }) as Hex[];
  const data = encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], [BigInt(5), false, BigInt(123), BigInt(1_915_000)]);
  assert.equal(opGasUsed([{ address: ENTRYPOINT_V07, data, topics }], h), BigInt(1_915_000));
  assert.equal(opGasUsed([{ address: ENTRYPOINT_V07, data, topics }], ("0x" + "cd".repeat(32)) as Hex), undefined);
  assert.equal(opGasUsed([{ address: "0x0000000000000000000000000000000000000001", data, topics }], h), undefined);
  void toFunctionSelector;
});
test("minOut from an EXACT quote clears the DiscipleSessionPolicy floor on the first try (buys and sells)", () => {
  // policy 1.4.1: required = quoted × (10000 − maxSlippageBps) / 10000; the client asks for ≤ max − 0.5% (clampSlippage)
  for (const max of [10, 100, 500, 1000, 5000]) {
    const slip = clampSlippage(undefined, max).bps ?? 100;   // auto (1%) or the cap
    for (const quoted of [BigInt("8311540968438296657"), BigInt(1_000_000), BigInt(997), BigInt("123456789012345678901234")]) {
      const minOut = applySlippage(quoted, Math.min(slip, max));
      assert.ok(meetsPolicyFloor(minOut, quoted, max), `max ${max} quoted ${quoted}`);
      // the live quote at execution may be a hair better (up to the 50 bps headroom) and still pass
      if (max > 50) assert.ok(meetsPolicyFloor(minOut, (quoted * BigInt(10_000 + 40)) / BigInt(10_000), max));
    }
  }
  assert.equal(policyMinOutFloor(BigInt(10_000), 500), BigInt(9_500));
});
test("near graduation, the old down-scaled warm quote broke the floor (the IRON MinOutTooLow); the exact quote does not", () => {
  // IRON: $2 warm quote capped at the remaining 8.3115 tokens; a $1 tap down-scaled to 8.3115/2 ⇒ minOut 4.11e18 < 7.9e18
  const remaining = BigInt("8311540968438296657");
  const last = { amountIn: BigInt(2_000_000), amountOut: remaining, at: 1000 };
  const scaled = scaledQuote(last, BigInt(1_000_000), 1500, 1001)!;
  const exactQuoted = remaining;   // $1 still buys all remaining tokens
  assert.equal(meetsPolicyFloor(applySlippage(scaled, 450), exactQuoted, 500), false);
  assert.equal(meetsPolicyFloor(applySlippage(exactQuoted, 450), exactQuoted, 500), true);
  // sells: concave — the scale of a bigger warm sell under-quotes a smaller one too; exact always passes
  const sellLast = { amountIn: BigInt(10) ** BigInt(21), amountOut: BigInt(5_000_000), at: 1000 };
  const sScaled = scaledQuote(sellLast, BigInt(10) ** BigInt(20), 1500, 1001)!;
  const sExact = BigInt(800_000);   // a 10× smaller sell gets a much better average price
  assert.equal(meetsPolicyFloor(applySlippage(sScaled, 450), sExact, 500), false);
  assert.equal(meetsPolicyFloor(applySlippage(sExact, 450), sExact, 500), true);
});
test("grad margin is 0.5% (client and relay share it)", () => {
  assert.equal(GRAD_QUOTE_MARGIN_BPS, BigInt(50));
  assert.equal(withGradMargin(BigInt(10_000)), BigInt(10_050));
});
