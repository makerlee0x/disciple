// Unit tests for the relayer gas policy (W-1, lib/aa/gasPolicy) and the shared rate limiter (lib/server/limits).
//   pnpm test:relay-policy   (pure: no RPC, no live endpoint)
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOpGas, clientFees, GAS_CAPS, maxPrefund, MIN_PRE_VERIFICATION_GAS, relayerPrice, relayerTxFees, RELAYER_TIP, RelayPolicyError, totalGas } from "../lib/aa/gasPolicy";
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

// ---- FLOW 1: launch-specific caps (≈ 7.9M estimated launch gas was rejected by the 3M / 4M W-1 caps)
import { capsForOp, isLaunchOp, isLaunchCalls, LAUNCH_GAS_CAPS } from "../lib/aa/gasPolicy";
import { encodeFunctionData, parseAbi, toFunctionSelector, type Hex } from "viem";
import { launchpadAbi } from "../lib/abi/Launchpad";
const LP = "0x1111111111111111111111111111111111111111", OTHER = "0x2222222222222222222222222222222222222222", TOK = "0x3333333333333333333333333333333333333333";
const acct = parseAbi(["function execute(address target, uint256 value, bytes data)", "function executeBatch((address target, uint256 value, bytes data)[] calls)"]);
const launchFn = (launchpadAbi as readonly { type: string; name?: string }[]).find((f) => f.type === "function" && /^launch(WithMode|Coin)?$/.test(f.name ?? "")) as { name: string };
const launchData = (toFunctionSelector(launchFn as never) + "00".repeat(64)) as Hex;
const approve = encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), args: [LP, BigInt(1)] });
const batch = (calls: { to: string; data: Hex }[]) => encodeFunctionData({ abi: acct, functionName: "executeBatch", args: [calls.map((c) => ({ target: c.to as Hex, value: BigInt(0), data: c.data }))] });
const launchOp = (callData: Hex, g: Record<string, number> = {}) => ({ ...op({ callGasLimit: 7_900_000, verificationGasLimit: 450_000, preVerificationGas: 60_000, ...g }), callData });

test("launch op (approve + launch to the Launchpad) gets the launch caps: ~7.9M call passes, >10M call / >11M total rejected", () => {
  const cd = batch([{ to: TOK, data: approve }, { to: LP, data: launchData }]);
  assert.equal(isLaunchOp(cd, [LP]), true);
  assert.equal(isLaunchCalls([{ to: LP, data: launchData }], [LP]), true);
  const o = launchOp(cd);
  assert.ok(checkOpGas(o, BASE, capsForOp(o, [LP])) > BigInt(0));
  assert.throws(() => checkOpGas(o, BASE), RelayPolicyError);   // same op under W-1 caps: rejected (the bug)
  const big = launchOp(cd, { callGasLimit: 10_000_001 });
  assert.throws(() => checkOpGas(big, BASE, capsForOp(big, [LP])), /callGasLimit .* above cap/);
  const tot = launchOp(cd, { callGasLimit: 10_000_000, verificationGasLimit: 900_000, preVerificationGas: 150_000 });
  assert.throws(() => checkOpGas(tot, BASE, capsForOp(tot, [LP])), /total gas .* above cap 11000000/);
  assert.equal(LAUNCH_GAS_CAPS.verificationGasLimit, GAS_CAPS.verificationGasLimit);   // only call + total widen
});
test("non-launch ops keep W-1 caps: wrong target, extra non-approve call, single execute of a trade, garbage callData", () => {
  assert.equal(isLaunchOp(batch([{ to: OTHER, data: launchData }]), [LP]), false);
  assert.equal(isLaunchOp(batch([{ to: LP, data: launchData }, { to: OTHER, data: "0xdeadbeef" }]), [LP]), false);
  assert.equal(isLaunchOp(batch([{ to: TOK, data: approve }]), [LP]), false);
  assert.equal(isLaunchOp(encodeFunctionData({ abi: acct, functionName: "execute", args: [LP, BigInt(0), "0xdeadbeef"] }), [LP]), false);
  assert.equal(isLaunchOp("0x1234", [LP]), false);
  assert.equal(capsForOp({ callData: batch([{ to: OTHER, data: launchData }]) }, [LP]), GAS_CAPS);
  // executeUserOp-prefixed single execute of a launch is still a launch
  const ex = encodeFunctionData({ abi: acct, functionName: "execute", args: [LP, BigInt(0), launchData] });
  assert.equal(isLaunchOp(("0x8dd7712f" + ex.slice(2)) as Hex, [LP]), true);
});
