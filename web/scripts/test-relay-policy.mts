// Unit tests for the relayer gas policy (W-1, lib/aa/gasPolicy) and the shared rate limiter (lib/server/limits).
//   pnpm test:relay-policy   (pure: no RPC, no live endpoint)
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOpGas, checkPaymaster, clientFees, GAS_CAPS, maxPrefund, MIN_PRE_VERIFICATION_GAS, relayerPrice, relayerTxFees, RELAYER_TIP, RelayPolicyError, totalGas } from "../lib/aa/gasPolicy";
import { hitLimit, memoryCounter, clientIp, type CounterStore } from "../lib/server/limits";
import { STATIC_GAS, FeeCache } from "../lib/aa/fastPath";

const hex = (n: bigint | number) => "0x" + BigInt(n).toString(16);
const BASE = BigInt(10_000_000); // 0.01 gwei (RH testnet base fee)
const op = (o: Record<string, bigint | number | string | undefined> = {}) => {
  const f = clientFees(BASE);
  const d: Record<string, string | undefined> = { callGasLimit: hex(STATIC_GAS.callGasLimit), verificationGasLimit: hex(STATIC_GAS.verificationGasLimit), preVerificationGas: hex(STATIC_GAS.preVerificationGas), maxFeePerGas: hex(f.maxFeePerGas), maxPriorityFeePerGas: hex(f.maxPriorityFeePerGas) };
  for (const [k, v] of Object.entries(o)) d[k] = v === undefined ? undefined : typeof v === "string" ? v : hex(v);
  return d;
};
const rejects = (o: Record<string, string | undefined>, code: "fee" | "gas", base = BASE) =>
  assert.throws(() => checkOpGas(o, base), (e: unknown) => e instanceof RelayPolicyError && e.code === code);

test("fee-0 op (the drain) is rejected", () => {
  rejects(op({ maxFeePerGas: 0, maxPriorityFeePerGas: 0 }), "fee");
  rejects(op({ maxFeePerGas: undefined, maxPriorityFeePerGas: undefined }), "fee");
});
test("maxFee just below 2x base + tip rejected, at the floor accepted; tip below RELAYER_TIP rejected", () => {
  rejects(op({ maxFeePerGas: relayerPrice(BASE) - BigInt(1) }), "fee");
  assert.ok(checkOpGas(op({ maxFeePerGas: relayerPrice(BASE), maxPriorityFeePerGas: RELAYER_TIP }), BASE) > BigInt(0));
  rejects(op({ maxPriorityFeePerGas: RELAYER_TIP - BigInt(1) }), "fee");
  assert.match((() => { try { checkOpGas(op({ maxFeePerGas: 0 }), BASE); } catch (e) { return (e as Error).message; } return ""; })(), /fee below relayer floor/);
});
test("huge callGasLimit / verification / PVG / total rejected; tiny PVG rejected", () => {
  rejects(op({ callGasLimit: GAS_CAPS.callGasLimit + BigInt(1) }), "gas");
  rejects(op({ callGasLimit: BigInt(10) ** BigInt(9) }), "gas");
  rejects(op({ verificationGasLimit: GAS_CAPS.verificationGasLimit + BigInt(1) }), "gas");
  rejects(op({ preVerificationGas: GAS_CAPS.preVerificationGas + BigInt(1) }), "gas");
  rejects(op({ callGasLimit: GAS_CAPS.callGasLimit, verificationGasLimit: GAS_CAPS.verificationGasLimit, preVerificationGas: BigInt(100_000) }), "gas");
  rejects(op({ preVerificationGas: MIN_PRE_VERIFICATION_GAS - BigInt(1) }), "gas");
  rejects(op({ callGasLimit: "0xzz" }), "gas");
});
test("paymaster limits count toward the cap (v0.7 packed)", () => {
  const p = op({ paymaster: "0x1111111111111111111111111111111111111111", paymasterVerificationGasLimit: GAS_CAPS.paymasterVerificationGasLimit + BigInt(1) });
  rejects(p, "gas");
  const q = op({ paymaster: "0x1111111111111111111111111111111111111111", paymasterVerificationGasLimit: BigInt(100_000), paymasterPostOpGasLimit: BigInt(50_000) });
  assert.equal(totalGas(q), STATIC_GAS.callGasLimit + STATIC_GAS.verificationGasLimit + STATIC_GAS.preVerificationGas + BigInt(150_000));
});
test("real one-tap ops pass: STATIC_GAS, first-op deploy (450k verif ×1.2), GasCache 1.5x of a 0.65M estimate", () => {
  assert.doesNotThrow(() => checkOpGas(op(), BASE));
  assert.doesNotThrow(() => checkOpGas(op({ verificationGasLimit: BigInt(540_000), callGasLimit: BigInt(1_000_000), preVerificationGas: BigInt(72_000) }), BASE));
  const est = (BigInt(650_000) * BigInt(13)) / BigInt(10) + BigInt(20_000);
  assert.doesNotThrow(() => checkOpGas(op({ callGasLimit: (est * BigInt(150)) / BigInt(100), verificationGasLimit: (BigInt(150_000) * BigInt(120)) / BigInt(100) }), BASE));
});
test("client fees clear the floor with headroom (base +40% still ok); one-tap FeeCache doubles them", async () => {
  const f = clientFees(BASE);
  assert.ok(f.maxFeePerGas >= relayerPrice(BASE) && f.maxPriorityFeePerGas >= RELAYER_TIP);
  assert.doesNotThrow(() => checkOpGas(op(), (BASE * BigInt(140)) / BigInt(100)));
  // mav2 fetchFees: clientFees(base, tip, 100) through FeeCache (×2 maxFee) → base may double before rejection
  const c = new FeeCache(3000, () => 0); const v = await c.get(async () => clientFees(BASE, BigInt(1_000_000), BigInt(100)));
  assert.doesNotThrow(() => checkOpGas(op({ maxFeePerGas: v.maxFeePerGas, maxPriorityFeePerGas: v.maxPriorityFeePerGas }), BASE * BigInt(2)));
  c.invalidate(); assert.equal(c.peek(), undefined);
  // an Alchemy tip above ours is kept
  assert.equal(clientFees(BASE, BigInt(5_000_000)).maxPriorityFeePerGas, BigInt(5_500_000));
});
test("relayer tx fees never exceed the op's ⇒ refund per gas >= cost per gas", () => {
  for (const base of [BigInt(0), BASE, BASE * BigInt(3)]) {
    const o = op({ maxFeePerGas: relayerPrice(base) + BigInt(7), maxPriorityFeePerGas: RELAYER_TIP * BigInt(3) });
    const tx = relayerTxFees(o, base);
    assert.ok(tx.maxFeePerGas <= BigInt(o.maxFeePerGas!) && tx.maxPriorityFeePerGas <= BigInt(o.maxPriorityFeePerGas!));
    const eff = (max: bigint, tip: bigint) => (max < base + tip ? max : base + tip);
    assert.ok(eff(BigInt(o.maxFeePerGas!), BigInt(o.maxPriorityFeePerGas!)) >= eff(tx.maxFeePerGas, tx.maxPriorityFeePerGas));
  }
});
test("maxPrefund is priced at >= the relayer floor (a fee-0 op never looks covered by a zero balance)", () => {
  const z = op({ maxFeePerGas: 0 });
  assert.equal(maxPrefund(z), BigInt(0));
  assert.equal(maxPrefund(z, relayerPrice(BASE)), totalGas(z) * relayerPrice(BASE));
  assert.ok(BigInt(0) < maxPrefund(z, relayerPrice(BASE)));
  const o = op(); assert.equal(maxPrefund(o, relayerPrice(BASE)), totalGas(o) * BigInt(o.maxFeePerGas!));
});
test("rate limiter: fixed window per key, retry-after, store errors fall back to memory (never unlimited)", async () => {
  const k = `t:${Math.random()}`;
  for (let i = 1; i <= 3; i++) assert.equal((await hitLimit(memoryCounter, k, 3, 60)).ok, true);
  const r = await hitLimit(memoryCounter, k, 3, 60); assert.equal(r.ok, false); assert.ok(r.retryAfterSec > 0 && r.retryAfterSec <= 60);
  assert.equal((await hitLimit(memoryCounter, k + "other", 3, 60)).ok, true);
  const broken: CounterStore = { incrEx: async () => { throw new Error("upstash down"); }, ttl: async () => -2 };
  const k2 = `t2:${Math.random()}`;
  assert.equal((await hitLimit(broken, k2, 1, 60)).ok, true); assert.equal((await hitLimit(broken, k2, 1, 60)).ok, false);
  const h = (m: Record<string, string>) => ({ get: (n: string) => m[n] ?? null });
  assert.equal(clientIp(h({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" })), "1.2.3.4");
  assert.equal(clientIp(h({ "x-real-ip": "5.6.7.8", "x-forwarded-for": "1.2.3.4" })), "5.6.7.8");
  assert.equal(clientIp(h({})), "unknown");
});

test("paymaster ops: only our paymaster, deposit must cover the max prefund at >= the relayer floor; self-pay untouched", () => {
  const PM = "0x1111111111111111111111111111111111111111";
  const o = op({ paymasterVerificationGasLimit: 120_000, paymasterPostOpGasLimit: 80_000 });
  const pmOp = { ...o, paymaster: PM };
  const need = maxPrefund(pmOp, relayerPrice(BASE));
  checkPaymaster(o, undefined, BigInt(0), BASE); // no paymaster: no-op
  checkPaymaster(pmOp, PM.toUpperCase().replace("0X", "0x"), need, BASE);
  const bad = (fn: () => void) => assert.throws(fn, (e: unknown) => e instanceof RelayPolicyError && e.code === "paymaster");
  bad(() => checkPaymaster(pmOp, PM, need - BigInt(1), BASE));
  bad(() => checkPaymaster(pmOp, undefined, need, BASE));
  bad(() => checkPaymaster({ ...pmOp, paymaster: "0x2222222222222222222222222222222222222222" }, PM, need, BASE));
  // a fee-0 paymaster op is priced at the relayer floor, not at 0
  bad(() => checkPaymaster({ ...pmOp, maxFeePerGas: "0x0" }, PM, BigInt(1), BASE));
  // paymaster gas limits count toward the prefund and the caps
  assert.equal(totalGas(pmOp), totalGas(o) + BigInt(200_000));
});
