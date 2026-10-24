import "server-only";
/**
 * disciple_sendUserOperationSync — the one-round-trip trade path (self-bundler only).
 * Client sends a fully built + signed v0.7 UserOp; we relay handleOps IMMEDIATELY and answer with the receipt:
 *  - warm module state: relayer account, keep-alive RPC client, cached base fee (background refresh)
 *  - pre-tracked relayer nonce (local cursor, resynced on nonce errors) ⇒ no getTransactionCount per op
 *  - gas = the op's own limits + overhead ⇒ no estimateGas; no per-op simulation for verified senders (relayTrust:
 *    re-simulated every RESIM_EVERY ops / RESIM_MS, escalating strikes on reverts). FAST_RELAY_SIM=1 always simulates.
 *  - eth_sendRawTransactionSync (EIP-7966) returns the FULL receipt with the send (lib/server/syncSend: sequencer
 *    endpoint when RHT_SEQUENCER_URL is set, public RPC otherwise / as fallback). Timeout or error after signing ⇒
 *    onPending({ txHash }) and the server waits for the receipt (the client never polls; see lib/aa/relayTypes).
 * Ops from different users/keys run concurrently: only nonce assignment is serialized (synchronous).
 */
import { createPublicClient, decodeEventLog, decodeFunctionData, encodeFunctionData, http, keccak256, parseAbi, parseAbiItem, type Hex, type TransactionReceipt } from "viem";
import type { RelayConfirmed, RelayReceipt } from "../aa/relayTypes";
import { isNonceErr, jsonRpc, syncSend, type PendingReason, type RpcErr } from "./syncSend";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { robinhoodTestnet } from "../chains";
import { userOpHash, type UserOp } from "../aa/core";
import { ENTRYPOINT_V07 } from "../aa/constants";
import { isNonceError, relayerKey } from "./relayer";
import { checkOpGas, maxPrefund, relayerPrice, relayerTxFees, totalGas } from "../aa/gasPolicy";
import { launchTargets } from "../aa/launchTargets";
import { chainGradReads, relayCaps } from "./gradBuy";
import { checkPaymaster, RelayPolicyError } from "../aa/gasPolicy";
import { allowedPaymaster, debitPaymasterDeposit, paymasterDepositCached } from "./paymasterDeposit";
import { TRADE_SELECTORS, TRY_ATTRIBUTE } from "../aa/oneTap";
import { packUserOp } from "./selfBundler";
import { SenderTrust } from "./relayTrust";
import { kvTrustStore } from "./relayTrustStore";

const epAbi = parseAbi([
  "struct P { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function handleOps(P[] ops, address beneficiary)",
]);
const uoEvent = parseAbiItem("event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)");
const pc = createPublicClient({ chain: robinhoodTestnet, transport: http(undefined, { fetchOptions: { keepalive: true } }) });

let relayer: PrivateKeyAccount | undefined;
let nextNonce: number | undefined, nonceSync: Promise<number> | undefined;
let base = { fee: BigInt(0), at: 0 }, baseInflight: Promise<void> | undefined;

function account() {
  return (relayer ??= privateKeyToAccount(relayerKey())); // production: RelayerNotConfiguredError (→ 503), never the faucet key
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
 * Anti-grief: see lib/server/relayTrust (fast path only for verified senders with a fresh balance covering the max
 * prefund; periodic re-simulation every RESIM_EVERY ops / RESIM_MS; reverted handleOps ⇒ escalating strike, then a
 * passing simulation is required before the fast path returns).
 */
const TRUST = new SenderTrust(Date.now, kvTrustStore());   // AUDIT Low: strikes / verification shared + durable (KV)
async function primeSender(sender: string) {
  await TRUST.primeShared(sender, await pc.getBalance({ address: sender as Hex }));
}
/** Await the trust ledger's pending KV writes (the bundler route calls this before responding). */
export const flushRelayTrust = () => TRUST.flush();
/** After a simulated + successful send (eth_sendUserOperation path): mark verified, refresh the balance. */
export const primeSenderNow = async (sender: string, opts: { simulated?: boolean } = {}) => {
  if (opts.simulated) TRUST.simulated(sender);
  await primeSender(sender);
};
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
  return TRUST.check(op.sender, senderPrefund(op)) === null;   // priced at >= the relayer floor: a fee-0 op never looks covered
}
/**
 * What the SENDER's ETH must cover: the max prefund for self-pay ops; 0 for paymaster ops (DisciplePaymaster's deposit
 * pays, checked by checkPaymaster before trust; the user's USDG balance/allowance is checked by the paymaster's
 * validation, and a failure there is a relayer-paid revert ⇒ strike, like any other).
 */
const senderPrefund = (op: UserOp) => (op.paymaster ? BigInt(0) : maxPrefund(op, relayerPrice(base.fee)));

/** Warm the relay (nonce + base fee + TLS connection) and, if given, the sender's trust entry. */
export async function warmRelay(sender?: string) {
  account(); // fail closed (production, no dedicated relayer key) before any RPC
  warmSequencer();
  await Promise.all([nextNonce === undefined ? syncNonce() : 0, baseFee(), sender ? primeSender(sender).catch(() => undefined) : 0]);
}

/**
 * Item 1 (feat/trade-latency): RHT_SEQUENCER_URL (server env, e.g. https://sequencer.testnet.chain.robinhood.com,
 * send-only) ⇒ eth_sendRawTransactionSync [raw] goes there (live: full receipt in ~161 ms warm; the public RPC sees
 * the tx 0.64–0.75 s later). Unset ⇒ the public RPC exactly as before. RHT_RECEIPT_RPC_URL (optional fast node)
 * serves the slow-path receipt wait before the public RPC. Rules: lib/server/syncSend.
 */
const RPC_URL = robinhoodTestnet.rpcUrls.default.http[0];
const SEQ_URL = /^https?:\/\//.test(process.env.RHT_SEQUENCER_URL || "") ? process.env.RHT_SEQUENCER_URL! : undefined;
const SEND = SEQ_URL ? { name: "sequencer" as const, rpc: jsonRpc(SEQ_URL) } : { name: "rpc" as const, rpc: jsonRpc(RPC_URL) };
const FAST_READ = /^https?:\/\//.test(process.env.RHT_RECEIPT_RPC_URL || "") ? jsonRpc(process.env.RHT_RECEIPT_RPC_URL!, 3_000) : undefined;
let seqWarmAt = 0;
/** Keep the TLS connection to the sequencer warm (cold TLS = +260–660 ms). Any request works; the answer is ignored. */
export function warmSequencer() {
  if (!SEQ_URL || Date.now() - seqWarmAt < 20_000) return;
  seqWarmAt = Date.now();
  void SEND.rpc("web3_clientVersion", []).catch(() => undefined);
}
const hx = (v: bigint | number | undefined) => (v === undefined ? undefined : (`0x${BigInt(v).toString(16)}` as Hex));
async function receiptOf(hash: Hex): Promise<RelayReceipt | null> {
  if (FAST_READ) { const r = await FAST_READ("eth_getTransactionReceipt", [hash]).catch(() => null) as RelayReceipt | null; if (r) return r; }
  const rc = await pc.getTransactionReceipt({ hash }).catch(() => null) as TransactionReceipt | null;
  if (!rc) return null;
  return {
    transactionHash: rc.transactionHash, blockHash: rc.blockHash, blockNumber: hx(rc.blockNumber)!, status: rc.status === "success" ? "0x1" : "0x0",
    gasUsed: hx(rc.gasUsed)!, effectiveGasPrice: hx(rc.effectiveGasPrice),
    logs: rc.logs.map((l) => ({ address: l.address, topics: l.topics as Hex[], data: l.data, logIndex: hx(l.logIndex ?? undefined), blockNumber: hx(l.blockNumber ?? undefined), transactionHash: l.transactionHash ?? undefined })),
  };
}
async function sendSync(raw: Hex, onPending?: OnPending) {
  warmSequencer();
  return syncSend(raw, keccak256(raw), { send: SEND, getReceipt: receiptOf, onPending });
}
export type OnPending = (p: { txHash: Hex; reason: PendingReason; relayNonce?: number }) => void;

export async function sendUserOperationSync(op: UserOp, onPending?: OnPending): Promise<RelayConfirmed> {
  const T0 = Date.now(), t: Record<string, number> = {};
  const me = account();
  // W-1: reject ops that would make the relayer pay (fee below 2x base + tip, or gas above the caps) before anything else
  const fee = await baseFee();
  // launches ⇒ LAUNCH_GAS_CAPS; above GAS_CAPS + verified graduating buy ⇒ GRAD_GAS_CAPS (on-chain check, lib/server/gradBuy)
  checkOpGas(op, fee, await relayCaps(op, launchTargets(robinhoodTestnet.id), chainGradReads(pc as never, robinhoodTestnet.id, { paymaster: allowedPaymaster() })));
  // USDG-gas op: the prefund comes from OUR paymaster's deposit (launch ops: up to LAUNCH_GAS_CAPS.total × fee)
  if (op.paymaster) {
    const pm = allowedPaymaster();
    try { checkPaymaster(op, pm, pm ? await paymasterDepositCached(pm) : BigInt(0), fee); }
    catch (e) { if (e instanceof RelayPolicyError) console.warn("[fastRelay] paymaster check:", e.detail ?? e.message); throw e; }
  }
  const data = encodeFunctionData({ abi: epAbi, functionName: "handleOps", args: [[packUserOp(op)], me.address] });
  const hash = userOpHash(op, robinhoodTestnet.id);
  const fast = process.env.FAST_RELAY_SIM !== "1" && trusted(op);
  if (!fast) {
    const s = Date.now();
    await pc.call({ account: me.address, to: ENTRYPOINT_V07, data }).catch((e) => {
      // keep the revert payload (FailedOp / FailedOpWithRevert(inner)) so the client can show the real reason (FLOW 2)
      let rd: string | undefined;
      (e as { walk?: (f: (x: unknown) => boolean) => unknown }).walk?.((x) => { const v = (x as { data?: unknown }).data; if (typeof v === "string" && /^0x[0-9a-fA-F]{8,}$/.test(v)) { rd = v; return true; } return false; });
      throw Object.assign(new Error(`simulation failed: ${(e as Error).message.split("\n")[0]}`), { data: rd, userOpHash: hash });
    });
    t.simulate = Date.now() - s; TRUST.simulated(op.sender); void primeSender(op.sender).catch(() => undefined);
  } else t.simulate = 0;
  const gas = totalGas(op) + BigInt(120_000);
  const txFees = relayerTxFees(op, fee);   // never above the op's fees ⇒ the EntryPoint refund covers the relayer's cost per gas
  for (let attempt = 0; ; attempt++) {
    const s = Date.now();
    const nonce = await takeNonce();
    const raw = await me.signTransaction({ chainId: robinhoodTestnet.id, type: "eip1559", nonce, to: ENTRYPOINT_V07, data, gas, ...txFees });
    t.signTx = Date.now() - s;
    const txHash = keccak256(raw);
    try {
      const r = await sendSync(raw, onPending && ((p) => onPending({ ...p, txHash, relayNonce: nonce })));
      t.send = r.sendMs; t.mined = r.minedMs; t.total = Date.now() - T0;
      if (op.paymaster) debitPaymasterDeposit(op.paymaster, maxPrefund(op, relayerPrice(fee)));
      let success = false;
      for (const l of r.rc.logs) {
        if (l.address.toLowerCase() !== ENTRYPOINT_V07.toLowerCase()) continue;
        try { const ev = decodeEventLog({ abi: [uoEvent], data: l.data, topics: l.topics as [Hex, ...Hex[]] }); if ((ev.args as { userOpHash: Hex }).userOpHash === hash) success = (ev.args as { success: boolean }).success; } catch { /* other event */ }
      }
      if (r.rc.status !== "0x1") TRUST.strike(op.sender);   // escalating backoff; fast path returns only after a passing simulation
      else if (TRUST.get(op.sender)) { TRUST.succeeded(op.sender, fast, senderPrefund(op)); void primeSender(op.sender).catch(() => undefined); } // conservative until refresh
      if (r.rc.status !== "0x1") throw Object.assign(new Error(`relayer tx ${r.rc.transactionHash} reverted (handleOps: validation failed?)`), { txHash: r.rc.transactionHash, userOpHash: hash });
      const receipt = normalizeReceipt(r.rc);
      return { kind: "confirmed", userOpHash: hash, txHash: receipt.transactionHash, success, receipt, logs: receipt.logs, via: r.via, t: { simulate: t.simulate, signTx: t.signTx, send: t.send, mined: t.mined, total: t.total, mode: r.via === "rpc-wait" ? 0 : 1 } };
    } catch (e) {
      if (attempt < 2 && (isNonceError(e) || isNonceErr(e as RpcErr))) { nextNonce = undefined; await syncNonce(); continue; }
      // signed ⇒ txHash + relayer nonce always ride on the error; syncSend's receipt timeout keeps unclear/reason
      throw Object.assign(e as Error, { txHash: (e as RpcErr).txHash ?? txHash, userOpHash: hash, relayNonce: nonce });
    }
  }
}

/** EIP-7966 / RPC receipts → RelayReceipt (hex quantities, logs kept whole). */
function normalizeReceipt(rc: RelayReceipt): RelayReceipt {
  return {
    transactionHash: rc.transactionHash, blockHash: rc.blockHash, blockNumber: rc.blockNumber, status: rc.status, gasUsed: rc.gasUsed,
    ...(rc.effectiveGasPrice ? { effectiveGasPrice: rc.effectiveGasPrice } : {}),
    logs: (rc.logs ?? []).map((l) => ({ address: l.address, topics: l.topics, data: l.data, ...(l.logIndex ? { logIndex: l.logIndex } : {}), ...(l.blockNumber ? { blockNumber: l.blockNumber } : {}), ...(l.transactionHash ? { transactionHash: l.transactionHash } : {}) })),
  };
}
