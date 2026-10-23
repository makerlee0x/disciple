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
  paymasterApproveCall, paymasterQuoteHash, requiredMaxTokenCost, stubPaymasterData, tokenCost,
} from "../lib/aa/paymaster";
import { DEFAULT_MAX_SLACK_BPS, finalQuote, PaymasterQuoteError, rateFromEnv, stubQuote, type QuoteConfig, type QuoteDeps } from "../lib/server/paymasterCore";
import { clientFees, GAS_CAPS } from "../lib/aa/gasPolicy";
import { STATIC_GAS } from "../lib/aa/fastPath";
import { ENTRYPOINT_V07 } from "../lib/aa/constants";
import type { UserOp } from "../lib/aa/core";

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

// ── optional on-chain parity (local anvil only) ──
const RPC = process.env.PAYMASTER_PARITY_RPC, ADDR = process.env.PAYMASTER_PARITY_ADDR as Address | undefined, PUSDG = process.env.PAYMASTER_PARITY_USDG as Address | undefined;
test("parity with DisciplePaymaster.sol (getHash, parse, firstCallApproves, tokenCost)", { skip: !(RPC && ADDR && PUSDG) && "set PAYMASTER_PARITY_RPC/ADDR/USDG" }, async () => {
  const pc = createPublicClient({ transport: http(RPC) });
  const chainId = await pc.getChainId();
  const abi = parseAbi([
    "struct P { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
    "function getHash(P op, uint48 validUntil, uint48 validAfter, uint256 rate, uint256 maxTokenCost) view returns (bytes32)",
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
  const onchain = await pc.readContract({ address: ADDR!, abi, functionName: "getHash", args: [packed, q.validUntil, q.validAfter, q.rate, q.maxTokenCost] });
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
