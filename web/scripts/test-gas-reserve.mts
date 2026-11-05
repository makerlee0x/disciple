// USDG reserve is zero: gas is native ETH and cannot consume the trade's cash balance.
import test from "node:test";
import assert from "node:assert/strict";
import { aaGasReservePerOp, aaPeekGasReservePerOp } from "../lib/aa/session";
import { gasReservePerOp, peekGasReservePerOp, warmGasPrice } from "../lib/flight/gasReserve";
test("cold wallet and flight reserve no USDG for either trade class", async () => {
  for (const kind of ["trade", "gradBuy"] as const) {
    assert.equal(aaGasReservePerOp(kind), BigInt(0)); assert.equal(aaPeekGasReservePerOp(kind), BigInt(0));
    assert.equal(gasReservePerOp(kind), BigInt(0)); assert.equal(peekGasReservePerOp(kind), BigInt(0));
  }
  let reads = 0; await warmGasPrice({ getGasPrice: async () => { reads++; return BigInt(1); } }); assert.equal(reads, 0);
});
