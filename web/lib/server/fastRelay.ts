import "server-only";
/**
 * disciple_sendUserOperationSync — the one-round-trip trade path (self-bundler only).
 * Client sends a fully built + signed v0.7 UserOp; we relay handleOps IMMEDIATELY and answer with the receipt:
 *  - warm module state: relayer account, keep-alive RPC client, cached base fee (background refresh)
 *  - pre-tracked relayer nonce (local cursor, resynced on nonce errors) ⇒ no getTransactionCount per op
 *  - gas = the op's own limits + overhead ⇒ no estimateGas; NO per-op simulation (the client estimated this preset
 *    once; a failed validation only costs the relayer one reverted tx on testnet). FAST_RELAY_SIM=1 adds an eth_call.
 *  - eth_sendRawTransactionSync (EIP-7966, supported by the RH RPC) returns the receipt with the send; fallback:
 *    sendRawTransaction + 50 ms receipt polling.
 * Ops from different users/keys run concurrently: only nonce assignment is serialized (synchronous).
 */
import { createPublicClient, decodeEventLog, encodeFunctionData, http, parseAbi, parseAbiItem, type Hex, type TransactionReceipt } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { robinhoodTestnet } from "../chains";
import { userOpHash, type UserOp } from "../aa/core";
import { ENTRYPOINT_V07 } from "../aa/constants";
import { isNonceError } from "./relayer";
import { packUserOp } from "./selfBundler";

const epAbi = parseAbi([
  "struct P { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function handleOps(P[] ops, address beneficiary)",
]);
const uoEvent = parseAbiItem("event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)");
const pc = createPublicClient({ chain: robinhoodTestnet, transport: http(undefined, { fetchOptions: { keepalive: true } }) });

let relayer: PrivateKeyAccount | undefined;
let nextNonce: number | undefined, nonceSync: Promise<number> | undefined;
let base = { fee: BigInt(0), at: 0 }, baseInflight: Promise<void> | undefined;
let syncSupported: boolean | undefined;
const PRIORITY = BigInt(1_000_000); // 0.001 gwei floor (RH testnet)

function account() {
  const key = process.env.DRIP_FAUCET_KEY as Hex | undefined;
  if (!key) throw new Error("self-bundler not configured");
  return (relayer ??= privateKeyToAccount(key));
}
async function syncNonce(): Promise<number> {
  return (nonceSync ??= pc.getTransactionCount({ address: account().address, blockTag: "pending" }).then((n) => { nextNonce = n; return n; }).finally(() => { nonceSync = undefined; }));
}
/** Synchronous after warm-up: concurrent ops get consecutive nonces with no RPC. */
async function takeNonce(): Promise<number> { if (nextNonce === undefined) await syncNonce(); return nextNonce!++; }
function refreshBase() {
  return (baseInflight ??= pc.getBlock().then((b) => { base = { fee: b.baseFeePerGas ?? BigInt(0), at: Date.now() }; }).finally(() => { baseInflight = undefined; }));
}
async function baseFee(): Promise<bigint> { if (!base.at) await refreshBase(); else if (Date.now() - base.at > 2000) void refreshBase().catch(() => undefined); return base.fee; }

/** Warm the relay (nonce + base fee + TLS connection) — called on /api/bundler boot and by the client's warm(). */
export async function warmRelay() { await Promise.all([nextNonce === undefined ? syncNonce() : 0, baseFee()]); }

type RpcReceipt = { status: Hex; transactionHash: Hex; logs: { address: Hex; data: Hex; topics: Hex[] }[] };
async function sendSync(raw: Hex): Promise<{ rc: RpcReceipt; mode: "sync" | "poll"; sendMs: number; minedMs: number }> {
  const t0 = Date.now();
  if (syncSupported !== false) {
    try {
      const rc = await pc.request({ method: "eth_sendRawTransactionSync" as never, params: [raw] as never }) as unknown as RpcReceipt;
      syncSupported = true; return { rc, mode: "sync", sendMs: Date.now() - t0, minedMs: 0 };
    } catch (e) {
      if (!/method not found|not supported|does not exist|-32601/i.test(String((e as Error).message))) throw e;
      syncSupported = false;
    }
  }
  const hash = await pc.sendRawTransaction({ serializedTransaction: raw });
  const t1 = Date.now();
  for (;;) {
    const rc = await pc.getTransactionReceipt({ hash }).catch(() => null) as TransactionReceipt | null;
    if (rc) return { rc: { status: rc.status === "success" ? "0x1" : "0x0", transactionHash: rc.transactionHash, logs: rc.logs as never }, mode: "poll", sendMs: t1 - t0, minedMs: Date.now() - t1 };
    if (Date.now() - t1 > 20_000) throw new Error(`relayer tx ${hash} not confirmed (timeout)`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function sendUserOperationSync(op: UserOp) {
  const T0 = Date.now(), t: Record<string, number> = {};
  const me = account();
  const data = encodeFunctionData({ abi: epAbi, functionName: "handleOps", args: [[packUserOp(op)], me.address] });
  if (process.env.FAST_RELAY_SIM === "1") { const s = Date.now(); await pc.call({ account: me.address, to: ENTRYPOINT_V07, data }); t.simulate = Date.now() - s; }
  const gas = BigInt(op.verificationGasLimit || "0x0") + BigInt(op.callGasLimit || "0x0") + BigInt(op.preVerificationGas || "0x0") + BigInt(120_000);
  const fee = await baseFee();
  for (let attempt = 0; ; attempt++) {
    const s = Date.now();
    const nonce = await takeNonce();
    const raw = await me.signTransaction({ chainId: robinhoodTestnet.id, type: "eip1559", nonce, to: ENTRYPOINT_V07, data, gas, maxFeePerGas: fee * BigInt(2) + PRIORITY, maxPriorityFeePerGas: PRIORITY });
    t.signTx = Date.now() - s;
    try {
      const r = await sendSync(raw);
      t.send = r.sendMs; t.mined = r.minedMs; t.total = Date.now() - T0;
      const hash = userOpHash(op, robinhoodTestnet.id);
      let success = false;
      for (const l of r.rc.logs) {
        if (l.address.toLowerCase() !== ENTRYPOINT_V07.toLowerCase()) continue;
        try { const ev = decodeEventLog({ abi: [uoEvent], data: l.data, topics: l.topics as [Hex, ...Hex[]] }); if ((ev.args as { userOpHash: Hex }).userOpHash === hash) success = (ev.args as { success: boolean }).success; } catch { /* other event */ }
      }
      if (r.rc.status !== "0x1") throw new Error(`relayer tx ${r.rc.transactionHash} reverted (handleOps: validation failed?)`);
      return { userOpHash: hash, txHash: r.rc.transactionHash, success, logs: r.rc.logs, t: { ...t, mode: r.mode === "sync" ? 1 : 0 } };
    } catch (e) {
      if (attempt < 2 && isNonceError(e)) { nextNonce = undefined; await syncNonce(); continue; }
      throw e;
    }
  }
}
