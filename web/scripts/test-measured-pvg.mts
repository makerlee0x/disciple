// Offline only: SDK middleware + real quote rules + mocked submit; no external transport.
import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, maxUint256, parseAbi, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bufferedPvg, measurePvg } from "../lib/aa/preVerificationGas";
import { STATIC_GAS, ownerEstimateBounds, verificationEfficiencyBps, PAYMASTER_MAX_GAS_PER_OP } from "../lib/aa/fastPath";
import { Mav2Account, cachedGasEstimator, FEES } from "../lib/aa/mav2";
import { PAYMASTER_GAS, decodePaymasterData, paymasterQuoteHash, requiredMaxTokenCost } from "../lib/aa/paymaster";
import { stubQuote, finalQuote, type QuoteDeps, type QuoteConfig } from "../lib/server/paymasterCore";
import { clientFees } from "../lib/aa/gasPolicy";
import { ENTRYPOINT_V07 } from "../lib/aa/constants";
import { robinhoodTestnet } from "../lib/chains";
import { setupCreditCalls } from "../lib/aa/prepayBootstrap";
import { userOpHash, type Call, type UserOp } from "../lib/aa/core";
const owner = privateKeyToAccount(`0x${"01".repeat(32)}`);
const S = `0x${"11".repeat(20)}` as Address, PM = `0x${"22".repeat(20)}` as Address, USDG = `0x${"33".repeat(20)}` as Address, OTHER = `0x${"44".repeat(20)}` as Address, H = `0x${"55".repeat(32)}` as Hex;
const abi = parseAbi(["function executeBatch((address target,uint256 value,bytes data)[] calls)"]);
const batch = (cs: Call[]) => encodeFunctionData({ abi, functionName: "executeBatch", args: [cs.map(c => ({ target: c.to, value: c.value ?? 0n, data: c.data }))] });
const pm = { paymaster: PM, paymasterData: "0x1234" as Hex, paymasterVerificationGasLimit: toHex(PAYMASTER_GAS.verificationGasLimit), paymasterPostOpGasLimit: toHex(PAYMASTER_GAS.postOpGasLimit) };
const entry = { version: "0.7.0", address: ENTRYPOINT_V07 };
const base: UserOp = { sender: S, nonce: "0x0", callData: "0x12345678", signature: "0x01", ...pm, callGasLimit: toHex(STATIC_GAS.callGasLimit), verificationGasLimit: toHex(STATIC_GAS.verificationGasLimit), preVerificationGas: toHex(60_000n), maxFeePerGas: toHex(50_200_000n), maxPriorityFeePerGas: toHex(1_100_000n) };

test("15% round-up, conservative failure floor, and no fixed 60k overwrite", async () => {
  assert.equal(bufferedPvg(61_044n), 70_201n);
  assert.equal(bufferedPvg(), 69_000n);
  assert.equal(bufferedPvg(1n), 69_000n);
  assert.equal(await measurePvg(base, async r => { assert.equal(BigInt(r.preVerificationGas!), 0n); return { preVerificationGas: 90_000n }; }), 103_500n);
  assert.equal(await measurePvg(base, async () => { throw Error("RPC timeout"); }), 69_000n);
  assert.equal(await measurePvg(base, async () => ({ preVerificationGas: "bad" as Hex })), 69_000n);
});

test("cached static limits request measured PVG even with caller's 60k; RPC failure falls back", async () => {
  for (const fail of [false, true]) {
    const r = await cachedGasEstimator({ ...base } as never, {
      account: { getEntryPoint: () => entry }, overrides: { ...pm, ...STATIC_GAS },
      client: { estimateUserOperationGas: async (q: UserOp) => {
        assert.equal(BigInt(q.preVerificationGas!), 0n);
        assert.equal(BigInt(q.callGasLimit!), STATIC_GAS.callGasLimit);
        assert.equal(BigInt(q.verificationGasLimit!), STATIC_GAS.verificationGasLimit);
        if (fail) throw Error("offline");
        return { preVerificationGas: 61_044n };
      } },
    } as never);
    assert.equal(BigInt(r.preVerificationGas!), fail ? 69_000n : 70_201n);
  }
});

test("owner request uses zero PVG; 120k ->132k and efficiency/cap invariants survive buffering", async () => {
  const bounds = ownerEstimateBounds(pm);
  assert.equal(bounds.preVerificationGas, 0n);
  const result = await cachedGasEstimator({ ...base } as never, {
    account: { getEntryPoint: () => entry }, overrides: { ...pm, estimateBounds: bounds, preVerificationGas: 60_000n },
    client: { estimateUserOperationGas: async (q: UserOp) => {
      assert.equal(BigInt(q.preVerificationGas!), 0n);
      assert.equal(BigInt(q.verificationGasLimit!), 120_000n);
      return { callGasLimit: 1_800_000n, verificationGasLimit: 120_000n, paymasterVerificationGasLimit: 250_000n, preVerificationGas: 61_044n };
    } },
  } as never);
  assert.equal(BigInt(result.preVerificationGas!), 70_201n);
  for (const verification of [132_000n, STATIC_GAS.verificationGasLimit]) {
    const pvg = bufferedPvg(61_044n);
    const used = verification === 132_000n ? 176_100n : 250_000n;
    // preOpGas rises by the same amount as PVG: numerator is unchanged.
    const oldPreOp = used + 60_000n, newPreOp = used + pvg;
    assert.equal(oldPreOp - 60_000n, newPreOp - pvg);
    const bps = verificationEfficiencyBps(used, verification, PAYMASTER_GAS.verificationGasLimit);
    assert.ok(bps >= 4000n);
    assert.ok(STATIC_GAS.callGasLimit + verification + pvg + PAYMASTER_GAS.verificationGasLimit + PAYMASTER_GAS.postOpGasLimit < PAYMASTER_MAX_GAS_PER_OP);
  }
});

for (const { mode, fail } of [{ mode: "owner", fail: false }, { mode: "session", fail: false }, { mode: "session", fail: true }] as const) test(`${mode} (estimate fails=${fail}): final quote hash, account signature, cached template and higher token charge use buffered PVG`, async () => {
  const expectedPvg = fail ? 69_000n : 70_201n;
  const rate = 2_300_000_000n, now = Math.floor(Date.now() / 1000);
  const cfg: QuoteConfig = { paymaster: PM, usdg: USDG, usdgDecimals: 6, rate };
  const quoteHashes: Hex[] = [], signed: UserOp[] = [], sent: UserOp[] = [], estimatePvgs: bigint[] = [];
  const deps: QuoteDeps = { now: () => now, debtOf: async () => 0n, balanceOf: async () => 100_000_000n, allowanceOf: async () => maxUint256, bounds: async () => ({ minRate: rate / 2n, maxRate: rate * 2n, maxGasPerOp: PAYMASTER_MAX_GAS_PER_OP, maxLaunchGasPerOp: 30_000_000n }), baseFee: async () => 1n,
    sign: async hash => { quoteHashes.push(hash); return owner.signMessage({ message: { raw: hash } }); } };
  const client: any = { account: { address: S, getEntryPoint: () => entry, encodeBatchExecute: async (cs: any[]) => batch(cs.map(c => ({ to: c.target, ...c }))), encodeExecute: async (c: any) => batch([{ to: c.target, ...c }]) },
    estimateUserOperationGas: async (q: UserOp) => { estimatePvgs.push(BigInt(q.preVerificationGas!)); assert.equal(BigInt(q.preVerificationGas!), 0n); if (fail) throw Error("network unavailable"); return { callGasLimit: BigInt(q.callGasLimit ?? 800_000n), verificationGasLimit: BigInt(q.verificationGasLimit ?? 120_000n), preVerificationGas: 61_044n, paymasterVerificationGasLimit: 250_000n }; },
    buildUserOperation: async ({ uo, overrides }: any) => {
      const cs = (Array.isArray(uo) ? uo : [uo]).map((c: any) => ({ to: c.target, value: c.value, data: c.data }));
      return cachedGasEstimator({ ...base, ...overrides, callData: batch(cs) } as never, { account: client.account, overrides, client } as never);
    }, signUserOperation: async ({ uoStruct }: any) => { signed.push({ ...uoStruct }); return { ...uoStruct, signature: "0x01" }; } };
  const a = new Mav2Account({ chain: robinhoodTestnet, pc: {} as never, bundlerUrl: "http://bundler.invalid", requireUsdgGas: true, usdgGas: { paymaster: PM, usdg: USDG, url: "http://paymaster.invalid", session: true } }, owner);
  a.deployed = true;
  (a as any).preparePrepay = async () => ({ client });
  (a as any).findOp = async () => ({ userOpHash: H, txHash: H, success: true, logs: [] });
  (a as any).sessionClient = { entityId: 7, c: Promise.resolve(client) };
  FEES.invalidate(); await FEES.get(async () => clientFees(1n));
  const old = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const r = JSON.parse(String(options?.body));
    if (r.method === "pm_getPaymasterAllowance") return Response.json({ error: { code: -32602, message: "cold" } });
    if (r.method === "pm_getPaymasterStubData") return Response.json({ result: await stubQuote(r.params[0], ENTRYPOINT_V07, 46630, cfg, deps) });
    if (r.method === "pm_getPaymasterData") {
      assert.equal(BigInt(r.params[0].preVerificationGas), expectedPvg);
      return Response.json({ result: await finalQuote(r.params[0], ENTRYPOINT_V07, 46630, cfg, deps) });
    }
    assert.equal(r.method, "eth_sendUserOperation"); // intercepted mock only
    sent.push(r.params[0]); return Response.json({ result: H });
  };
  try {
    const cs = mode === "owner" ? [...setupCreditCalls(USDG, PM, S), { to: S, data: "0x12345678" as Hex }] : [{ to: OTHER, data: "0x12345678" as Hex }];
    for (let i = 0; i < 2; i++) await a.sendCalls(cs, mode);
    assert.equal(estimatePvgs.length, 2, "fresh PVG per op including template hits, no duplicate quote-phase estimate");
    assert.equal(sent.length, 2); assert.equal(signed.length, 2);
    for (let i = 0; i < sent.length; i++) {
      const op = sent[i], q = decodePaymasterData(op.paymasterData!);
      assert.equal(BigInt(op.preVerificationGas!), expectedPvg);
      assert.equal(BigInt(op.callGasLimit!), STATIC_GAS.callGasLimit);
      assert.equal(BigInt(op.verificationGasLimit!), mode === "owner" ? 132_000n : 350_000n);
      assert.equal("measuredPreVerificationGas" in op, false);
      assert.equal(userOpHash(signed[i], 46630), userOpHash(op, 46630));
      assert.equal(quoteHashes[i], paymasterQuoteHash(op, q, 46630, PM));
      assert.notEqual(quoteHashes[i], paymasterQuoteHash({ ...op, preVerificationGas: toHex(60_000n) }, q, 46630, PM));
      assert.equal(q.maxTokenCost, requiredMaxTokenCost(op, rate));
      assert.ok(q.maxTokenCost > requiredMaxTokenCost({ ...op, preVerificationGas: toHex(60_000n) }, rate));
    }
  } finally { globalThis.fetch = old; FEES.invalidate(); }
});
