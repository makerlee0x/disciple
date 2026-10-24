// FLOW 2: sells/buys show the REAL revert reason and min-out reverts are retryable.   pnpm test:trade-errors (pure)
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeErrorResult, parseAbi, type Hex } from "viem";
import { friendlyError, MINOUT_RETRY } from "../lib/protocol-viem";
import { AAError } from "../lib/aa/core";
import { TRANSIENT_SIM, opRevertReason } from "../lib/aa/mav2";
import { ENTRYPOINT_V07 } from "../lib/aa/constants";

const E = parseAbi([
  "error MinOutTooLow(uint256 minOut, uint256 required)", "error PreExecHookReverted(bytes24 moduleFunction, bytes revertReason)",
  "error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)", "error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
]);
const minOut = encodeErrorResult({ abi: E, errorName: "MinOutTooLow", args: [BigInt(1), BigInt(2)] });
const hook = encodeErrorResult({ abi: E, errorName: "PreExecHookReverted", args: [("0x" + "11".repeat(24)) as Hex, minOut] });

test("on-chain revert (UserOperationRevertReason) decodes through the hook wrapper and is retryable", () => {
  const pe = friendlyError(new AAError("Reverted", "UserOp reverted (tx 0xabc)", { revertData: hook }));
  assert.equal(pe.code, "MinOutTooLow"); assert.ok(MINOUT_RETRY.test(pe.code)); assert.doesNotMatch(pe.message, /simulation/);
});
test("relay pre-flight FailedOpWithRevert(inner) shows the inner reason", () => {
  const inner = encodeErrorResult({ abi: E, errorName: "V4TooLittleReceived", args: [BigInt(5), BigInt(4)] });
  const fo = encodeErrorResult({ abi: E, errorName: "FailedOpWithRevert", args: [BigInt(0), "AA23 reverted", inner] });
  const pe = friendlyError(new AAError("Estimate", "simulation failed: x", { revertData: fo }));
  assert.equal(pe.code, "V4TooLittleReceived"); assert.ok(MINOUT_RETRY.test(pe.code));
});
test("unknown revert keeps the selector instead of a bare 'simulation failed'", () => {
  const pe = friendlyError(new AAError("Estimate", "simulation failed: execution reverted", { revertData: "0xdeadbeef00" }));
  assert.match(pe.message, /0xdeadbeef/);
  const rv = friendlyError(new AAError("Reverted", "UserOp reverted (tx 0x1)", { revertData: "0xcafebabe" }));
  assert.equal(rv.code, "Reverted"); assert.match(rv.message, /0xcafebabe/);
});
test("balance lag is transient (retried once by mav2)", () => {
  const bal = encodeErrorResult({ abi: E, errorName: "ERC20InsufficientBalance", args: ["0x0000000000000000000000000000000000000001", BigInt(0), BigInt(1)] });
  assert.ok(TRANSIENT_SIM.test(`simulation failed ${bal}`));
  assert.ok(TRANSIENT_SIM.test("ERC20: transfer amount exceeds balance"));
  assert.ok(!TRANSIENT_SIM.test("MinOutTooLow"));
});
test("opRevertReason reads the EntryPoint UserOperationRevertReason log", () => {
  const h = ("0x" + "ab".repeat(32)) as Hex;
  const topic0 = "0x1c4fada7374c0a9ee8841fc38afe82932dc0f8e69012e927f061a8bae611a201" as Hex; // UserOperationRevertReason
  const sender = ("0x" + "00".repeat(12) + "22".repeat(20)) as Hex;
  const data = encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [BigInt(7), hook]);
  assert.equal(opRevertReason([{ address: ENTRYPOINT_V07, data, topics: [topic0, h, sender] }], h), hook);
  assert.equal(opRevertReason([{ address: ENTRYPOINT_V07, data, topics: [topic0, h, sender] }], ("0x" + "cd".repeat(32)) as Hex), undefined);
});

test("SITE: unclear relay timeout keeps code 'Timeout' and its userOpHash / txHash / nonce through friendlyError", () => {
  const extra = { unclear: true, reason: "receipt-timeout", userOpHash: `0x${"ef".repeat(32)}`, txHash: `0x${"ab".repeat(32)}`, nonce: 4 };
  const pe = friendlyError(new AAError("Timeout", "Trade sent — still confirming on-chain.", extra));
  assert.equal(pe.code, "Timeout"); assert.deepEqual(pe.extra, extra); assert.ok(!MINOUT_RETRY.test(pe.code));
});
