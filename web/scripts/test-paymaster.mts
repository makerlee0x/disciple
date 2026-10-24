// Unit tests for the USDG token paymaster client/server code (lib/aa/paymaster, lib/server/paymasterCore).
//   pnpm test:paymaster            (pure: no RPC, no keys — a throwaway test key signs)
// Optional byte-for-byte parity with the Solidity contract (getHash / parsePaymasterAndData / firstCallApproves /
// tokenCost) against a DisciplePaymaster deployed on a LOCAL anvil:
//   PAYMASTER_PARITY_RPC=http://127.0.0.1:8545 PAYMASTER_PARITY_ADDR=0x… PAYMASTER_PARITY_USDG=0x… pnpm test:paymaster
import { test } from "node:test";
import assert from "node:assert/strict";
import { concat, createPublicClient, encodeFunctionData, http, pad, parseAbi, recoverMessageAddress, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  decodePaymasterData, encodePaymasterData, entryPointMaxCost, firstCallApproveAmount, formatUsdg, PAYMASTER_DATA_LENGTH, PAYMASTER_GAS,
  ALLOWANCE_GAS, ALLOWANCE_TYPEHASH, paymasterAllowanceHash, paymasterApproveCall, paymasterQuoteHash, requiredMaxTokenCost, stubPaymasterData, tokenCost,
} from "../lib/aa/paymaster";
import { ALLOWANCE_FEE_MULT, allowanceQuote, DEFAULT_ALLOWANCE_TTL_SEC, DEFAULT_MAX_SLACK_BPS, finalQuote, PaymasterQuoteError, rateFromEnv, stubQuote, type QuoteConfig, type QuoteDeps } from "../lib/server/paymasterCore";
import { checkPaymaster, clientFees, GAS_CAPS, GRAD_GAS_CAPS, INFRA_WORDING, LAUNCH_GAS_CAPS, maxPrefund, NOT_ENOUGH_USDG, RelayPolicyError, relayerPrice, TRADING_UNAVAILABLE } from "../lib/aa/gasPolicy";
import { launchpadAbi } from "../lib/abi/Launchpad";
import { toFunctionSelector, type AbiFunction } from "viem";
import { STATIC_GAS } from "../lib/aa/fastPath";
import { ENTRYPOINT_V07 } from "../lib/aa/constants";
import type { UserOp } from "../lib/aa/core";
import { AllowanceCache, ALLOWANCE_REFRESH_AHEAD_SEC, fitsAllowance, payGasInUsdg, type Allowance } from "../lib/aa/paymasterClient";

const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}` as Hex;
const E18 = BigInt(10) ** BigInt(18);
const PM = "0x1111111111111111111111111111111111111111" as Address;
const USDG = "0x2222222222222222222222222222222222222222" as Address;
const SENDER = "0x3333333333333333333333333333333333333333" as Address;
const TOKEN = "0x4444444444444444444444444444444444444444" as Address;
const BASE = BigInt(10_000_000);
const execAbi = parseAbi(["function execute(address,uint256,bytes)", "struct C { address target; uint256 value; bytes data; }", "function executeBatch(C[])"]);
const batch = (calls: { to: Address; data: Hex; value?: bigint }[], prefix = false): Hex => {
  const cd = encodeFunctionData({ abi: execAbi, functionName: "executeBatch", args: [calls.map((c) => ({ target: c.to, value: c.value ?? BigInt(0), data: c.data }))] });
  return prefix ? concat(["0x8dd7712f", cd]) : cd;
};
const trade = { to: TOKEN, data: "0xdeadbeef" as Hex };
const LAUNCHPAD = "0x5555555555555555555555555555555555555555" as Address;
const launchSel = toFunctionSelector((launchpadAbi as readonly { type: string; name?: string }[]).find((f) => f.type === "function" && f.name === "launch") as AbiFunction);
const launchCall = { to: LAUNCHPAD, data: concat([launchSel, pad("0x01", { size: 32 })]) };
/** Launch op at the launch caps: 10M call + 350k verif + 60k PVG + paymaster 120k/80k = 10.61M ≤ 11M total. */
const LAUNCH_GAS = { callGasLimit: LAUNCH_GAS_CAPS.callGasLimit, verificationGasLimit: BigInt(350_000), preVerificationGas: BigInt(60_000) };

for (const dec of [18, 6]) {
  const RATE = BigInt(3000) * BigInt(10) ** BigInt(dec);
  const signerKey = generatePrivateKey();
  const signer = privateKeyToAccount(signerKey);
  const cfg: QuoteConfig = { paymaster: PM, usdg: USDG, usdgDecimals: dec, rate: RATE };
  const deps = (o: Partial<QuoteDeps> = {}): QuoteDeps => ({
    now: () => 1_790_000_000, debtOf: async () => BigInt(0), balanceOf: async () => BigInt(1_000_000) * BigInt(10) ** BigInt(dec),
    bounds: async () => ({ minRate: RATE / BigInt(10), maxRate: RATE * BigInt(10), maxCostCap: BigInt(5) * BigInt(10) ** BigInt(dec) }),
    baseFee: async () => BASE, sign: (h) => signer.signMessage({ message: { raw: h } }), ...o,
  });
  const fees = clientFees(BASE);
  const baseOp = (callData: Hex): UserOp => ({
    sender: SENDER, nonce: "0x5", callData, signature: "0x",
    callGasLimit: hex(STATIC_GAS.callGasLimit), verificationGasLimit: hex(STATIC_GAS.verificationGasLimit), preVerificationGas: hex(STATIC_GAS.preVerificationGas),
    maxFeePerGas: hex(fees.maxFeePerGas), maxPriorityFeePerGas: hex(fees.maxPriorityFeePerGas),
  });
  const twoPhase = async (d = deps(), prefix = true, tweak = (x: bigint) => x) => {
    const stub = await stubQuote(baseOp(batch([trade], prefix)), ENTRYPOINT_V07, 46630, cfg, d);
    const amt = tweak(BigInt(stub.disciple.maxTokenCost));
    const op: UserOp = { ...baseOp(batch([paymasterApproveCall(USDG, PM, amt), trade], prefix)), paymaster: stub.paymaster, paymasterVerificationGasLimit: stub.paymasterVerificationGasLimit, paymasterPostOpGasLimit: stub.paymasterPostOpGasLimit };
    return { stub, amt, op, final: () => finalQuote(op, ENTRYPOINT_V07, 46630, cfg, d) };
  };
  const rejects = (p: Promise<unknown>, code: PaymasterQuoteError["code"]) => assert.rejects(p, (e: unknown) => e instanceof PaymasterQuoteError && e.code === code);

  test(`[${dec}-dec] launch op (10M call gas, Launchpad target) quotes under LAUNCH_GAS_CAPS and a 10 USDG maxCostCap; non-launch is capped`, async () => {
    const one = BigInt(10) ** BigInt(dec);
    const lcfg: QuoteConfig = { ...cfg, launchers: [LAUNCHPAD] };
    const d = deps({ bounds: async () => ({ minRate: RATE / BigInt(10), maxRate: RATE * BigInt(10), maxCostCap: BigInt(10) * one }) });
    const lop = (calls: { to: Address; data: Hex }[]): UserOp => ({ ...baseOp(batch(calls)), callGasLimit: hex(LAUNCH_GAS.callGasLimit), verificationGasLimit: hex(LAUNCH_GAS.verificationGasLimit), preVerificationGas: hex(LAUNCH_GAS.preVerificationGas) });
    const stub = await stubQuote(lop([launchCall]), ENTRYPOINT_V07, 46630, lcfg, d);
    const amt = BigInt(stub.disciple.maxTokenCost);
    const op: UserOp = { ...lop([paymasterApproveCall(USDG, PM, amt), launchCall]), paymaster: stub.paymaster, paymasterVerificationGasLimit: stub.paymasterVerificationGasLimit, paymasterPostOpGasLimit: stub.paymasterPostOpGasLimit };
    const f = await finalQuote(op, ENTRYPOINT_V07, 46630, lcfg, d);
    assert.equal(firstCallApproveAmount(op.callData, USDG, PM), amt);
    assert.ok(f.paymasterData.length > 2);
    // 10.61M gas × client maxFee (base 0.01 gwei) × $3000/ETH ≈ 1.01 USDG; well under the 10 USDG cap
    const expected = tokenCost((LAUNCH_GAS.callGasLimit + LAUNCH_GAS.verificationGasLimit + LAUNCH_GAS.preVerificationGas + PAYMASTER_GAS.verificationGasLimit + PAYMASTER_GAS.postOpGasLimit) * fees.maxFeePerGas, RATE);
    assert.equal(amt, expected);
    assert.ok(amt > one && amt < (BigInt(11) * one) / BigInt(10), formatUsdg(amt, dec));
    // a full 11M-gas launch at 10x today's base fee still fits a 10 USDG cap at $3000/ETH
    const hot = clientFees(BASE * BigInt(10)).maxFeePerGas;
    assert.ok(tokenCost(LAUNCH_GAS_CAPS.total * hot, RATE) < BigInt(10) * one);
    // same op without the launcher list (or to a non-launch target) ⇒ normal 3M cap ⇒ "gas"
    await rejects(finalQuote(op, ENTRYPOINT_V07, 46630, cfg, d), "gas");
    await rejects(finalQuote({ ...op, callData: batch([paymasterApproveCall(USDG, PM, amt), { ...launchCall, to: TOKEN }]) }, ENTRYPOINT_V07, 46630, lcfg, d), "gas");
  });

  test(`[${dec}-dec] graduating buy (3.4M call gas) quotes under GRAD_GAS_CAPS only when deps.isGradBuy confirms it`, async () => {
    const gop = (callData: Hex): UserOp => ({ ...baseOp(callData), callGasLimit: hex(3_400_000) });
    let asked = 0; const senders = new Set<string>();
    const yes = deps({ isGradBuy: async (_cd: string, sender: string) => { asked++; senders.add(sender); return true; } }), no = deps({ isGradBuy: async () => false });
    const stub = await stubQuote(gop(batch([trade])), ENTRYPOINT_V07, 46630, cfg, yes);
    const amt = BigInt(stub.disciple.maxTokenCost);
    const op: UserOp = { ...gop(batch([paymasterApproveCall(USDG, PM, amt), trade])), paymaster: stub.paymaster, paymasterVerificationGasLimit: stub.paymasterVerificationGasLimit, paymasterPostOpGasLimit: stub.paymasterPostOpGasLimit };
    const f = await finalQuote(op, ENTRYPOINT_V07, 46630, cfg, yes);
    assert.ok(f.paymasterData.length > 2);
    assert.ok(asked >= 2);
    assert.deepEqual([...senders], [op.sender]);   // the checker gets the op's sender (balance / allowance check, audit r106)
    await rejects(finalQuote(op, ENTRYPOINT_V07, 46630, cfg, no), "gas");
    await rejects(finalQuote(op, ENTRYPOINT_V07, 46630, cfg, deps()), "gas");   // no checker ⇒ W-1 caps
    await rejects(finalQuote({ ...op, callGasLimit: hex(GRAD_GAS_CAPS.callGasLimit + BigInt(1)) }, ENTRYPOINT_V07, 46630, cfg, yes), "gas");
    // a normal-size op never asks
    asked = 0; await twoPhase(yes).then((x) => x.final()); assert.equal(asked, 0);
  });

  test(`[${dec}-dec] tokenCost rounds up; rate is USDG base units per ETH`, () => {
    assert.equal(tokenCost(E18, RATE), RATE);
    assert.equal(tokenCost(BigInt(1), RATE), (RATE + E18 - BigInt(1)) / E18); // never 0 for a non-zero cost
    assert.equal(tokenCost(BigInt(10) ** BigInt(12), BigInt(3000) * BigInt(10) ** BigInt(6)), BigInt(3000)); // 1e-6 ETH = $0.003 = 3000 base units at 6 dec
    assert.equal(tokenCost(BigInt(0), RATE), BigInt(0));
    assert.equal(rateFromEnv({ PAYMASTER_USD_PER_ETH: "3000" }, dec), RATE);
    assert.equal(rateFromEnv({ PAYMASTER_USD_PER_ETH: "2950.5" }, dec), BigInt(29505) * BigInt(10) ** BigInt(dec - 1));
    assert.equal(rateFromEnv({ PAYMASTER_RATE: "123", PAYMASTER_USD_PER_ETH: "3000" }, dec), BigInt(123));
    assert.throws(() => rateFromEnv({}, dec), PaymasterQuoteError);
    assert.throws(() => rateFromEnv({ PAYMASTER_RATE: "1e18" }, dec), PaymasterQuoteError);
  });

  test(`[${dec}-dec] paymasterData encode/decode round trip, 141 bytes; stub same length`, () => {
    const q = { validUntil: 1_790_000_180, validAfter: 1_789_999_970, rate: RATE, maxTokenCost: BigInt(12345) };
    const sig = `0x${"ab".repeat(64)}1b` as Hex;
    const d = encodePaymasterData(q, sig);
    assert.equal((d.length - 2) / 2, PAYMASTER_DATA_LENGTH);
    assert.deepEqual(decodePaymasterData(d), { ...q, signature: sig });
    assert.equal(stubPaymasterData(q).length, d.length);
  });

  test(`[${dec}-dec] firstCallApproveAmount: execute / executeBatch, with and without executeUserOp prefix`, () => {
    const ap = paymasterApproveCall(USDG, PM, BigInt(777));
    assert.equal(firstCallApproveAmount(batch([ap, trade]), USDG, PM), BigInt(777));
    assert.equal(firstCallApproveAmount(batch([ap, trade], true), USDG, PM), BigInt(777));
    assert.equal(firstCallApproveAmount(encodeFunctionData({ abi: execAbi, functionName: "execute", args: [USDG, BigInt(0), ap.data] }), USDG, PM), BigInt(777));
    assert.equal(firstCallApproveAmount(batch([trade, ap]), USDG, PM), null, "approve must be FIRST");
    assert.equal(firstCallApproveAmount(batch([paymasterApproveCall(TOKEN, PM, BigInt(1)), trade]), USDG, PM), null, "non-USDG");
    assert.equal(firstCallApproveAmount(batch([paymasterApproveCall(USDG, TOKEN, BigInt(1)), trade]), USDG, PM), null, "other spender");
    assert.equal(firstCallApproveAmount("0x1234", USDG, PM), null);
  });

  test(`[${dec}-dec] stub → approve → final: signed by the signer over the exact op; maxTokenCost = tokenCost(maxCost) + debt`, async () => {
    const { stub, amt, op, final } = await twoPhase();
    assert.equal(stub.paymasterVerificationGasLimit, hex(PAYMASTER_GAS.verificationGasLimit));
    assert.equal(amt, requiredMaxTokenCost(op, RATE, BigInt(0)));
    assert.equal(amt, tokenCost(entryPointMaxCost(op), RATE));
    const f = await final();
    const q = decodePaymasterData(f.paymasterData);
    assert.equal(q.maxTokenCost, amt);
    assert.equal(q.rate, RATE);
    assert.ok(q.validUntil > 1_790_000_000 && q.validAfter < 1_790_000_000 && q.validUntil - q.validAfter <= 3600);
    const h = paymasterQuoteHash({ ...op, ...f }, q, 46630, PM);
    assert.equal(await recoverMessageAddress({ message: { raw: h }, signature: q.signature }), signer.address);
    // the MAX (allowance / session-cap debit) at STATIC_GAS limits and 1.5x fee headroom stays well under $1 at
    // testnet fees; the actual charge is gas used × (base + tip), typically ~10x lower
    assert.ok(amt < BigInt(10) ** BigInt(dec), `max gas charge ${formatUsdg(amt, dec)} USDG`);
  });

  test(`[${dec}-dec] debt is added to the required allowance`, async () => {
    const debt = BigInt(42) * BigInt(10) ** BigInt(dec - 3 > 0 ? dec - 3 : 0);
    const { amt, op, final } = await twoPhase(deps({ debtOf: async () => debt }));
    assert.equal(amt, tokenCost(entryPointMaxCost(op), RATE) + debt);
    await final();
  });

  test(`[${dec}-dec] final refuses: no approve, under, too far over, over cap, balance, wrong chain/EP/paymaster, fee 0`, async () => {
    const d = deps();
    const noApprove: UserOp = { ...baseOp(batch([trade], true)), paymaster: PM };
    await rejects(finalQuote(noApprove, ENTRYPOINT_V07, 46630, cfg, d), "approve");
    await rejects((await twoPhase(d, true, (x) => x - BigInt(1))).final(), "approve");
    await rejects((await twoPhase(d, true, (x) => x + (x * DEFAULT_MAX_SLACK_BPS) / BigInt(10_000) + BigInt(1))).final(), "approve");
    await (await twoPhase(d, true, (x) => x + (x * DEFAULT_MAX_SLACK_BPS) / BigInt(10_000))).final(); // at the slack edge: OK
    await rejects((await twoPhase(deps({ bounds: async () => ({ minRate: BigInt(1), maxRate: RATE * BigInt(10), maxCostCap: BigInt(1) }) }))).final(), "approve");
    await rejects((await twoPhase(deps({ balanceOf: async () => BigInt(1) }))).final(), "balance");
    // the balance message reaches the client: no gas wording (mav2 matches /not enough USDG/ and shows NOT_ENOUGH_USDG)
    await assert.rejects((await twoPhase(deps({ balanceOf: async () => BigInt(1) }))).final(),
      (e: unknown) => e instanceof PaymasterQuoteError && /^not enough USDG: need /.test(e.message) && !INFRA_WORDING.test(e.message));
    const { op } = await twoPhase(d);
    await rejects(finalQuote(op, ENTRYPOINT_V07, 4663, cfg, d), "chain");
    await rejects(finalQuote(op, "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789", 46630, cfg, d), "entrypoint");
    await rejects(finalQuote({ ...op, paymaster: TOKEN }, ENTRYPOINT_V07, 46630, cfg, d), "op");
    await rejects(finalQuote({ ...op, maxFeePerGas: "0x0", maxPriorityFeePerGas: "0x0" }, ENTRYPOINT_V07, 46630, cfg, d), "gas");
    await rejects(finalQuote({ ...op, callGasLimit: hex(GAS_CAPS.callGasLimit + BigInt(1)) }, ENTRYPOINT_V07, 46630, cfg, d), "gas");
  });

  test(`[${dec}-dec] configured rate outside the contract's bounds is refused (stub and final)`, async () => {
    const d = deps({ bounds: async () => ({ minRate: RATE * BigInt(2), maxRate: RATE * BigInt(3), maxCostCap: E18 }) });
    await rejects(stubQuote(baseOp(batch([trade])), ENTRYPOINT_V07, 46630, cfg, d), "rate");
  });

  test(`[${dec}-dec] stub sizes unset gas fields at the caps (never under-quotes)`, async () => {
    const op: UserOp = { sender: SENDER, nonce: "0x0", callData: batch([trade]), signature: "0x" };
    const s = await stubQuote(op, ENTRYPOINT_V07, 46630, cfg, deps());
    const full = BigInt(s.disciple.maxTokenCost);
    const s2 = await stubQuote(baseOp(batch([trade])), ENTRYPOINT_V07, 46630, cfg, deps());
    assert.ok(full > BigInt(s2.disciple.maxTokenCost));
  });

  test(`[${dec}-dec] formatUsdg is decimals-aware`, () => {
    assert.equal(formatUsdg(BigInt(15) * BigInt(10) ** BigInt(dec - 1), dec), "1.5");
    assert.equal(formatUsdg(BigInt(1), dec, dec), `0.${"0".repeat(dec - 1)}1`);
    assert.equal(formatUsdg(BigInt(0), dec), "0");
  });
}

const rejectsA = (p: Promise<unknown>, code: PaymasterQuoteError["code"]) => assert.rejects(p, (e: unknown) => e instanceof PaymasterQuoteError && e.code === code);
// ── per-sender allowance (feat/trade-latency) ──
/** Fixed vector shared with contracts/test/paymaster/PaymasterAllowance.t.sol test_hashVector_matchesWeb. */
test("allowance hash: fixed vector (byte parity with DisciplePaymaster.getHash, asserted in forge)", () => {

  const h = paymasterAllowanceHash(SENDER, { validUntil: 1_790_000_600, validAfter: 1_789_999_970, rate: BigInt(3000) * E18, maxTokenCost: BigInt("123456789012345678") }, 46630, PM);
  assert.equal(h, ALLOWANCE_VECTOR);
});
const ALLOWANCE_VECTOR = "0x2712d08f58bdadb5f8d8c71b6d3b07446639b9ae4a25af59e4fd25107429c065";

for (const dec of [18, 6]) {
  const RATE = BigInt(3000) * BigInt(10) ** BigInt(dec);
  const signer = privateKeyToAccount(generatePrivateKey());
  const cfg: QuoteConfig = { paymaster: PM, usdg: USDG, usdgDecimals: dec, rate: RATE };
  const deps = (o: Partial<QuoteDeps> = {}): QuoteDeps => ({
    now: () => 1_790_000_000, debtOf: async () => BigInt(0), balanceOf: async () => BigInt(1_000_000) * BigInt(10) ** BigInt(dec),
    bounds: async () => ({ minRate: RATE / BigInt(10), maxRate: RATE * BigInt(10), maxCostCap: BigInt(5) * BigInt(10) ** BigInt(dec) }),
    baseFee: async () => BASE, sign: (h) => signer.signMessage({ message: { raw: h } }), ...o,
  });
  const fee = clientFees(BASE).maxFeePerGas * ALLOWANCE_FEE_MULT;
  const envelope = Object.values(ALLOWANCE_GAS).reduce((a, b) => a + b, BigInt(0));

  test(`[${dec}-dec] allowanceQuote: signed per-sender allowance for the trade envelope (+ debt), 10-min window`, async () => {
    const debt = BigInt(7);
    const a = await allowanceQuote(SENDER, ENTRYPOINT_V07, 46630, cfg, deps({ debtOf: async () => debt }));
    const q = decodePaymasterData(a.paymasterData);
    assert.equal(q.maxTokenCost, tokenCost(envelope * fee, RATE) + debt);
    assert.equal(BigInt(a.disciple.maxTokenCost), q.maxTokenCost);
    assert.equal(q.validUntil, 1_790_000_000 + DEFAULT_ALLOWANCE_TTL_SEC);
    assert.ok(q.validUntil - q.validAfter <= 3600);
    assert.equal(await recoverMessageAddress({ message: { raw: paymasterAllowanceHash(SENDER, q, 46630, PM) }, signature: q.signature }), signer.address);
    // NOT valid for another sender
    assert.notEqual(await recoverMessageAddress({ message: { raw: paymasterAllowanceHash(TOKEN, q, 46630, PM) }, signature: q.signature }), signer.address);
    assert.ok(q.maxTokenCost < BigInt(10) ** BigInt(dec), `allowance ${formatUsdg(q.maxTokenCost, dec)} USDG < $1`);
  });

  test(`[${dec}-dec] allowanceQuote refuses: balance, above cap, rate out of bounds, wrong chain / EP, bad sender`, async () => {
    await rejectsA(allowanceQuote(SENDER, ENTRYPOINT_V07, 46630, cfg, deps({ balanceOf: async () => BigInt(1) })), "balance");
    await rejectsA(allowanceQuote(SENDER, ENTRYPOINT_V07, 46630, cfg, deps({ bounds: async () => ({ minRate: BigInt(1), maxRate: RATE * BigInt(10), maxCostCap: BigInt(1) }) })), "approve");
    await rejectsA(allowanceQuote(SENDER, ENTRYPOINT_V07, 46630, cfg, deps({ bounds: async () => ({ minRate: RATE * BigInt(2), maxRate: RATE * BigInt(3), maxCostCap: E18 }) })), "rate");
    await rejectsA(allowanceQuote(SENDER, ENTRYPOINT_V07, 4663, cfg, deps()), "chain");
    await rejectsA(allowanceQuote(SENDER, "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789", 46630, cfg, deps()), "entrypoint");
    await rejectsA(allowanceQuote("0x1234" as Address, ENTRYPOINT_V07, 46630, cfg, deps()), "op");
  });

  test(`[${dec}-dec] payGasInUsdg with a fitting allowance: 0 pm_* calls, exact approve first, allowance paymasterData`, async () => {
    const a = (await allowanceQuote(SENDER, ENTRYPOINT_V07, 46630, cfg, deps())) as unknown as Allowance;
    const fees = clientFees(BASE);
    const g = globalThis.fetch; let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error("no network in this test"); }) as typeof fetch;
    try {
      const r = await payGasInUsdg({
        url: "http://x/api/paymaster", chainId: 46630, usdg: USDG, paymaster: PM, calls: [trade], allowance: a,
        build: async (cs, pm) => ({ sender: SENDER, nonce: "0x1", callData: batch(cs), signature: "0x", callGasLimit: hex(STATIC_GAS.callGasLimit), verificationGasLimit: hex(STATIC_GAS.verificationGasLimit), preVerificationGas: hex(STATIC_GAS.preVerificationGas), maxFeePerGas: hex(fees.maxFeePerGas * BigInt(2)), maxPriorityFeePerGas: hex(fees.maxPriorityFeePerGas), ...pm }),
        sign: async () => "0xsig" as Hex,
      });
      assert.equal(r.pmCalls, 0); assert.equal(calls, 0);
      assert.equal(r.op.paymasterData, a.paymasterData);
      assert.equal(firstCallApproveAmount(r.op.callData, USDG, PM), BigInt(a.disciple.maxTokenCost));
      assert.ok(fitsAllowance(r.op, a));
      // an op above the envelope (fee spike ×3) does NOT fit ⇒ falls back to the per-op flow (here: the mocked network)
      await assert.rejects(payGasInUsdg({
        url: "http://x/api/paymaster", chainId: 46630, usdg: USDG, paymaster: PM, calls: [trade], allowance: a,
        build: async (cs, pm) => ({ sender: SENDER, nonce: "0x1", callData: batch(cs), signature: "0x", callGasLimit: hex(STATIC_GAS.callGasLimit), verificationGasLimit: hex(STATIC_GAS.verificationGasLimit), preVerificationGas: hex(STATIC_GAS.preVerificationGas), maxFeePerGas: hex(fees.maxFeePerGas * BigInt(6)), maxPriorityFeePerGas: hex(fees.maxPriorityFeePerGas), ...pm }),
        sign: async () => "0xsig" as Hex,
      }), /no network/);
      assert.equal(calls, 1);
    } finally { globalThis.fetch = g; }
  });
}

test("AllowanceCache: refreshes in the background before validUntil, never serves a nearly-expired one, dedupes", async () => {
  let t = 1_000; let fetches = 0;
  const g = globalThis.fetch;
  globalThis.fetch = (async () => { fetches++; return new Response(JSON.stringify({ result: { paymaster: PM, paymasterVerificationGasLimit: "0x1", paymasterPostOpGasLimit: "0x1", paymasterData: "0x", disciple: { kind: "allowance", sender: SENDER, usdg: USDG, rate: "0x1", maxTokenCost: "0x1", debt: "0x0", validUntil: t + 600, validAfter: t - 30, maxFeePerGas: "0x1", usdgDecimals: 18 } } })); }) as typeof fetch;
  try {
    const c = new AllowanceCache({ url: "http://x", chainId: 46630 }, () => t);
    assert.equal(c.peek(SENDER), undefined);       // cold: kicks one fetch
    assert.equal(c.peek(SENDER), undefined);       // deduped
    await c.refresh(SENDER);
    assert.equal(fetches, 1);
    assert.ok(c.peek(SENDER));
    assert.equal(fetches, 1, "fresh: no refetch");
    t += 600 - ALLOWANCE_REFRESH_AHEAD_SEC + 1;   // inside the refresh window: still served, refresh kicked
    assert.ok(c.peek(SENDER));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(fetches, 2);
    t += 10_000;                                   // the refreshed one is also long expired now
    assert.equal(c.peek(SENDER), undefined);
    c.invalidate(SENDER); assert.equal(c.peek(SENDER), undefined);
  } finally { globalThis.fetch = g; }
});

// ── optional on-chain parity (local anvil only) ──
const RPC = process.env.PAYMASTER_PARITY_RPC, ADDR = process.env.PAYMASTER_PARITY_ADDR as Address | undefined, PUSDG = process.env.PAYMASTER_PARITY_USDG as Address | undefined;
test("parity with DisciplePaymaster.sol (getHash, parse, firstCallApproves, tokenCost)", { skip: !(RPC && ADDR && PUSDG) && "set PAYMASTER_PARITY_RPC/ADDR/USDG" }, async () => {
  const pc = createPublicClient({ transport: http(RPC) });
  const chainId = await pc.getChainId();
  const abi = parseAbi([
    "struct P { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
    "function getHash(address sender, uint48 validUntil, uint48 validAfter, uint256 rate, uint256 maxTokenCost) view returns (bytes32)",
    "function parsePaymasterAndData(bytes pmd) pure returns (uint48, uint48, uint256, uint256, bytes)",
    "function firstCallApproves(bytes cd, uint256 min) view returns (bool)",
    "function tokenCost(uint256 weiAmount, uint256 rate) pure returns (uint256)",
  ]);
  const fees = clientFees(BASE);
  const amt = BigInt("123456789012345678");
  const op: UserOp = {
    sender: SENDER, nonce: hex((BigInt(7) << BigInt(64)) | BigInt(3)), callData: batch([paymasterApproveCall(PUSDG!, ADDR!, amt), trade], true), signature: "0x",
    factory: TOKEN, factoryData: "0xabcdef",
    callGasLimit: hex(STATIC_GAS.callGasLimit), verificationGasLimit: hex(STATIC_GAS.verificationGasLimit), preVerificationGas: hex(STATIC_GAS.preVerificationGas),
    maxFeePerGas: hex(fees.maxFeePerGas), maxPriorityFeePerGas: hex(fees.maxPriorityFeePerGas),
    paymaster: ADDR, paymasterVerificationGasLimit: hex(PAYMASTER_GAS.verificationGasLimit), paymasterPostOpGasLimit: hex(PAYMASTER_GAS.postOpGasLimit),
  };
  const q = { validUntil: 1_790_000_180, validAfter: 1_789_999_970, rate: BigInt(3000) * E18, maxTokenCost: amt };
  const sig = `0x${"cd".repeat(64)}1c` as Hex;
  const pmd = concat([ADDR!, pad(op.paymasterVerificationGasLimit!, { size: 16 }), pad(op.paymasterPostOpGasLimit!, { size: 16 }), encodePaymasterData(q, sig)]);
  const p16 = (x: Hex) => pad(x, { size: 16 });
  const packed = {
    sender: op.sender, nonce: BigInt(op.nonce), initCode: concat([op.factory!, op.factoryData!]), callData: op.callData,
    accountGasLimits: concat([p16(op.verificationGasLimit!), p16(op.callGasLimit!)]), preVerificationGas: BigInt(op.preVerificationGas!),
    gasFees: concat([p16(op.maxPriorityFeePerGas!), p16(op.maxFeePerGas!)]), paymasterAndData: pmd, signature: "0x" as Hex,
  };
  void packed;
  const onchain = await pc.readContract({ address: ADDR!, abi, functionName: "getHash", args: [op.sender, q.validUntil, q.validAfter, q.rate, q.maxTokenCost] });
  assert.equal(onchain, paymasterQuoteHash(op, q, chainId, ADDR!));
  const parsed = await pc.readContract({ address: ADDR!, abi, functionName: "parsePaymasterAndData", args: [pmd] });
  assert.deepEqual([Number(parsed[0]), Number(parsed[1]), parsed[2], parsed[3], parsed[4]], [q.validUntil, q.validAfter, q.rate, q.maxTokenCost, sig]);
  assert.equal(await pc.readContract({ address: ADDR!, abi, functionName: "firstCallApproves", args: [op.callData, amt] }), true);
  assert.equal(firstCallApproveAmount(op.callData, PUSDG!, ADDR!), amt);
  for (const w of [BigInt(1), BigInt(999_999_999_999), BigInt(3) * E18]) assert.equal(await pc.readContract({ address: ADDR!, abi, functionName: "tokenCost", args: [w, q.rate] }), tokenCost(w, q.rate));
  void toHex;
});

test("signed paymaster gas limits fit under the relay caps", () => {
  assert.ok(PAYMASTER_GAS.verificationGasLimit <= GAS_CAPS.paymasterVerificationGasLimit);
  assert.ok(PAYMASTER_GAS.postOpGasLimit <= GAS_CAPS.paymasterPostOpGasLimit);
});

test("client payGasInUsdg: stub → exact approve first → final, against the real quote rules (mocked fetch)", async () => {
  const { payGasInUsdg, withPaymasterApprove } = await import("../lib/aa/paymasterClient");
  const dec = 18, RATE = BigInt(3000) * E18;
  const signer = privateKeyToAccount(generatePrivateKey());
  const cfg: QuoteConfig = { paymaster: PM, usdg: USDG, usdgDecimals: dec, rate: RATE };
  const d: QuoteDeps = {
    now: () => 1_790_000_000, debtOf: async () => BigInt(7), balanceOf: async () => E18 * BigInt(100),
    bounds: async () => ({ minRate: BigInt(1), maxRate: RATE * BigInt(10), maxCostCap: E18 * BigInt(5) }),
    baseFee: async () => BASE, sign: (h) => signer.signMessage({ message: { raw: h } }),
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init: { body: string }) => {
    const b = JSON.parse(init.body);
    try {
      const result = b.method === "pm_getPaymasterStubData" ? await stubQuote(b.params[0], b.params[1], b.params[2], cfg, d) : await finalQuote(b.params[0], b.params[1], b.params[2], cfg, d);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }, (_k, v) => (typeof v === "bigint" ? `0x${v.toString(16)}` : v)));
    } catch (e) { return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: (e as Error).message, data: (e as PaymasterQuoteError).data } })); }
  }) as typeof fetch;
  try {
    const fees = clientFees(BASE);
    const staleApprove = paymasterApproveCall(USDG, PM, BigInt(1));
    assert.equal(withPaymasterApprove([trade, staleApprove], USDG, PM, BigInt(9)).length, 2);
    const { op, maxTokenCost } = await payGasInUsdg({
      url: "http://x/api/paymaster", chainId: 46630, usdg: USDG, paymaster: PM, calls: [trade, staleApprove],
      build: async (calls, pm) => ({
        sender: SENDER, nonce: "0x9", callData: batch(calls.map((c) => ({ to: c.to, data: c.data })), true), signature: "0x",
        callGasLimit: hex(STATIC_GAS.callGasLimit), verificationGasLimit: hex(STATIC_GAS.verificationGasLimit), preVerificationGas: hex(STATIC_GAS.preVerificationGas),
        maxFeePerGas: hex(fees.maxFeePerGas), maxPriorityFeePerGas: hex(fees.maxPriorityFeePerGas), ...pm,
      }),
      sign: async () => "0x1234",
    });
    assert.equal(firstCallApproveAmount(op.callData, USDG, PM), maxTokenCost);
    assert.equal(maxTokenCost, tokenCost(entryPointMaxCost(op), RATE) + BigInt(7));
    assert.equal(decodePaymasterData(op.paymasterData!).maxTokenCost, maxTokenCost);
    assert.equal(op.signature, "0x1234");
  } finally { globalThis.fetch = realFetch; }
});

test("relay deposit check covers an 11M-gas launch op; keeper band fits N concurrent launches", async () => {
  const fees = clientFees(BASE);
  const op = { callGasLimit: hex(LAUNCH_GAS_CAPS.callGasLimit), verificationGasLimit: hex(700_000), preVerificationGas: hex(100_000), maxFeePerGas: hex(fees.maxFeePerGas), maxPriorityFeePerGas: hex(fees.maxPriorityFeePerGas), paymaster: PM, paymasterVerificationGasLimit: hex(120_000), paymasterPostOpGasLimit: hex(80_000) };
  const need = maxPrefund(op, relayerPrice(BASE));
  // client-visible message is plain; the internal reason is in `detail` (logged server-side)
  assert.throws(() => checkPaymaster(op, PM, need - BigInt(1), BASE),
    (e: unknown) => e instanceof RelayPolicyError && e.message === TRADING_UNAVAILABLE && /deposit too low/.test(e.detail ?? ""));
  checkPaymaster(op, PM, need, BASE);
  const { launchPrefund, depositBand } = await import("./paymaster-keeper.mts");
  const per = launchPrefund(BASE);
  assert.equal(per, LAUNCH_GAS_CAPS.total * fees.maxFeePerGas);   // 11M × 0.03165 gwei ≈ 0.000348 ETH
  assert.ok(per >= need);
  const e = (x: number) => BigInt(Math.round(x * 1e6)) * BigInt(10) ** BigInt(12);
  assert.deepEqual(depositBand(BASE, BigInt(20), e(0.05), e(0.2)), { min: e(0.05), target: e(0.2) });   // 20 launches ≈ 0.007 ETH < min
  const hot = depositBand(BASE * BigInt(10), BigInt(20), e(0.05), e(0.2));                               // 10x base fee
  assert.equal(hot.min, BigInt(20) * launchPrefund(BASE * BigInt(10)));
  assert.ok(hot.min > e(0.05) && hot.target === e(0.2));
});

test("keeper topUpAmount: none above min; fills to target; never dips into the keeper's gas reserve", async () => {
  const { topUpAmount } = await import("./paymaster-keeper.mts");
  const e = (x: number) => BigInt(Math.round(x * 1e6)) * BigInt(10) ** BigInt(12);
  assert.equal(topUpAmount(e(0.05), e(10), e(0.05), e(0.2), e(0.01)), BigInt(0));
  assert.equal(topUpAmount(e(0.01), e(10), e(0.05), e(0.2), e(0.01)), e(0.19));
  assert.equal(topUpAmount(e(0.01), e(0.03), e(0.05), e(0.2), e(0.01)), e(0.02));
  assert.equal(topUpAmount(e(0.01), e(0.005), e(0.05), e(0.2), e(0.01)), BigInt(0));
});

test("user-facing copy never mentions gas / ETH / paymaster / bundler / sponsorship (Lee's rule)", () => {
  for (const m of [TRADING_UNAVAILABLE, NOT_ENOUGH_USDG]) assert.equal(INFRA_WORDING.test(m), false, m);
  for (const m of ["paymaster deposit too low: 1 < 2 wei", "callGasLimit 9 above cap 3", "gas sponsorship is disabled", "AA33 reverted", "not enough USDG for gas", "self-pay in ETH", "bundler response unreadable"])
    assert.equal(INFRA_WORDING.test(m), true, m);
  assert.equal(INFRA_WORDING.test("Price moved too much. Try again or raise slippage."), false);
  // the relay's paymaster rejection (wrong paymaster / low deposit) is plain copy for the client
  const PM2 = "0x2222222222222222222222222222222222222222";
  assert.throws(() => checkPaymaster({ paymaster: PM2 } as never, PM, BigInt(0), BASE), (e: unknown) => e instanceof RelayPolicyError && e.message === TRADING_UNAVAILABLE && /not accepted/.test(e.detail ?? ""));
});

