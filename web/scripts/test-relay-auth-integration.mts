// Actual fastRelay warm/send entrypoints with all RPC/sends intercepted. No live transactions/credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeAbiParameters, keccak256, pad, parseAbi, parseAbiParameters, type Hex } from "viem";
import { ACCOUNT_PROXY_RUNTIME } from "../lib/server/relayAuth";
import { ENTRYPOINT_V07, MAV2_FACTORY } from "../lib/aa/constants";
import { STATIC_GAS } from "../lib/aa/fastPath";
import { clientFees } from "../lib/aa/gasPolicy";
import type { UserOp } from "../lib/aa/core";
const abi = parseAbi([
  "struct P { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function handleOps(P[] ops, address beneficiary)",
]);
test("warm + actual send: forged/sig/nonce/funding/implementation failures never charge or broadcast; valid op passes", async () => {
  const savedEnv = { ...process.env }, savedFetch = globalThis.fetch;
  const sender = `0x${"11".repeat(20)}` as Hex, impl = `0x${"22".repeat(20)}` as Hex;
  const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}` as Hex, fees = clientFees(BigInt(10_000_000));
  const op: UserOp = { sender, nonce: "0x10000000000000000", callData: "0xdeadbeef", signature: "0x01",
    callGasLimit: hex(STATIC_GAS.callGasLimit), verificationGasLimit: hex(STATIC_GAS.verificationGasLimit),
    preVerificationGas: hex(STATIC_GAS.preVerificationGas), maxFeePerGas: hex(fees.maxFeePerGas), maxPriorityFeePerGas: hex(fees.maxPriorityFeePerGas) };
  let invalid = "", broadcasts = 0, charged = 0, simulations = 0;
  function answer(method: string, params: unknown[]): unknown {
    if (method === "eth_getBalance") return "0x8ac7230489e80000";
    if (method === "eth_getTransactionCount") return "0x0";
    if (method === "eth_chainId") return "0xb626";
    if (method === "eth_getBlockByNumber") return { number: "0x1", timestamp: "0x1", baseFeePerGas: "0x989680", gasLimit: "0x1c9c380" };
    if (method === "eth_getCode") return `${ACCOUNT_PROXY_RUNTIME}${"33".repeat(20)}`;
    if (method === "eth_getStorageAt") return pad(invalid === "wrong implementation" ? `0x${"44".repeat(20)}` as Hex : impl, { size: 32 });
    if (method === "eth_call") {
      const tx = params[0] as { to: Hex; data: Hex };
      if (tx.to.toLowerCase() === MAV2_FACTORY.toLowerCase()) return pad(impl, { size: 32 });
      if (tx.to.toLowerCase() === ENTRYPOINT_V07.toLowerCase()) {
        simulations++;
        const decoded = decodeFunctionData({ abi, data: tx.data });
        assert.equal(decoded.args[0][0].sender.toLowerCase(), sender.toLowerCase());
        assert.equal(decoded.args[0][0].signature, op.signature, "simulate exact signature, not just userOpHash");
        if (invalid && invalid !== "wrong implementation") throw new Error(invalid);
        return "0x";
      }
      return encodeAbiParameters(parseAbiParameters("uint64,uint256,uint256"), [BigInt(0), BigInt(1), BigInt(1)]);
    }
    if (method === "eth_sendRawTransactionSync") {
      broadcasts++;
      return { transactionHash: keccak256(params[0] as Hex), blockHash: `0x${"ab".repeat(32)}`, blockNumber: "0x1", status: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", logs: [] };
    }
    throw new Error(`unexpected RPC ${method}`);
  }
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const one = (b: { id: unknown; method: string; params: unknown[] }) => {
      try { return { jsonrpc: "2.0", id: b.id, result: answer(b.method, b.params ?? []) }; }
      catch (e) { return { jsonrpc: "2.0", id: b.id, error: { code: 3, message: (e as Error).message, data: "0xdeadbeef" } }; }
    };
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    // Only this isolated test subprocess's config; no env files/deployment settings or actual key changed.
    for (const k of ["VERCEL", "VERCEL_ENV", "RELAYER_ENV", "RELAYER_KEY_POOL", "RHT_SEQUENCER_URL", "RHT_RECEIPT_RPC_URL", "KV_REST_API_URL", "UPSTASH_REDIS_REST_URL"]) delete process.env[k];
    Object.assign(process.env, { NODE_ENV: "test", RELAYER_NONCE_SHARED: "0", RELAYER_PRIVATE_KEY: `0x${"0".repeat(63)}1`, KV_LOCAL_FILE: `/tmp/f02-relay-${process.pid}.json` });
    const relay = await import("../lib/server/fastRelay");
    await relay.warmRelay(sender);
    assert.equal(relay.trusted(op), false, "balance + global-owner nonce must never bypass auth");
    for (invalid of ["forged op", "wrong signature", "wrong nonce", "unfunded account", "wrong implementation"]) {
      const before = simulations;
      await assert.rejects(relay.sendUserOperationSync(op, undefined, async () => { charged++; }), /simulation failed/);
      assert.equal(simulations, before + 1); assert.equal(broadcasts, 0); assert.equal(charged, 0);
    }
    invalid = "";
    const result = await relay.sendUserOperationSync(op, undefined, async () => { charged++; });
    assert.equal(result.kind, "confirmed"); assert.equal(broadcasts, 1); assert.equal(charged, 1);
  } finally { process.env = savedEnv; globalThis.fetch = savedFetch; }
});
