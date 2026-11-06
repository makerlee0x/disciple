// Deployed owner sends must clear Alchemy's verification-gas efficiency floor (0.4).
// Live numbers below are from the rejected production send (not a retest). Planned
// efficiencies are computed from those numbers plus the bundler-estimate fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, maxUint256, parseAbi, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PAYMASTER_GAS } from "../lib/aa/paymaster";
import { STATIC_GAS, deployedOwnerVerificationGas, verificationEfficiencyBps, VERIFICATION_EFFICIENCY_FLOOR_BPS } from "../lib/aa/fastPath";
import { Mav2Account, FEES, cachedGasEstimator } from "../lib/aa/mav2";
import { finalQuote, stubQuote, type QuoteConfig, type QuoteDeps } from "../lib/server/paymasterCore";
import { clientFees } from "../lib/aa/gasPolicy";
import { ENTRYPOINT_V07 } from "../lib/aa/constants";
import { robinhoodTestnet } from "../lib/chains";
import type { Call, UserOp } from "../lib/aa/core";

const owner = privateKeyToAccount(`0x${"01".repeat(32)}`);
const S = `0x${"11".repeat(20)}` as Address, PM = `0x${"22".repeat(20)}` as Address, USDG = `0x${"33".repeat(20)}` as Address;
const OTHER = `0x${"44".repeat(20)}` as Address, H = `0x${"55".repeat(32)}` as Hex;
const exec = parseAbi(["struct Call { address target; uint256 value; bytes data; }", "function executeBatch(Call[] calls)"]);
const batch = (cs: Call[]) => encodeFunctionData({ abi: exec, functionName: "executeBatch", args: [cs.map(c => ({ target: c.to, value: c.value ?? 0n, data: c.data }))] });
const rate = 2_300_000_000n, now = Math.floor(Date.now() / 1000);
const cfg: QuoteConfig = { paymaster: PM, usdg: USDG, usdgDecimals: 6, rate };
const deps: QuoteDeps = { now: () => now, debtOf: async () => 0n, balanceOf: async () => 100_000_000n, allowanceOf: async () => maxUint256,
  bounds: async () => ({ minRate: rate / 2n, maxRate: rate * 2n, maxLaunchGasPerOp: BigInt(30_000_000), maxGasPerOp: 12_000_000n }), baseFee: async () => 1n, sign: hash => owner.signMessage({ message: { raw: hash } }) };

/** Observed on the rejected owner send. Alchemy printed 0.2935 against 350_000 + 250_000. */
const LIVE_USED = 176_100n;
const LIVE_ACCOUNT = 350_000n;
const LIVE_PM = 250_000n;

test("rejected owner send is under Alchemy's 0.4 floor; every split of that used gas clears it after the clamp", () => {
  assert.equal(verificationEfficiencyBps(LIVE_USED, LIVE_ACCOUNT, LIVE_PM), 2935n);
  assert.ok(verificationEfficiencyBps(LIVE_USED, LIVE_ACCOUNT, LIVE_PM) < VERIFICATION_EFFICIENCY_FLOOR_BPS);
  assert.equal(LIVE_ACCOUNT, STATIC_GAS.verificationGasLimit);
  assert.equal(LIVE_PM, PAYMASTER_GAS.verificationGasLimit);

  // The live trace did not split account vs paymaster. Any split of the observed 176_100 must still clear 0.4
  // once the account limit comes from the estimate and the server keeps stamping 250_000.
  for (const estV of [10_000n, 110_000n, 141_333n, LIVE_USED]) {
    const estPm = LIVE_USED - estV;
    const limit = deployedOwnerVerificationGas({
      estimatedVerification: estV, estimatedPaymasterVerification: estPm, paymasterLimit: LIVE_PM,
    });
    assert.ok(limit >= estV, "never under the bundler estimate");
    assert.ok(limit <= estV + estV / 5n, "headroom stays modest");
    const planned = verificationEfficiencyBps(LIVE_USED, limit, LIVE_PM);
    assert.ok(planned >= VERIFICATION_EFFICIENCY_FLOOR_BPS, `split ${estV}+${estPm} planned ${planned}`);
  }

  // The split consistent with a ~110k owner validation and the rest in the paymaster.
  const planned = deployedOwnerVerificationGas({
    estimatedVerification: 110_000n, estimatedPaymasterVerification: 66_100n, paymasterLimit: LIVE_PM,
  });
  assert.equal(planned, 121_000n); // 10% headroom, under the 0.45 clamp
  const bps = verificationEfficiencyBps(LIVE_USED, planned, LIVE_PM);
  assert.equal(bps, 4746n); // 176_100 / (121_000 + 250_000) = 0.4746, unit math, not a live retest
});

test("gas middleware keeps the stamped paymaster limit and exposes the measured one", async () => {
  const result = await cachedGasEstimator({ sender: S, nonce: 0n, callData: "0x12345678", signature: "0x01" } as never, {
    account: { getEntryPoint: () => ({ version: "0.7.0", address: ENTRYPOINT_V07 }) },
    overrides: { paymaster: PM, paymasterData: "0x1234", paymasterVerificationGasLimit: toHex(PAYMASTER_GAS.verificationGasLimit), paymasterPostOpGasLimit: toHex(PAYMASTER_GAS.postOpGasLimit) },
    client: { estimateUserOperationGas: async (r: { paymasterVerificationGasLimit: string }) => {
      assert.equal(BigInt(r.paymasterVerificationGasLimit), PAYMASTER_GAS.verificationGasLimit);
      return { callGasLimit: 400_000n, verificationGasLimit: 110_000n, preVerificationGas: 50_000n, paymasterVerificationGasLimit: 66_100n };
    } },
  } as never) as { paymasterVerificationGasLimit: bigint | Hex; verificationGasLimit: bigint; estimatedPaymasterVerificationGasLimit: bigint };
  assert.equal(BigInt(result.paymasterVerificationGasLimit), PAYMASTER_GAS.verificationGasLimit);
  assert.equal(BigInt(result.verificationGasLimit), 110_000n);
  assert.equal(BigInt(result.estimatedPaymasterVerificationGasLimit), 66_100n);
});

test("deployed owner send uses the estimate plus headroom; a session trade keeps STATIC_GAS", async () => {
  const a = new Mav2Account({ chain: robinhoodTestnet, pc: {} as never, bundlerUrl: "http://bundler.invalid", requireUsdgGas: true,
    usdgGas: { paymaster: PM, usdg: USDG, url: "http://paymaster.invalid", session: true } }, owner);
  a.deployed = true;
  const op: UserOp = { sender: S, nonce: toHex(1n << 64n), callData: "0x", signature: "0x",
    callGasLimit: toHex(STATIC_GAS.callGasLimit), verificationGasLimit: toHex(STATIC_GAS.verificationGasLimit), preVerificationGas: toHex(STATIC_GAS.preVerificationGas),
    ...Object.fromEntries(Object.entries(clientFees(1n)).map(([k, v]) => [k, toHex(v)])),
    paymaster: PM, paymasterVerificationGasLimit: toHex(PAYMASTER_GAS.verificationGasLimit), paymasterPostOpGasLimit: toHex(PAYMASTER_GAS.postOpGasLimit) };
  const client = {
    account: { address: S, encodeBatchExecute: async (cs: { target: Address; value?: bigint; data: Hex }[]) => batch(cs.map(c => ({ to: c.target, value: c.value, data: c.data }))), encodeExecute: async () => "0x12345678" },
    buildUserOperation: async ({ uo, overrides }: { uo: { target: Address; data: Hex; value?: bigint } | { target: Address; data: Hex; value?: bigint }[]; overrides: Record<string, Hex | undefined> }) => {
      const calls = (Array.isArray(uo) ? uo : [uo]).map(c => ({ to: c.target, value: c.value, data: c.data }));
      const placeholder = overrides.paymasterData === "0x";
      return {
        ...op, ...overrides, callData: batch(calls),
        callGasLimit: overrides.callGasLimit ?? toHex(400_000n),
        verificationGasLimit: overrides.verificationGasLimit ?? toHex(110_000n),
        preVerificationGas: overrides.preVerificationGas ?? toHex(50_000n),
        estimatedPaymasterVerificationGasLimit: placeholder || overrides.verificationGasLimit ? undefined : 66_100n,
      };
    },
    signUserOperation: async ({ uoStruct }: { uoStruct: UserOp }) => ({ ...uoStruct, signature: "0x01" }),
  };
  (a as unknown as { preparePrepay: () => Promise<unknown> }).preparePrepay = async () => ({ client });
  (a as unknown as { findOp: () => Promise<unknown> }).findOp = async () => ({ userOpHash: H, txHash: H, success: true, logs: [] });
  (a as unknown as { sessionClient: unknown }).sessionClient = { entityId: 7, c: Promise.resolve(client) };
  FEES.invalidate(); await FEES.get(async () => clientFees(1n));
  const sent: UserOp[] = [];
  const old = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const r = JSON.parse(String(options?.body)) as { method: string; params: [UserOp, ...unknown[]] };
    if (r.method === "pm_getPaymasterAllowance") return Response.json({ error: { code: -32602, message: "no allowance" } });
    if (r.method === "pm_getPaymasterStubData") return Response.json({ result: await stubQuote(r.params[0], ENTRYPOINT_V07, 46630, cfg, deps) });
    if (r.method === "pm_getPaymasterData") return Response.json({ result: await finalQuote(r.params[0], ENTRYPOINT_V07, 46630, cfg, deps) });
    assert.equal(r.method, "eth_sendUserOperation");
    sent.push(r.params[0]);
    return Response.json({ result: H });
  };
  try {
    assert.equal((await a.sendCalls([{ to: OTHER, data: "0x12345678" }], "owner")).gasMode, "usdg");
    assert.equal(BigInt(sent[0].verificationGasLimit!), 121_000n);
    assert.equal(BigInt(sent[0].paymasterVerificationGasLimit!), PAYMASTER_GAS.verificationGasLimit);
    assert.ok(verificationEfficiencyBps(LIVE_USED, BigInt(sent[0].verificationGasLimit!), BigInt(sent[0].paymasterVerificationGasLimit!)) >= VERIFICATION_EFFICIENCY_FLOOR_BPS);
    sent.length = 0;
    assert.equal((await a.sendCalls([{ to: OTHER, data: "0x12345678" }], "session")).gasMode, "usdg");
    assert.equal(BigInt(sent[0].verificationGasLimit!), STATIC_GAS.verificationGasLimit);
  } finally { globalThis.fetch = old; FEES.invalidate(); }
});
