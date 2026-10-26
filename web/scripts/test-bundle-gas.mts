// Unit tests for the handleOps outer gas (lib/aa/bundleGas.ts, EntryPoint v0.7 63/64 rule).  pnpm test:bundle-gas
import { test } from "node:test";
import assert from "node:assert/strict";
import { bundleGas, BundleGasError, calldataGas, MAX_RELAY_TX_GAS } from "../lib/aa/bundleGas";

const PM = "0xB3DB53C1E94F146194756FF456479ea0577E7d7E";
const oldGas = (o: { callGasLimit: bigint; verificationGasLimit: bigint; preVerificationGas: bigint; paymasterVerificationGasLimit: bigint; paymasterPostOpGasLimit: bigint }) =>
  o.callGasLimit + o.verificationGasLimit + o.preVerificationGas + o.paymasterVerificationGasLimit + o.paymasterPostOpGasLimit + BigInt(120_000);
// stand-in handleOps calldata of the same size as the real txs (byte values only change calldataGas by ≤ 12/byte)
const data = (bytes: number) => ("0x" + "ab".repeat(bytes)) as `0x${string}`;
// AA95 inner check: gas left in _executeUserOp × 63/64 (call forwarding) × 63/64 (innerHandleOp check) ≥ cgl + pmPost + 10k
const innerNeed = (cgl: bigint, post: bigint) => ((cgl + post + BigInt(10_000)) * BigInt(4096) + BigInt(3968)) / BigInt(3969);

// private launch on prod, tx 0x0a7f0e5a… (2026-10-24): FailedOp(0, "AA95 out of gas") at outer gas 9,819,804;
// the same bundle passes eth_call from 9,853,009 (pre-execution overhead ≈ 173k) and estimateGas said 9,949,627
const launch = { paymaster: PM, verificationGasLimit: BigInt(150_000), callGasLimit: BigInt(9_289_804), preVerificationGas: BigInt(60_000), paymasterVerificationGasLimit: BigInt(120_000), paymasterPostOpGasLimit: BigInt(80_000) };
// session BOOST on prod, tx 0xa2c63371…: outer 2,530,000, used 863,253
const boost = { paymaster: PM, verificationGasLimit: BigInt(350_000), callGasLimit: BigInt(1_800_000), preVerificationGas: BigInt(60_000), paymasterVerificationGasLimit: BigInt(120_000), paymasterPostOpGasLimit: BigInt(80_000) };

test("failing launch: old formula gave 9,819,804 (AA95); new gas ≥ 9.9M and ≤ cap", () => {
  assert.equal(oldGas(launch), BigInt(9_819_804));
  const g = bundleGas(launch, data(2628));
  assert.ok(g >= BigInt(9_900_000), `got ${g}`);
  assert.ok(g >= BigInt(9_949_627), `≥ the node's estimateGas, got ${g}`);
  assert.ok(g <= MAX_RELAY_TX_GAS);
  assert.ok(g - innerNeed(launch.callGasLimit, launch.paymasterPostOpGasLimit) >= BigInt(173_070) * BigInt(2), "≥ 2× the measured pre-exec overhead");
});

test("typical BOOST: modest increase, no balloon", () => {
  const o = oldGas(boost), n = bundleGas(boost, data(1796));
  assert.equal(o, BigInt(2_530_000));
  assert.ok(n > o && n - o < BigInt(150_000), `old ${o} new ${n}`);
  assert.ok(n * BigInt(100) < o * BigInt(105), "< +5%");
  console.log(`  BOOST outer gas: old ${o} → new ${n} (+${n - o})`);
});

test("inner 63/64 check always met with room for validation + EntryPoint overhead", () => {
  for (const cgl of [100_000, 1_000_000, 3_000_000, 5_000_000, 10_000_000].map(BigInt)) {
    const op = { ...boost, callGasLimit: cgl };
    const g = bundleGas(op, data(1800));
    assert.ok(g - innerNeed(cgl, op.paymasterPostOpGasLimit) >= op.verificationGasLimit + op.paymasterVerificationGasLimit + BigInt(121_000));
  }
});

test("no paymaster: paymaster limits are ignored", () => {
  const { paymaster: _p, ...self } = launch;
  assert.ok(bundleGas(self, data(1000)) < bundleGas(launch, data(1000)));
});

test("calldataGas: EIP-2028 4 per zero byte, 16 per non-zero", () => {
  assert.equal(calldataGas("0x"), BigInt(0));
  assert.equal(calldataGas("0x00ff0001"), BigInt(4 + 16 + 4 + 16));
});

test("above the relay max: clear BundleGasError", () => {
  assert.throws(() => bundleGas({ ...launch, callGasLimit: BigInt(40_000_000) }, data(100)), (e: unknown) => e instanceof BundleGasError && /too large to relay/.test((e as Error).message) && (e as BundleGasError).cap === MAX_RELAY_TX_GAS);
  assert.throws(() => bundleGas(launch, data(100), BigInt(5_000_000)), BundleGasError);
});
