// Offline first-operation authorization, token-payment and zero-extra-roundtrip regressions.
import test from "node:test";
import assert from "node:assert/strict";
import { concatHex, encodeFunctionData, maxUint256, parseAbi, recoverTypedDataAddress, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { prepayBootstrap, hasDeferredPrepayApproval, prepayApprovalCall } from "../lib/aa/prepayBootstrap";
import { finalQuote, stubQuote, allowanceQuote, unmarkedRate, type QuoteConfig, type QuoteDeps } from "../lib/server/paymasterCore";
import { requireStake } from "../lib/server/prepaidPaymaster";
import { checkUserPaid, clientFees } from "../lib/aa/gasPolicy";
import { ENTRYPOINT_V07 } from "../lib/aa/constants";
import { PAYMASTER_GAS, paymasterApproveCall, stubPaymasterData } from "../lib/aa/paymaster";
import { Mav2Account, FEES, cachedGasEstimator } from "../lib/aa/mav2";
import { robinhoodTestnet } from "../lib/chains";
import type { UserOp, Call } from "../lib/aa/core";
const owner = privateKeyToAccount(`0x${"01".repeat(32)}`);
const S = `0x${"11".repeat(20)}` as Address, PM = `0x${"22".repeat(20)}` as Address, USDG = `0x${"33".repeat(20)}` as Address;
const OTHER = `0x${"44".repeat(20)}` as Address, H = `0x${"55".repeat(32)}` as Hex;
const exec = parseAbi(["struct Call { address target; uint256 value; bytes data; }", "function executeBatch(Call[] calls)"]);
const batch = (cs: Call[]) => encodeFunctionData({ abi: exec, functionName: "executeBatch", args: [cs.map(c => ({ target: c.to, value: c.value ?? 0n, data: c.data }))] });
const rate = 3_000_000_000n, now = Math.floor(Date.now() / 1000);
const cfg: QuoteConfig = { paymaster: PM, usdg: USDG, usdgDecimals: 6, rate };
const deps: QuoteDeps = { now: () => now, debtOf: async () => 0n, balanceOf: async () => 100_000_000n, allowanceOf: async () => maxUint256,
  bounds: async () => ({ minRate: rate / 2n, maxRate: rate * 2n, maxGasPerOp: 12_000_000n }), baseFee: async () => 1n, sign: hash => owner.signMessage({ message: { raw: hash } }) };
const op: UserOp = { sender: S, nonce: toHex(1n << 64n), callData: batch([paymasterApproveCall(USDG, PM, maxUint256)]),
  callGasLimit: toHex(1_800_000n), verificationGasLimit: toHex(350_000n), preVerificationGas: toHex(60_000n),
  ...Object.fromEntries(Object.entries(clientFees(1n)).map(([k,v]) => [k,toHex(v)])),
  paymaster: PM, paymasterVerificationGasLimit: toHex(PAYMASTER_GAS.verificationGasLimit), paymasterPostOpGasLimit: toHex(PAYMASTER_GAS.postOpGasLimit), signature: "0x" };

async function bootstrap() {
  let typed: any;
  const auth = await prepayBootstrap({ account: S, chainId: 46630, nonce: BigInt(op.nonce!), deadline: now + 600, usdg: USDG, paymaster: PM,
    sign: data => { typed = data; return owner.signTypedData(data); } });
  // Native MAv2 SDK strips the hooks byte + full nonce from deferredAction, then appends the userOp signature.
  const signature = concatHex([`0x${auth.deferredAction.slice(68)}`, "0xff00", `0x${"11".repeat(65)}`]);
  return { auth, typed, signature };
}

test("deferred bootstrap binds owner, chain, account, full nonce, expiry and the exact USDG allowance", async () => {
  const { auth, typed, signature } = await bootstrap();
  assert.equal(auth.nonce, 3n << 64n);
  assert.equal(typed.message.call, prepayApprovalCall(USDG, PM));
  const length = Number(BigInt(`0x${signature.slice(2,10)}`));
  const authStart = 10 + length * 2 + 8;
  const ownerAuth = `0x${signature.slice(authStart + 2, authStart + 2 + 130)}` as Hex;
  assert.equal((await recoverTypedDataAddress({ ...typed, signature: ownerAuth })).toLowerCase(), owner.address.toLowerCase());
  assert.equal(hasDeferredPrepayApproval({ ...op, nonce: toHex(auth.nonce), signature }, USDG, PM), true);
  assert.equal(hasDeferredPrepayApproval({ ...op, nonce: toHex(auth.nonce), signature }, USDG, OTHER), false);
  assert.equal(hasDeferredPrepayApproval({ ...op, signature }, USDG, PM), false);
  assert.equal(hasDeferredPrepayApproval({ ...op, signature: "0xdead" }, USDG, PM), false);
  await assert.rejects(prepayBootstrap({ account: S, chainId: 46630, nonce: 0n, deadline: now + 600, usdg: USDG, paymaster: PM, sign: d => owner.signTypedData(d) }), /owner\/global/);
});

test("same-execution approval is rejected; exact native owner-validation approval enables the first quote", async () => {
  const noAllowance = { ...deps, allowanceOf: async () => 0n };
  await assert.rejects(finalQuote(op, ENTRYPOINT_V07, 46630, cfg, noAllowance), /standing USDG allowance/);
  const { auth, signature } = await bootstrap();
  const q = await finalQuote({ ...op, nonce: toHex(auth.nonce), signature }, ENTRYPOINT_V07, 46630, cfg, noAllowance);
  assert.equal(q.paymaster, PM);
  await assert.rejects(allowanceQuote(S, ENTRYPOINT_V07, 46630, cfg, noAllowance), /standing USDG allowance/);
  await assert.rejects(finalQuote({ ...op, nonce: toHex(auth.nonce), signature }, ENTRYPOINT_V07, 46630, cfg, { ...noAllowance, balanceOf: async () => 0n }), /not enough USDG/);
});

test("price-source rate is unchanged at 1.0x, without markup", () => {
  assert.equal(unmarkedRate(rate), rate);
  assert.equal(unmarkedRate(101n), 101n, "no rounding-up markup");
});

test("external bundler guard requires active paymaster AND factory stake with >=1-day delay", () => {
  const good = { staked: true, stake: 100n, unstakeDelaySec: 86400, withdrawTime: 0 };
  assert.doesNotThrow(() => requireStake(good, 100n));
  for (const bad of [{ ...good, staked: false }, { ...good, stake: 99n }, { ...good, unstakeDelaySec: 86399 }, { ...good, withdrawTime: 1 }])
    assert.throws(() => requireStake(bad, 100n));
  assert.throws(() => requireStake(good, 0n));
});

test("only an explicitly allowed, positive user-paid quote passes the sponsorship boundary", () => {
  const q = stubPaymasterData({ validUntil: now + 600, validAfter: now - 30, rate, maxTokenCost: 1_000_000n });
  assert.doesNotThrow(() => checkUserPaid({ ...op, paymasterData: q }, PM));
  assert.throws(() => checkUserPaid({ ...op, paymasterData: q }, OTHER));
  assert.throws(() => checkUserPaid({ ...op, paymasterData: "0x" }, PM));
  assert.throws(() => checkUserPaid({ ...op, paymasterData: stubPaymasterData({ validUntil: now+600, validAfter: now-30, rate, maxTokenCost: 0n }) }, PM));
});

test("warm one-tap signs locally, uses a fresh USDG quote, and performs ZERO quote or chain roundtrips before standard submit", async () => {
  const a = new Mav2Account({ chain: robinhoodTestnet, pc: {} as never, bundlerUrl: "http://bundler.invalid", requireUsdgGas: true,
    usdgGas: { paymaster: PM, usdg: USDG, url: "http://paymaster.invalid", session: true } }, owner);
  const allowance = await allowanceQuote(S, ENTRYPOINT_V07, 46630, cfg, deps);
  a.allowances!.set(allowance); a.deployed = true;
  let signed = 0; const requests: { url: string; body: any }[] = [];
  const client = { account: { address: S, encodeBatchExecute: async (cs: any[]) => batch(cs.map(c => ({ to: c.target, value: c.value, data: c.data }))), encodeExecute: async () => op.callData },
    buildUserOperation: async ({ uo, overrides }: any) => ({ ...op, callData: batch((Array.isArray(uo) ? uo : [uo]).map(c => ({ to: c.target, value: c.value, data: c.data }))), ...overrides }),
    signUserOperation: async ({ uoStruct }: any) => { signed++; return { ...uoStruct, signature: "0x01" }; } };
  (a as any).sessionClient = { entityId: 7, c: Promise.resolve(client) };
  (a as any).findOp = async () => ({ userOpHash: H, txHash: H, success: true, logs: [] });
  FEES.invalidate(); await FEES.get(async () => clientFees(1n));
  const old = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { requests.push({ url: String(url), body: JSON.parse(String(opts?.body)) }); return Response.json({ result: H }); };
  try {
    for (let i = 0; i < 3; i++) assert.equal((await a.sendCalls([{ to: OTHER, data: "0x12345678" }], "session")).gasMode, "usdg");
    assert.equal(signed, 3); assert.equal(requests.length, 3);
    for (const r of requests) { assert.equal(r.url, "http://bundler.invalid"); assert.equal(r.body.method, "eth_sendUserOperation"); assert.equal(r.body.params[0].paymaster, PM); assert.equal(r.body.params[0].paymasterData, allowance.paymasterData); }
    assert.equal(new Set(requests.map(r => r.body.params[0].nonce)).size, 3);
    assert.ok(a.gasReservePerOp() > 0n);
  } finally { globalThis.fetch = old; FEES.invalidate(); }
});

test("embedded account with missing prepaid configuration never falls back to ETH or a protocol relay", async () => {
  const a = new Mav2Account({ chain: robinhoodTestnet, pc: {} as never, bundlerUrl: "http://bundler.invalid", requireUsdgGas: true }, owner);
  await assert.rejects(a.sendCalls([{ to: OTHER, data: "0x12345678" }]), (e: any) => e.code === "Bundler" && /temporarily unavailable/.test(e.message));
});


test("cold zero-ETH bootstrap estimates WITH prepaid paymaster fields, then signs exactly once", async () => {
  const { auth, signature } = await bootstrap();
  const a = new Mav2Account({ chain: robinhoodTestnet, pc: {} as never, bundlerUrl: "http://bundler.invalid", requireUsdgGas: true,
    usdgGas: { paymaster: PM, usdg: USDG, url: "http://paymaster.invalid", session: true } }, owner);
  let estimates = 0, signed = 0; const methods: string[] = [];
  const client = { account: { address: S },
    buildUserOperation: async ({ uo, overrides }: any) => {
      if (overrides.paymasterData !== "0x") {
        estimates++;
        assert.equal(overrides.paymaster, PM);
        assert.equal(overrides.paymasterVerificationGasLimit, toHex(PAYMASTER_GAS.verificationGasLimit));
        assert.ok(overrides.paymasterData.length > 2);
        assert.equal(overrides.callGasLimit, undefined, "real cold estimate must not inherit sizing-only seed gas");
      }
      return { ...op, callGasLimit: toHex(800_000n), verificationGasLimit: toHex(450_000n), preVerificationGas: toHex(100_000n),
        ...overrides, callData: batch((Array.isArray(uo) ? uo : [uo]).map(c => ({ to: c.target, value: c.value, data: c.data }))), signature };
    }, signUserOperation: async ({ uoStruct }: any) => { signed++; return { ...uoStruct, signature }; } };
  (a as any).preparePrepay = async () => ({ client, nonce: auth.nonce });
  (a as any).findOp = async () => ({ userOpHash: H, txHash: H, success: true, logs: [] });
  const noAllowance = { ...deps, allowanceOf: async () => 0n };
  FEES.invalidate(); await FEES.get(async () => clientFees(1n));
  const old = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const r = JSON.parse(String(options?.body)); methods.push(r.method);
    if (r.method === "pm_getPaymasterAllowance") return Response.json({ error: { code: -32602, message: "standing approval not installed yet" } });
    if (r.method === "pm_getPaymasterStubData") return Response.json({ result: await stubQuote(r.params[0], ENTRYPOINT_V07, 46630, cfg, noAllowance) });
    if (r.method === "pm_getPaymasterData") return Response.json({ result: await finalQuote(r.params[0], ENTRYPOINT_V07, 46630, cfg, noAllowance) });
    assert.equal(r.method, "eth_sendUserOperation"); assert.equal(r.params[0].paymaster, PM);
    return Response.json({ result: H });
  };
  try {
    assert.equal((await a.sendCalls([{ to: OTHER, data: "0x12345678" }])).gasMode, "usdg");
    assert.equal(estimates, 1); assert.equal(signed, 1);
    assert.deepEqual(methods.filter(x => x !== "pm_getPaymasterAllowance"), ["pm_getPaymasterStubData", "pm_getPaymasterData", "eth_sendUserOperation"]);
  } finally { globalThis.fetch = old; FEES.invalidate(); }
});


test("REAL SDK gas middleware receives paymaster gas limits before external estimation", async () => {
  const data = stubPaymasterData({ validUntil: now+600, validAfter: now-30, rate, maxTokenCost: 1_000_000n });
  let estimated = 0;
  const result = await cachedGasEstimator({ sender: S, nonce: 0n, callData: "0x12345678", signature: "0x01" } as any, {
    account: { getEntryPoint: () => ({ version: "0.7.0", address: ENTRYPOINT_V07 }) },
    overrides: { paymaster: PM, paymasterData: data, paymasterVerificationGasLimit: toHex(PAYMASTER_GAS.verificationGasLimit), paymasterPostOpGasLimit: toHex(PAYMASTER_GAS.postOpGasLimit) },
    client: { estimateUserOperationGas: async (r: any) => {
      estimated++; assert.equal(r.paymaster, PM); assert.equal(r.paymasterData, data);
      assert.equal(BigInt(r.paymasterVerificationGasLimit), PAYMASTER_GAS.verificationGasLimit);
      assert.equal(BigInt(r.paymasterPostOpGasLimit), PAYMASTER_GAS.postOpGasLimit);
      return { callGasLimit: 800_000n, verificationGasLimit: 450_000n, preVerificationGas: 100_000n, paymasterVerificationGasLimit: 50_000n };
    } },
  } as any);
  assert.equal(estimated, 1); assert.equal(BigInt((result as any).paymasterVerificationGasLimit), PAYMASTER_GAS.verificationGasLimit);
});
