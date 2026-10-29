// SITE: lee's Oct 26 prod test ("HTTP request failed", "didn't go through" yet it filled, extra sells). pnpm test:trade-failures (pure)
import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpRequestError, TimeoutError } from "viem";
import { friendlyError, tradeNetworkError, markSent, wasSent, ProtocolError, MINOUT_RETRY } from "../lib/protocol-viem";
import { AAError } from "../lib/aa/core";
import { JARGON, NETWORK_MSG, PENDING_MSG, isTransportError, plainText } from "../lib/aa/relayOp";
import { isSentUnknown, pendingIds, watchPending, type Found } from "../lib/trade/pendingWatch";

const quiet = () => { const w = console.warn; console.warn = () => {}; return () => { console.warn = w; }; };

test("a read that fails on the network shows a plain line, never 'HTTP request failed'", () => {
  const restore = quiet();
  try {
    for (const e of [new HttpRequestError({ url: "https://rpc.testnet.chain.robinhood.com", details: "Failed to fetch" }), new TimeoutError({ body: {}, url: "https://x" }), new TypeError("Failed to fetch"), new Error("HTTP request failed.")]) {
      assert.ok(isTransportError(e));
      const pe = tradeNetworkError(e)!;
      assert.equal(pe.code, "Network"); assert.equal(pe.message, NETWORK_MSG);
      assert.doesNotMatch(pe.message, JARGON);
    }
    assert.equal(plainText("HTTP request failed."), "That didn't go through. Try again.");
    assert.equal(tradeNetworkError(new AAError("Timeout", PENDING_MSG)), null);   // sent ops keep their own path
    assert.equal(tradeNetworkError(new Error("Slippage")), null);
  } finally { restore(); }
});

test("an op that was sent is marked so trade() never resends it (on-chain Slippage revert)", () => {
  const pe = markSent(new ProtocolError("Slippage", "Price moved too much."));
  assert.ok(MINOUT_RETRY.test(pe.code)); assert.ok(wasSent(pe));
  assert.ok(!wasSent(new ProtocolError("Slippage", "x")));   // pre-send min-out failure: still retried once
});

test("a relay Timeout is 'sent, still confirming', not a failure", () => {
  const pe = friendlyError(new AAError("Timeout", PENDING_MSG, { userOpHash: `0x${"ab".repeat(32)}` }));
  assert.ok(isSentUnknown(pe)); assert.ok(!isSentUnknown(new ProtocolError("Network", NETWORK_MSG)));
  assert.equal(pendingIds(new AAError("Timeout", "x", { userOpHash: "0x1", txHash: "0x2" })).userOpHash, "0x1");
});

function fakeReg() {
  const ev: string[] = []; const held = new Set(["p1"]);
  return { ev, reg: { has: (id: string) => held.has(id), markUnknown: (id: string) => { ev.push(`unknown:${id}`); return true; }, resolveUnknown: (id: string, out: "filled" | "error") => { ev.push(`${out}:${id}`); held.delete(id); return true; } } };
}
test("timed-out press: landed later ⇒ filled once (looked up, never resent)", async () => {
  const restore = quiet(); const { ev, reg } = fakeReg(); let n = 0;
  const lookup = async (): Promise<Found> => (++n < 3 ? null : { success: true, txHash: "0xt" });
  try { assert.equal(await watchPending("p1", { userOpHash: "0xh" }, { lookup, reg: reg as never, sleep: async () => {} }), "filled"); } finally { restore(); }
  assert.deepEqual(ev, ["unknown:p1", "filled:p1"]); assert.equal(n, 3);
});
test("timed-out press: never shows up ⇒ error after the watch window; lookup errors don't end it early", async () => {
  const restore = quiet(); const { ev, reg } = fakeReg(); let t = 0;
  const lookup = async (): Promise<Found> => { if (t === 0) { t++; throw new Error("HTTP request failed."); } return null; };
  try { assert.equal(await watchPending("p1", { userOpHash: "0xh" }, { lookup, reg: reg as never, waitMs: 3000, sleep: async () => { t += 1000; }, now: () => t }), "error"); } finally { restore(); }
  assert.deepEqual(ev, ["unknown:p1", "error:p1"]);
});
test("no userOpHash or press not held ⇒ nothing to watch", async () => {
  const { ev, reg } = fakeReg();
  assert.equal(await watchPending("p1", {}, { lookup: async () => null, reg: reg as never }), "gone");
  assert.equal(await watchPending("zz", { userOpHash: "0xh" }, { lookup: async () => null, reg: reg as never }), "gone");
  assert.deepEqual(ev, []);
});
