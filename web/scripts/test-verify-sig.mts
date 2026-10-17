// Unit tests for lib/aa/verify.ts (chat login / username claim signature check).  pnpm test:verify-sig
import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, stringToBytes, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyAccountSignature, type VerifyClient } from "../lib/aa/verify";
import { LIGHT_ACCOUNT_V2_FACTORY, MAV2_FACTORY } from "../lib/aa/constants";

const SA = "0x1111111111111111111111111111111111111111";
const msg = "DISCIPLE chat login test";
const owner = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const rawSig = (a = owner) => a.signMessage({ message: { raw: keccak256(stringToBytes(msg)) } });

function fake(o: { verify?: boolean; code?: Hex; predictMav2?: string; predictLa?: string }) {
  const calls: string[] = [];
  const pc: VerifyClient = {
    async verifyMessage() { calls.push("verify"); return !!o.verify; },
    async getCode() { calls.push("code"); return o.code ?? "0x"; },
    async readContract(a) {
      calls.push(a.functionName);
      if (a.address === MAV2_FACTORY) return o.predictMav2 ?? "0x0000000000000000000000000000000000000002";
      if (a.address === LIGHT_ACCOUNT_V2_FACTORY) return o.predictLa ?? "0x0000000000000000000000000000000000000003";
      throw new Error("unexpected");
    },
  };
  return { pc, calls };
}

test("verifyMessage (1271/6492/EOA) wins first, even when an owner is sent", async () => {
  const f = fake({ verify: true, code: "0x6001" });
  assert.equal(await verifyAccountSignature(f.pc, SA, msg, "0x1234", owner.address), SA);
  assert.deepEqual(f.calls, ["verify"]);
});
test("deployed account: owner shortcut is NOT used (rotated owner can't pass)", async () => {
  const f = fake({ verify: false, code: "0x6001", predictMav2: SA });
  assert.equal(await verifyAccountSignature(f.pc, SA, msg, await rawSig(), owner.address), null);
  assert.ok(!f.calls.includes("getAddressSemiModular"));
});
test("undeployed MAv2: owner shortcut accepts the predicted address", async () => {
  const f = fake({ verify: false, predictMav2: SA });
  assert.equal(await verifyAccountSignature(f.pc, SA, msg, await rawSig(), owner.address), SA);
});
test("undeployed legacy LightAccount: accepted via LA prediction", async () => {
  const f = fake({ verify: false, predictLa: SA.toUpperCase().replace("0X", "0x") });
  assert.equal(await verifyAccountSignature(f.pc, SA, msg, await rawSig(), owner.address), SA);
});
test("undeployed: wrong signer or wrong prediction rejected", async () => {
  assert.equal(await verifyAccountSignature(fake({ predictMav2: SA }).pc, SA, msg, await rawSig(other), owner.address), null);
  assert.equal(await verifyAccountSignature(fake({}).pc, SA, msg, await rawSig(), owner.address), null);
});
test("no owner and verifyMessage fails ⇒ rejected; bad input ⇒ rejected", async () => {
  assert.equal(await verifyAccountSignature(fake({ predictMav2: SA }).pc, SA, msg, await rawSig()), null);
  assert.equal(await verifyAccountSignature(fake({ verify: true }).pc, "nope", msg, "0x12"), null);
  assert.equal(await verifyAccountSignature(fake({ verify: true }).pc, SA, msg, "zz"), null);
});
