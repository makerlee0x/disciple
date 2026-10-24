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
 * Relayer nonce rules (feat/rapid-tap): lib/server/relayerNonce — definitive non-nonce rejection ⇒ roll back / resync,
 * nonce rejection (incl. "nonce too high") ⇒ resync + re-sign, "already known" / unclear ⇒ wait on the SAME txHash,
 * never re-sign. Both the fast path and the standard eth_sendUserOperation path (standardRelayer) follow them.
 */
import { createPublicClient, decodeEventLog, decodeFunctionData, encodeFunctionData, http, keccak256, parseAbi, parseAbiItem, type Hex, type TransactionReceipt } from "viem";
import type { RelayConfirmed, RelayReceipt } from "../aa/relayTypes";
import { jsonRpc, plainSend, syncSend, waitReceipt, type PendingReason, type RpcErr } from "./syncSend";
import { RelayerNonceCursor, sendWithCursor, classifySendError } from "./relayerNonce";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { robinhoodTestnet } from "../chains";
import { userOpHash, type UserOp } from "../aa/core";
import { ENTRYPOINT_V07 } from "../aa/constants";
import { relayerIsFaucet, relayerKey } from "./relayer";
import { RelayerKeyPool, poolKey, poolNames, uniquePoolNames } from "./relayerPool";
import { kv } from "./kv";
import { checkOpGas, maxPrefund, relayerPrice, relayerTxFees, totalGas } from "../aa/gasPolicy";
import { launchTargets } from "../aa/launchTargets";
import { chainGradReads, relayCaps } from "./gradBuy";
import { checkPaymaster, RelayPolicyError } from "../aa/gasPolicy";
import { allowedPaymaster, debitPaymasterDeposit, paymasterDepositCached } from "./paymasterDeposit";
import { TRADE_SELECTORS, TRY_ATTRIBUTE } from "../aa/oneTap";
import { packUserOp } from "./selfBundler";
import { FastInflight, SenderTrust } from "./relayTrust";
import { kvTrustStore } from "./relayTrustStore";

const epAbi = parseAbi([
  "struct P { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function handleOps(P[] ops, address beneficiary)",
]);
const uoEvent = parseAbiItem("event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)");
const pc = createPublicClient({ chain: robinhoodTestnet, transport: http(undefined, { fetchOptions: { keepalive: true } }) });

/** One relayer EOA + its nonce cursor (one per key per process). */
type RelayerState = { account: PrivateKeyAccount; nonces: RelayerNonceCursor; /** pool lease still held (checked before every signature) */ canSign?: () => boolean };
let single: RelayerState | undefined;
/** Pool keys this process has signed with (by address): an in-flight send keeps its state across a lease change. */
const pooled = new Map<string, RelayerState & { epoch: number }>();
let base = { fee: BigInt(0), at: 0 }, baseInflight: Promise<void> | undefined;

function stateOf(account: PrivateKeyAccount): RelayerState {
  return { account, nonces: new RelayerNonceCursor(() => pc.getTransactionCount({ address: account.address, blockTag: "pending" })) };
}
/** The single RELAYER_PRIVATE_KEY state (the faucet-shared cursor when relayerIsFaucet). Fails closed in production. */
function singleState(): RelayerState {
  return (single ??= stateOf(privateKeyToAccount(relayerKey())));
}
/**
 * Relayer key pool (lib/server/relayerPool), OFF unless RELAYER_KEY_POOL is set; never while the relayer is the faucet
 * (they must share ONE cursor). The single key must still resolve (fail-closed check + fallback when no lease).
 */
let pool: RelayerKeyPool | null | undefined;
const INSTANCE_ID = `${process.env.VERCEL_REGION ?? "local"}:${globalThis.crypto.randomUUID()}`;
function poolOf(): RelayerKeyPool | null {
  if (pool !== undefined) return pool;
  const names = uniquePoolNames(process.env, poolNames(process.env));
  if (!names.length) return (pool = null);
  if (relayerIsFaucet()) { console.warn("[relayer-pool] RELAYER_KEY_POOL ignored: the relayer is the faucet key"); return (pool = null); }
  return (pool = new RelayerKeyPool({ names, store: kv(), id: INSTANCE_ID, resolve: (n) => poolKey(process.env, n) }));
}
/** The relayer this process signs with (sync; production: RelayerNotConfiguredError → 503, never the faucet key). */
function active(): RelayerState {
  const fallback = singleState();   // always resolved first: fail closed exactly as before
  const p = poolOf();
  if (!p) return fallback;
  p.maybeRenew();   // off the hot path (not awaited)
  const l = p.current();
  if (!l) return fallback;
  let st = pooled.get(l.address);
  if (!st) { st = { ...stateOf(privateKeyToAccount(l.key)), epoch: l.epoch }; pooled.set(l.address, st); }
  // AUDIT Info: a re-acquired lease (new epoch) ⇒ another instance may have signed with this EOA meanwhile: resync
  else if (st.epoch !== l.epoch) { st.nonces.invalidate(); st.epoch = l.epoch; }
  const epoch = l.epoch;
  return { account: st.account, nonces: st.nonces, canSign: () => p.holds(epoch) };
}
/** active(), after (re-)acquiring a pool lease when the pool is on and this instance holds none (no-op when off). */
async function ready(): Promise<RelayerState> {
  singleState();
  const p = poolOf();
  if (p && !p.current()) await p.ensure().catch(() => undefined);
  return active();
}
function account() { return active().account; }
/**
 * The SAME cursor for every send from the relayer EOA in this process (the standard eth_sendUserOperation path, the
 * fast path, and /api/drip while the faucet and relayer are one key — see relayerIsFaucet) — otherwise a drip leaves the cursor stale and the next fast op pays a nonce error + resync
 * (~180 ms, seen on the first trade after "Get test funds"). Rules: lib/server/relayerNonce.sendWithCursor.
 */
export async function sendWithRelayerNonce<T>(send: (nonce: number) => Promise<T>): Promise<T> {
  return sendWithCursor(singleState().nonces, send);   // the faucet-shared key, never a pool key
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
// AUDIT #145 L-B: one unsimulated op in flight per sender (shared SET NX lease, kv() resolved lazily)
const FAST_INFLIGHT = new FastInflight({ setNX: (k, v, t) => kv().setNX(k, v, t), delIfEq: (k, v) => kv().delIfEq(k, v) });
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
  const st = await ready();   // pool on ⇒ lease a key at warm
  await Promise.all([st.nonces.warm(), baseFee(), sender ? primeSender(sender).catch(() => undefined) : 0]);
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
const PLAIN = jsonRpc(RPC_URL);
/** Sign a relayer tx; a local signing failure happened before any send ⇒ definitive (the nonce is released). */
async function signRelayerTx(me: PrivateKeyAccount, tx: { nonce: number; data: Hex; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): Promise<Hex> {
  try { return await me.signTransaction({ chainId: robinhoodTestnet.id, type: "eip1559", to: ENTRYPOINT_V07, ...tx }); }
  catch (e) { throw Object.assign(e as Error, { definitive: true }); }
}
/**
 * Standard path (selfBundler eth_sendUserOperation): sign handleOps with the relayer cursor and send it with a plain
 * eth_sendRawTransaction under the syncSend rules (lib/server/syncSend.plainSend). Returns the tx hash as soon as the
 * node accepted it OR it may have ("already known", timeout, network): the caller waits on that hash
 * (waitRelayReceipt) and NEVER re-signs. Only a definite nonce rejection re-signs (fresh nonce, bounded).
 */
/** `onSigned(relayNonce)`: the relayer EOA nonce of the signed handleOps tx (reported per signature; the last one wins). */
export type StandardRelayer = { address: Hex; send(data: Hex, gas: bigint, fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }, onSigned?: (relayNonce: number) => void): Promise<Hex> };
export async function standardRelayer(): Promise<StandardRelayer> {
  const st = await ready();   // ONE EOA for simulation, beneficiary and signature, even if the lease changes meanwhile
  return {
    address: st.account.address,
    async send(data, gas, fees, onSigned) {
      const r = await sendWithCursor(st.nonces, async (nonce) => {
        const raw = await signRelayerTx(st.account, { nonce, data, gas, ...fees });
        onSigned?.(nonce);
        return plainSend(raw, keccak256(raw), PLAIN);
      }, 2, st.canSign);
      if (r.pending) console.warn(`[relay] standard send ${r.txHash}: ${r.pending} — waiting on the same hash (no re-sign)`);
      return r.txHash;
    },
  };
}
/** Receipt of ONE relayer tx (fast node first when RHT_RECEIPT_RPC_URL is set, public RPC last); null at the deadline. */
export async function waitRelayReceipt(txHash: Hex, maxWaitMs = 25_000): Promise<RelayReceipt | null> {
  return waitReceipt(txHash, { getReceipt: receiptOf, maxWaitMs, pollMs: 250 }).catch(() => null);
}
export type OnPending = (p: { txHash: Hex; reason: PendingReason; relayNonce?: number }) => void;

/**
 * `beforeSend` (AUDIT Low, sender lockout): awaited once the op passed validation — gas/paymaster policy and the
 * simulation (or the trusted fast-path decision) — and BEFORE the relayer signs anything. The route charges the
 * per-sender limit there (lib/server/limits.sendLimiter); a throw aborts with nothing sent.
 */
export async function sendUserOperationSync(op: UserOp, onPending?: OnPending, beforeSend?: () => Promise<void>): Promise<RelayConfirmed> {
  // AUDIT #145 L-B: the fast (unsimulated) path needs this sender's single in-flight lease; a 2nd concurrent op simulates
  const lease = process.env.FAST_RELAY_SIM !== "1" && trusted(op) ? await FAST_INFLIGHT.acquire(op.sender) : null;
  try { return await relayOnce(op, !!lease, onPending, beforeSend); } finally { if (lease) await lease(); }
}
async function relayOnce(op: UserOp, allowFast: boolean, onPending?: OnPending, beforeSend?: () => Promise<void>): Promise<RelayConfirmed> {
  const T0 = Date.now(), t: Record<string, number> = {};
  const st = await ready(), me = st.account;
  // W-1: reject ops that would make the relayer pay (fee below 2x base + tip, or gas above the caps) before anything else
  const fee = await baseFee();
  // launches ⇒ LAUNCH_GAS_CAPS; above GAS_CAPS + verified graduating buy ⇒ GRAD_GAS_CAPS (on-chain check, lib/server/gradBuy)
  checkOpGas(op, fee, await relayCaps(op, launchTargets(robinhoodTestnet.id), chainGradReads(pc as never, robinhoodTestnet.id)));
  // USDG-gas op: the prefund comes from OUR paymaster's deposit (launch ops: up to LAUNCH_GAS_CAPS.total × fee)
  if (op.paymaster) {
    const pm = allowedPaymaster();
    try { checkPaymaster(op, pm, pm ? await paymasterDepositCached(pm) : BigInt(0), fee); }
    catch (e) { if (e instanceof RelayPolicyError) console.warn("[fastRelay] paymaster check:", e.detail ?? e.message); throw e; }
  }
  const data = encodeFunctionData({ abi: epAbi, functionName: "handleOps", args: [[packUserOp(op)], me.address] });
  const hash = userOpHash(op, robinhoodTestnet.id);
  const fast = allowFast && trusted(op);
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
  await beforeSend?.();   // validated ⇒ now the per-sender limit (and a press's free retry) may be charged
  const gas = totalGas(op) + BigInt(120_000);
  const txFees = relayerTxFees(op, fee);   // never above the op's fees ⇒ the EntryPoint refund covers the relayer's cost per gas
  let txHash: Hex | undefined, relayNonce: number | undefined;
  let r: Awaited<ReturnType<typeof sendSync>>;
  try {
    r = await sendWithCursor(st.nonces, async (nonce) => {
      const s = Date.now();
      const raw = await signRelayerTx(me, { nonce, data, gas, ...txFees });
      t.signTx = Date.now() - s;
      const h = (txHash = keccak256(raw)), n = (relayNonce = nonce);
      return sendSync(raw, onPending && ((p) => onPending({ ...p, txHash: h, relayNonce: n })));
    }, 2, st.canSign);
  } catch (e) {
    // AUDIT L2: notSent only for a definite rejection; anything else (unclear) leaves the client to look the tx up.
    // #141: once signed, txHash + the relayer nonce ride on the error; syncSend's receipt timeout keeps unclear/reason
    // (an unclear error is never notSent, whatever the classifier says).
    const unclear = (e as { unclear?: unknown }).unclear === true;
    throw Object.assign(e as Error, { txHash: (e as RpcErr).txHash ?? txHash, userOpHash: hash, notSent: !unclear && classifySendError(e) !== "unclear", ...(relayNonce !== undefined ? { relayNonce } : {}) });
  }
  t.send = r.sendMs; t.mined = r.minedMs; t.total = Date.now() - T0;
  if (op.paymaster) debitPaymasterDeposit(op.paymaster, maxPrefund(op, relayerPrice(fee)));
  let success = false;
  for (const l of r.rc.logs) {
    if (l.address.toLowerCase() !== ENTRYPOINT_V07.toLowerCase()) continue;
    try { const ev = decodeEventLog({ abi: [uoEvent], data: l.data, topics: l.topics as [Hex, ...Hex[]] }); if ((ev.args as { userOpHash: Hex }).userOpHash === hash) success = (ev.args as { success: boolean }).success; } catch { /* other event */ }
  }
  if (r.rc.status !== "0x1") TRUST.strike(op.sender);   // escalating backoff; fast path returns only after a passing simulation
  else if (TRUST.get(op.sender)) { TRUST.succeeded(op.sender, fast, senderPrefund(op)); void primeSender(op.sender).catch(() => undefined); } // conservative until refresh
  if (r.rc.status !== "0x1") throw Object.assign(new Error(`relayer tx ${r.rc.transactionHash} reverted (handleOps: validation failed?)`), { txHash: r.rc.transactionHash, userOpHash: hash, ...(relayNonce !== undefined ? { relayNonce } : {}) });
  const receipt = normalizeReceipt(r.rc);
  return { kind: "confirmed", userOpHash: hash, txHash: receipt.transactionHash, success, receipt, logs: receipt.logs, via: r.via, t: { simulate: t.simulate, signTx: t.signTx, send: t.send, mined: t.mined, total: t.total, mode: r.via === "rpc-wait" ? 0 : 1 } };
}

/** EIP-7966 / RPC receipts → RelayReceipt (hex quantities, logs kept whole). */
function normalizeReceipt(rc: RelayReceipt): RelayReceipt {
  return {
    transactionHash: rc.transactionHash, blockHash: rc.blockHash, blockNumber: rc.blockNumber, status: rc.status, gasUsed: rc.gasUsed,
    ...(rc.effectiveGasPrice ? { effectiveGasPrice: rc.effectiveGasPrice } : {}),
    logs: (rc.logs ?? []).map((l) => ({ address: l.address, topics: l.topics, data: l.data, ...(l.logIndex ? { logIndex: l.logIndex } : {}), ...(l.blockNumber ? { blockNumber: l.blockNumber } : {}), ...(l.transactionHash ? { transactionHash: l.transactionHash } : {}) })),
  };
}
