/** Unit tests for lib/holders (GET /api/holders): Transfer folding, ranking, pct/usd, labels, limit clamp. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTransfers, clampHoldersLimit, isAddr, rankHolders } from "../lib/holders";

const Z = "0x0000000000000000000000000000000000000000";
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const E18 = BigInt(10) ** BigInt(18);

test("applyTransfers: mint, transfers, burn; zero balances dropped; mixed-case addresses merge", () => {
  const bal = applyTransfers({}, [
    { from: Z, to: A(1), value: BigInt(1000) * E18 },               // mint to curve
    { from: A(1), to: A(2), value: BigInt(300) * E18 },
    { from: A(1), to: A(3).toUpperCase().replace("0X", "0x"), value: BigInt(100) * E18 },
    { from: A(3), to: A(2), value: BigInt(100) * E18 },             // A3 exits fully
    { from: A(2), to: Z, value: BigInt(50) * E18 },                 // burn
    { from: A(2), to: A(4), value: BigInt(0) },                     // zero-value ignored
  ]);
  assert.deepEqual(bal, { [A(1)]: (BigInt(600) * E18).toString(), [A(2)]: (BigInt(350) * E18).toString() });
  assert.equal(bal[Z], undefined);
});

test("rankHolders: desc by balance, pct of supply, usd at mcap, labels, limit", () => {
  const bal = { [A(1)]: (BigInt(600) * E18).toString(), [A(2)]: (BigInt(350) * E18).toString(), [A(5)]: (BigInt(50) * E18).toString() };
  const h = rankHolders(bal, { totalSupply: BigInt(1000) * E18, mcapUsd: 10_000, labels: { [A(1)]: "curve", [A(5)]: "locker" }, limit: 2 });
  assert.equal(h.length, 2);
  assert.deepEqual(h.map((x) => x.address), [A(1), A(2)]);
  assert.equal(h[0].label, "curve"); assert.equal(h[1].label, null);
  assert.equal(h[0].pct, 60); assert.equal(h[1].pct, 35);
  assert.equal(h[0].usd, 6000); assert.equal(h[1].usd, 3500);
  assert.equal(h[1].balance, (BigInt(350) * E18).toString());
  assert.equal(rankHolders(bal, { totalSupply: BigInt(1000) * E18, mcapUsd: null, labels: {}, limit: 5 })[0].usd, null);
  assert.equal(rankHolders(bal, { totalSupply: BigInt(1000) * E18, mcapUsd: 1, labels: {}, limit: 5 }).at(-1)!.label, null);
});

test("ties break by address; huge balances don't overflow", () => {
  const big = (BigInt(1) << BigInt(200)).toString();
  const h = rankHolders({ [A(9)]: big, [A(3)]: big }, { totalSupply: BigInt(2) << BigInt(200), mcapUsd: 2, labels: {}, limit: 10 });
  assert.deepEqual(h.map((x) => x.address), [A(3), A(9)]);
  assert.equal(h[0].pct, 50); assert.equal(h[0].usd, 1);
});

test("limit clamp 1–100 (default 50) and address validation", () => {
  assert.equal(clampHoldersLimit(null), 50); assert.equal(clampHoldersLimit("0"), 50); assert.equal(clampHoldersLimit("-3"), 1);
  assert.equal(clampHoldersLimit("7"), 7); assert.equal(clampHoldersLimit("1e9"), 100); assert.equal(clampHoldersLimit("abc"), 50);
  assert.ok(isAddr(A(1))); assert.ok(!isAddr("0x12")); assert.ok(!isAddr(null)); assert.ok(!isAddr(`${A(1)}00`));
});
