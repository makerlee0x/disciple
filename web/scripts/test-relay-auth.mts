// Audit F-02. Injectable authorization gate; no network, balances moved or production credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pad, type Address, type Hex } from "viem";
import { authorizeRelayOperation, ACCOUNT_PROXY_RUNTIME, warmRelayAccountTemplates, type RelayAuthReads } from "../lib/server/relayAuth";
import { SenderTrust } from "../lib/server/relayTrust";
import type { UserOp } from "../lib/aa/core";
import { MAV2_FACTORY } from "../lib/aa/constants";
const sender = `0x${"11".repeat(20)}` as Address, impl = `0x${"22".repeat(20)}` as Address;
const op = { sender, nonce: "0x1", callData: "0x1234", signature: "0x01" } as UserOp;
function reads(overrides: Partial<RelayAuthReads> = {}): RelayAuthReads {
  return {
    async getCode() { return `${ACCOUNT_PROXY_RUNTIME}${"33".repeat(20)}`; },
    async getStorageAt() { return pad(impl, { size: 32 }); },
    async readContract() { return impl; }, ...overrides,
  };
}
for (const reason of ["forged operation", "wrong signature", "wrong nonce", "unfunded account", "expired session/module"]) {
  test(`${reason}: failed exact simulation cannot reach signing/broadcast`, async () => {
    let signed = 0, broadcasts = 0, simulations = 0;
    await assert.rejects(async () => {
      await authorizeRelayOperation(op, reads(), async () => { simulations++; throw new Error(reason); });
      signed++; broadcasts++;
    }, new RegExp(reason));
    assert.equal(simulations, 1); assert.equal(signed, 0); assert.equal(broadcasts, 0);
  });
}
for (const [reason, overrides] of [
  ["wrong implementation", { getStorageAt: async () => pad(`0x${"44".repeat(20)}` as Hex, { size: 32 }) }],
  ["arbitrary runtime reporting a good implementation slot", { getCode: async () => "0x6000" as Hex }],
  ["EOA with balance", { getCode: async () => undefined }],
  ["unknown code status", { getCode: async () => { throw new Error("RPC timeout"); } }],
  ["unknown implementation status", { getStorageAt: async () => undefined }],
] as const) {
  test(`${reason}: rejected even if handleOps would pass`, async () => {
    let signed = 0;
    await assert.rejects(async () => {
      await authorizeRelayOperation(op, reads(overrides), async () => {});
      signed++;
    });
    assert.equal(signed, 0);
  });
}
test("valid exact op with supported current account implementation passes", async () => {
  let simulations = 0, sent = 0;
  await authorizeRelayOperation(op, reads(), async () => { simulations++; }); sent++;
  assert.equal(simulations, 1); assert.equal(sent, 1);
});
test("valid legacy LightAccount proxy passes the matching factory implementation check", async () => {
  await authorizeRelayOperation(op, reads({ getCode: async () => ACCOUNT_PROXY_RUNTIME }), async () => {});
});
test("counterfactual supported factory still requires exact simulation", async () => {
  const counterfactual = { ...op, factory: MAV2_FACTORY, factoryData: "0x1234" as Hex };
  await authorizeRelayOperation(counterfactual, reads({ getCode: async () => undefined }), async () => {});
  await assert.rejects(authorizeRelayOperation(counterfactual, reads({ getCode: async () => undefined }), async () => { throw new Error("bad initCode"); }));
});
test("a prior passing exact op cannot bypass revalidation after state changes", async () => {
  let simulations = 0, sent = 0;
  await authorizeRelayOperation(op, reads(), async () => { simulations++; }); sent++;
  await assert.rejects(async () => {
    await authorizeRelayOperation(op, reads(), async () => { simulations++; throw new Error("nonce consumed / owner rotated"); }); sent++;
  });
  assert.equal(simulations, 2); assert.equal(sent, 1);
});
test("disciple_warm-style balance priming is not authentication", async () => {
  const trust = new SenderTrust(() => 1_000_000);
  trust.prime(sender, BigInt(10) ** BigInt(18));
  assert.equal(trust.get(sender)?.verifiedAt, 0);
  assert.equal(trust.check(sender, BigInt(0)), "unverified");
});

test("warm caches only immutable template anchors; every send re-reads runtime + implementation and simulates", async () => {
  let codeReads = 0, slotReads = 0, anchors = 0, simulations = 0;
  const pc = reads({
    getCode: async () => { codeReads++; return `${ACCOUNT_PROXY_RUNTIME}${"33".repeat(20)}`; },
    getStorageAt: async () => { slotReads++; return pad(impl, { size: 32 }); },
    readContract: async () => { anchors++; return impl; },
  });
  await warmRelayAccountTemplates(pc);
  for (let i = 0; i < 2; i++) await authorizeRelayOperation(op, pc, async () => { simulations++; });
  assert.equal(anchors, 2); assert.equal(codeReads, 2); assert.equal(slotReads, 2); assert.equal(simulations, 2);
});
