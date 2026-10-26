// FLOW 2: sells/buys show the REAL revert reason and min-out reverts are retryable.   pnpm test:trade-errors (pure)
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeErrorResult, parseAbi, type Hex } from "viem";
import { friendlyError, MINOUT_RETRY, ProtocolError } from "../lib/protocol-viem";
import { AAError } from "../lib/aa/core";
import { TRANSIENT_SIM, opRevertReason, unclearExtra } from "../lib/aa/mav2";
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
test("unknown revert (Estimate or Reverted) shows the plain line, no selector", () => {
  // approved by lee 2026-10-24: unknown pre-send failure → plain line; the selector goes to the console (test:relay-op)
  const pe = friendlyError(new AAError("Estimate", "simulation failed: execution reverted", { revertData: "0xdeadbeef00" }));
  assert.equal(pe.code, "Estimate"); assert.equal(pe.message, "That didn't go through. Try again."); assert.doesNotMatch(pe.message, /0x|simulation/);
  // a Reverted op (approved copy, lee 2026-10-24): plain line only; the selector goes to the console (test:relay-op)
  const rv = friendlyError(new AAError("Reverted", "That didn't go through. Try again.", { revertData: "0xcafebabe" }));
  assert.equal(rv.code, "Reverted"); assert.equal(rv.message, "That didn't go through. Try again."); assert.doesNotMatch(rv.message, /0x/);
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

test("SITE: unclear relay timeout keeps code 'Timeout' and its userOpHash / txHash / relayNonce / sender / nonce through friendlyError", () => {
  // relayNonce = the relayer EOA nonce (number); nonce = the op's EntryPoint nonce (bigint, SITE's watcher)
  const extra = { unclear: true, reason: "receipt-timeout", userOpHash: `0x${"ef".repeat(32)}`, txHash: `0x${"ab".repeat(32)}`, relayNonce: 4, sender: `0x${"12".repeat(20)}`, nonce: 7n };
  const pe = friendlyError(new AAError("Timeout", "Trade sent — still confirming on-chain.", extra));
  assert.equal(pe.code, "Timeout"); assert.deepEqual(pe.extra, extra); assert.ok(!MINOUT_RETRY.test(pe.code));
});

test("SITE: a Timeout that is NOT unclear maps to ProtocolError('Timeout') with NO extra (not even an own key)", () => {
  for (const e of [new AAError("Timeout", "UserOp not mined yet"), new AAError("Timeout", "UserOp not mined yet", { userOpHash: `0x${"ef".repeat(32)}`, nonce: 1n, sender: `0x${"12".repeat(20)}` })]) {
    const pe = friendlyError(e);
    assert.equal(pe.code, "Timeout"); assert.equal(pe.extra, undefined); assert.equal("extra" in pe, false);
  }
  assert.equal("extra" in new ProtocolError("Timeout", "x"), false);
  // other codes never carry it, even with an unclear-looking extra
  assert.equal("extra" in friendlyError(new AAError("Bundler", "relay error: x", { unclear: true, reason: "network" })), false);
  // SITE-compatible constructor shape (code, msg, options): extra only when given
  const x = { unclear: true as const, reason: "network" as const, userOpHash: `0x${"ef".repeat(32)}` as const, sender: `0x${"12".repeat(20)}` as const };
  assert.deepEqual(new ProtocolError("Timeout", "x", { extra: x }).extra, x);
});

test("mav2 unclearExtra: Timeout extra = relay fields (relayNonce) + sender + userOpHash + the op's EntryPoint nonce (bigint)", () => {
  const uoh = `0x${"ef".repeat(32)}` as Hex, sender = `0x${"12".repeat(20)}` as Hex, tx = `0x${"ab".repeat(32)}` as Hex;
  const x = unclearExtra({ unclear: true, reason: "stream-lost", txHash: tx, relayNonce: 41 }, uoh, { sender, nonce: "0x0000000000000000000000000000000000000000000000070000000000000003" });
  assert.deepEqual(x, { unclear: true, reason: "stream-lost", txHash: tx, relayNonce: 41, userOpHash: uoh, sender, nonce: (7n << 64n) | 3n });
  assert.equal(typeof x.nonce, "bigint");
  // no / malformed op nonce ⇒ left out (never the relayer's)
  assert.equal("nonce" in unclearExtra({ unclear: true, reason: "network", relayNonce: 2 }, uoh, { sender }), false);
  assert.equal("nonce" in unclearExtra({ unclear: true, reason: "network" }, uoh, { sender, nonce: "0xzz" as Hex }), false);
  const pe = friendlyError(new AAError("Timeout", "x", x));
  assert.equal(pe.extra?.relayNonce, 41); assert.equal(pe.extra?.nonce, (7n << 64n) | 3n); assert.equal(pe.extra?.sender, sender);
});
