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
import { createPublicClient, decodeEventLog, decodeFunctionData, encodeFunctionData, http, parseAbi, parseAbiItem, type Hex, type TransactionReceipt } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { robinhoodTestnet } from "../chains";
import { userOpHash, type UserOp } from "../aa/core";
import { ENTRYPOINT_V07 } from "../aa/constants";
import { isNonceError, relayerKey } from "./relayer";
import { checkOpGas, maxPrefund, relayerPrice, relayerTxFees, totalGas } from "../aa/gasPolicy";
import { TRADE_SELECTORS, TRY_ATTRIBUTE } from "../aa/oneTap";
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

function account() {
  const key = relayerKey();
  if (!key) throw new Error("self-bundler not configured");
  return (relayer ??= privateKeyToAccount(key));
}
async function syncNonce(): Promise<number> {
  return (nonceSync ??= pc.getTransactionCount({ address: account().address, blockTag: "pending" }).then((n) => { nextNonce = n; return n; }).finally(() => { nonceSync = undefined; }));
}
/** Synchronous after warm-up: concurrent ops get consecutive nonces with no RPC. */
async function takeNonce(): Promise<number> { if (nextNonce === undefined) await syncNonce(); return nextNonce!++; }
/**
 * The SAME cursor for every send from the relayer EOA in this process (the standard eth_sendUserOperation path, the
 * fast path, and /api/drip while the faucet and relayer are one key — see relayerIsFaucet) — otherwise a drip leaves the cursor stale and the next fast op pays a nonce error + resync
 * (~180 ms, seen on the first trade after "Get test funds").
 */
export async function sendWithRelayerNonce<T>(send: (nonce: number) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const nonce = await takeNonce();
    try { return await send(nonce); }
    catch (e) { if (attempt < 2 && isNonceError(e)) { nextNonce = undefined; await syncNonce(); continue; } throw e; }
  }
}
function refreshBase() {
  return (baseInflight ??= pc.getBlock().then((b) => { base = { fee: b.baseFeePerGas ?? BigInt(0), at: Date.now() }; }).finally(() => { baseInflight = undefined; }));
}
async function baseFee(): Promise<bigint> { if (!base.at) await refreshBase(); else if (Date.now() - base.at > 2000) void refreshBase().catch(() => undefined); return base.fee; }

/**
 * Anti-grief (who pays, EntryPoint v0.7): if an op's EXECUTION reverts, handleOps still succeeds and the ACCOUNT pays
 * actualGasCost to the beneficiary (= relayer) — the relayer is reimbursed. If VALIDATION fails (bad sig, no prefund,
 * bad nonce, …) handleOps reverts with FailedOp and the RELAYER eats the whole tx. Fast path (no eth_call) is only for
 * senders whose cached balance (primed by disciple_warm at login/coin load, ≤60 s old) covers the op's max prefund and
 * that have no recent strike; anyone else gets ONE eth_call simulation first. A FailedOp revert = 10 min strike.
 */
type Trust = { bal: bigint; at: number; strikeUntil: number };
const TRUST = new Map<string, Trust>();
const TRUST_TTL = 60_000, STRIKE_MS = 10 * 60_000;
async function primeSender(sender: string) {
  const k = sender.toLowerCase(), prev = TRUST.get(k);
  const bal = await pc.getBalance({ address: sender as Hex });
  TRUST.set(k, { bal, at: Date.now(), strikeUntil: prev?.strikeUntil ?? 0 });
}
export const primeSenderNow = (sender: string) => primeSender(sender);
const execAbi = parseAbi(["function execute(address target, uint256 value, bytes data)", "function executeBatch((address target, uint256 value, bytes data)[] calls)"]);
/**
 * Local (no-RPC) pre-check for SESSION-key ops (non-global validation in the MAv2 nonce key): the policy rejects
 * non-trade calls in VALIDATION (AA23 → handleOps reverts → relayer pays; seen: STRATEGY.transfer, tx 0x9c29662a…),
 * so any inner call outside the trade allowlist (or carrying ETH) is simulated first instead of fast-pathed.
 */
export function sessionOpLooksAllowed(op: UserOp): boolean {
  const key = BigInt(op.nonce) >> BigInt(64);
  if ((key & BigInt(1)) === BigInt(1)) return true;  // global validation = owner: no policy hook
  let cd = op.callData as Hex;
  if (cd.slice(0, 10).toLowerCase() === "0x8dd7712f") cd = `0x${cd.slice(10)}` as Hex;  // executeUserOp prefix (raw concat)
  try {
    const d = decodeFunctionData({ abi: execAbi, data: cd });
    const calls = d.functionName === "execute" ? [{ value: d.args[1], data: d.args[2] }] : (d.args[0] as readonly { value: bigint; data: Hex }[]);
    return calls.every((c) => c.value === BigInt(0) && (TRADE_SELECTORS.has(c.data.slice(0, 10).toLowerCase()) || c.data.slice(0, 10).toLowerCase() === TRY_ATTRIBUTE));
  } catch { return false; }
}
/** true ⇒ safe to skip simulation */
export function trusted(op: UserOp): boolean {
  if (op.factory) return false; // first op (deploy) always simulated
  if (!sessionOpLooksAllowed(op)) return false;
  const t = TRUST.get(op.sender.toLowerCase());
  return !!t && Date.now() < t.at + TRUST_TTL && Date.now() >= t.strikeUntil && t.bal >= maxPrefund(op, relayerPrice(base.fee));   // priced at >= the relayer floor: a fee-0 op never looks covered
}

/** Warm the relay (nonce + base fee + TLS connection) and, if given, the sender's trust entry. */
export async function warmRelay(sender?: string) {
  await Promise.all([nextNonce === undefined ? syncNonce() : 0, baseFee(), sender ? primeSender(sender).catch(() => undefined) : 0]);
}

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
  // W-1: reject ops that would make the relayer pay (fee below 2x base + tip, or gas above the caps) before anything else
  const fee = await baseFee();
  checkOpGas(op, fee);
  const data = encodeFunctionData({ abi: epAbi, functionName: "handleOps", args: [[packUserOp(op)], me.address] });
  if (process.env.FAST_RELAY_SIM === "1" || !trusted(op)) {
    const s = Date.now();
    await pc.call({ account: me.address, to: ENTRYPOINT_V07, data }).catch((e) => { throw new Error(`simulation failed: ${(e as Error).message.split("\n")[0]}`); });
    t.simulate = Date.now() - s; void primeSender(op.sender).catch(() => undefined);
  } else t.simulate = 0;
  const gas = totalGas(op) + BigInt(120_000);
  const txFees = relayerTxFees(op, fee);   // never above the op's fees ⇒ the EntryPoint refund covers the relayer's cost per gas
  for (let attempt = 0; ; attempt++) {
    const s = Date.now();
    const nonce = await takeNonce();
    const raw = await me.signTransaction({ chainId: robinhoodTestnet.id, type: "eip1559", nonce, to: ENTRYPOINT_V07, data, gas, ...txFees });
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
      const tr = TRUST.get(op.sender.toLowerCase());
      if (r.rc.status !== "0x1") { if (tr) tr.strikeUntil = Date.now() + STRIKE_MS; else TRUST.set(op.sender.toLowerCase(), { bal: BigInt(0), at: 0, strikeUntil: Date.now() + STRIKE_MS }); }
      else if (tr) { tr.bal -= maxPrefund(op, relayerPrice(base.fee)); void primeSender(op.sender).catch(() => undefined); } // conservative until refresh
      if (r.rc.status !== "0x1") throw new Error(`relayer tx ${r.rc.transactionHash} reverted (handleOps: validation failed?)`);
      return { userOpHash: hash, txHash: r.rc.transactionHash, success, logs: r.rc.logs, t: { ...t, mode: r.mode === "sync" ? 1 : 0 } };
    } catch (e) {
      if (attempt < 2 && isNonceError(e)) { nextNonce = undefined; await syncNonce(); continue; }
      throw e;
    }
  }
}
