import "server-only";
import { relayReadTransport } from "./relayReadTransport";
import type { RelayMetrics } from "./relayMetrics";
/**
 * Gasless direct relayer: the relayer EOA signs and sends router txs (eth_sendRawTransactionSync).
 * Client sends a fully built + signed v0.7 UserOp; we validate the exact op, relay handleOps and answer with the receipt:
 *  - warm module state: relayer account, keep-alive RPC client, cached base fee (background refresh)
 *  - pre-tracked relayer nonce (local cursor, resynced on nonce errors) ⇒ no getTransactionCount per op
 *  - gas = the op's own limits + overhead ⇒ no estimateGas; EVERY exact signed op is simulated before signing
 *    (audit F-02). Sender history / balance primes and FAST_RELAY_SIM can never bypass authentication.
 *  - eth_sendRawTransactionSync (EIP-7966) returns the FULL receipt with the send (lib/server/syncSend: sequencer
 *    endpoint when RHT_SEQUENCER_URL is set, public RPC otherwise / as fallback). Timeout or error after signing ⇒
 *    onPending({ txHash }) and the server waits for the receipt (the client never polls; see lib/aa/relayTypes).
 * Ops from different users/keys run concurrently: only nonce assignment is serialized (synchronous).
 * Relayer nonce rules (feat/rapid-tap): lib/server/relayerNonce — definitive non-nonce rejection ⇒ roll back / resync,
 * nonce rejection (incl. "nonce too high") ⇒ resync + re-sign, "already known" / unclear ⇒ wait on the SAME txHash,
 * never re-sign. Both the fast path and the standard eth_sendUserOperation path (standardRelayer) follow them.
 */
import { createPublicClient, keccak256, type Hex, type TransactionReceipt } from "viem";
import type { RelayConfirmed, RelayReceipt } from "../aa/relayTypes";
import { jsonRpc, plainSend, syncSend, waitReceipt, type PendingReason, type RpcErr } from "./syncSend";
import { RelayerNonceCursor, SharedNonceCursor, sendWithCursor, classifySendError, type NonceCursor, type NonceStore } from "./relayerNonce";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { robinhoodTestnet } from "../chains";
import { relayerIsFaucet, relayerKey } from "./relayer";
import { RelayerKeyPool, poolKey, poolNames, uniquePoolNames } from "./relayerPool";
import { kv } from "./kv";
import { SenderTrust } from "./relayTrust";
import { kvTrustStore } from "./relayTrustStore";
import { strikeSource } from "./relayLockdown";

const pc = createPublicClient({ chain: robinhoodTestnet, transport: relayReadTransport(3000, 1)   /* job 9: bounded pre-send (viem default 10 s × 3 retries) */ });

/** One relayer EOA + its nonce cursor (one per key per process). */
type RelayerState = { account: PrivateKeyAccount; nonces: NonceCursor; /** pool lease still held (checked before every signature) */ canSign?: () => boolean };
let single: RelayerState | undefined;
/** Pool keys this process has signed with (by address): an in-flight send keeps its state across a lease change. */
const pooled = new Map<string, RelayerState & { epoch: number }>();
let base = { fee: BigInt(0), at: 0 }, baseInflight: Promise<void> | undefined;

const pendingOf = (a: PrivateKeyAccount) => () => pc.getTransactionCount({ address: a.address, blockTag: "pending" });
/** Pool keys: lease-exclusive (one instance signs per EOA) ⇒ a per-process cursor is enough. */
function stateOf(account: PrivateKeyAccount): RelayerState {
  return { account, nonces: new RelayerNonceCursor(pendingOf(account)) };
}
/** kv.nonceAlloc / nonceRelease under relayer:nonce:<chain>:<addr> (+ :holes); TTL refreshed on every alloc. */
const NONCE_TTL_SEC = 3600;
export function kvNonceStore(address: string, chainId = robinhoodTestnet.id): NonceStore {
  const k = `relayer:nonce:${chainId}:${address.toLowerCase()}`, h = `${k}:holes`;
  return {
    alloc: (floor) => kv().nonceAlloc(k, h, floor, NONCE_TTL_SEC),
    release: (n) => kv().nonceRelease(k, h, n, NONCE_TTL_SEC),
    claim: (tag, ttl) => kv().setNX(`${k}:${tag}`, "1", ttl),
  };
}
/**
 * The single RELAYER_PRIVATE_KEY state (the faucet-shared cursor when relayerIsFaucet). Fails closed in production.
 * Every instance writes this EOA ⇒ nonces come from the shared KV allocator (SharedNonceCursor), not a per-process
 * counter. RELAYER_NONCE_SHARED=0 restores the per-process cursor (escape hatch; not set anywhere).
 */
function singleState(): RelayerState {
  if (single) return single;
  const account = privateKeyToAccount(relayerKey());
  const nonces = process.env.RELAYER_NONCE_SHARED === "0" ? new RelayerNonceCursor(pendingOf(account)) : new SharedNonceCursor(kvNonceStore(account.address), pendingOf(account));
  return (single = { account, nonces });
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
  return sendWithCursor(singleState().nonces, send, 3);   // the faucet-shared key, never a pool key
}
function refreshBase() {
  return (baseInflight ??= pc.getBlock().then((b) => { base = { fee: b.baseFeePerGas ?? BigInt(0), at: Date.now() }; }).finally(() => { baseInflight = undefined; }));
}
async function baseFee(): Promise<bigint> { if (!base.at) await refreshBase(); else if (Date.now() - base.at > 2000) void refreshBase().catch(() => undefined); return base.fee; }

/** Sender ledger is telemetry/backoff only, NEVER authorization to spend relayer funds (audit F-02). */
const TRUST = new SenderTrust(Date.now, kvTrustStore());   // AUDIT Low: strikes / verification shared + durable (KV)
// AUDIT r264 hardening 6: admission refuses a sender inside its strike window (this instance's ledger ∪ the KV copy).
strikeSource.local = (sender) => TRUST.get(sender)?.strikeUntil ?? 0;
/** Await the trust ledger's pending KV writes (the gasless route calls this before responding). */
export const flushRelayTrust = () => TRUST.flush();

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
export type OnPending = (p: { txHash: Hex; reason: PendingReason; relayNonce?: number }) => void;
async function sendSync(raw: Hex, onPending?: OnPending) {
  warmSequencer();
  return syncSend(raw, keccak256(raw), { send: SEND, getReceipt: receiptOf, onPending });
}
function normalizeReceipt(rc: RelayReceipt): RelayReceipt {
  return {
    transactionHash: rc.transactionHash, blockHash: rc.blockHash, blockNumber: rc.blockNumber, status: rc.status, gasUsed: rc.gasUsed,
    ...(rc.effectiveGasPrice ? { effectiveGasPrice: rc.effectiveGasPrice } : {}),
    logs: (rc.logs ?? []).map((l) => ({ address: l.address, topics: l.topics, data: l.data, ...(l.logIndex ? { logIndex: l.logIndex } : {}), ...(l.blockNumber ? { blockNumber: l.blockNumber } : {}), ...(l.transactionHash ? { transactionHash: l.transactionHash } : {}) })),
  };
}

/* ───────── Gasless direct relay (lib/server/gaslessRelay; GAS_SPONSORSHIP_MODE=gasless) ─────────
 * Additive: the SAME relayer pool / lease / nonce cursor / sequencer sync send as the self-bundler above, but the
 * relayer tx calls the gasless router (DiscipleRouter.buyWithPermit2 / sellWithPermit2, LoginGate.attest) directly:
 * no handleOps, no UserOp, no paymaster. Nothing above changed. */
export type DirectRelayer = { address: Hex; fee: bigint; st: RelayerState };
/** Relayer EOA (pool lease when on) + warm base fee + warm nonce, in parallel. Read-only (nothing allocated/signed). */
const stage = <T>(metrics: RelayMetrics | undefined, name: string, task: () => Promise<T>) => metrics ? metrics.span(name, task) : task();
export async function directRelayer(metrics?: RelayMetrics): Promise<DirectRelayer> {
  const st = await stage(metrics, "relayerReady", ready);
  const [fee] = await Promise.all([stage(metrics, "baseFee", baseFee), stage(metrics, "nonceWarm", () => st.nonces.warm())]);
  warmSequencer();
  return { address: st.account.address, fee, st };
}
/** Exact eth_call of the relayer tx from the relayer address (pending block). Throws with the revert data kept. */
export async function simulateDirect(from: Hex, to: Hex, data: Hex): Promise<void> {
  try { await pc.call({ account: from, to, data, blockTag: "pending" }); }
  catch (e) {
    let rd: string | undefined;
    (e as { walk?: (f: (x: unknown) => boolean) => unknown }).walk?.((x) => { const v = (x as { data?: unknown }).data; if (typeof v === "string" && /^0x[0-9a-fA-F]{8,}$/.test(v)) { rd = v; return true; } return false; });
    throw Object.assign(new Error(`simulation failed: ${(e as Error).message.split("\n")[0]}`), { data: rd, notSent: true });
  }
}
/** Relayer tx fees: 2 × base fee cap (Arbitrum charges the actual base fee), no tip (FCFS sequencer). */
export const directTxFees = (fee: bigint) => ({ maxFeePerGas: fee * BigInt(2) > BigInt(0) ? fee * BigInt(2) : BigInt(20_000_000), maxPriorityFeePerGas: BigInt(0) });
export type DirectSendResult = { rc: RelayReceipt; via: RelayConfirmed["via"]; sendMs: number; minedMs: number; txHash: Hex; relayNonce?: number };
/**
 * Sign + eth_sendRawTransactionSync ONE relayer tx to `to` under the existing nonce rules (lib/server/relayerNonce
 * sendWithCursor: definite rejection ⇒ release/resync, unclear ⇒ wait on the SAME hash, never re-sign) and the pool
 * lease check before every signature. Errors carry { txHash, notSent, unclear } exactly like commitOp.
 */
export async function sendDirect(r: DirectRelayer, to: Hex, data: Hex, gas: bigint, onPending?: OnPending, metrics?: RelayMetrics): Promise<DirectSendResult> {
  const { st } = r, fees = directTxFees(r.fee);
  let txHash: Hex | undefined, relayNonce: number | undefined, signed = false;
  try {
    const res = await sendWithCursor(metrics ? {
      warm: () => st.nonces.warm(),
      take: () => metrics.span("nonceAllocate", () => st.nonces.take()),
      release: n => st.nonces.release(n), invalidate: () => st.nonces.invalidate(),
      recover: (e, n, final) => metrics.span("nonceRecover", () => st.nonces.recover(e, n, final)),
    } : st.nonces, async (nonce) => {
      const s = Date.now();
      let raw: Hex;
      try { raw = await st.account.signTransaction({ chainId: robinhoodTestnet.id, type: "eip1559", to, data, gas, nonce, ...fees }); }
      catch (e) { throw Object.assign(e as Error, { definitive: true }); }
      signed = true; metrics?.add("signTx", Date.now() - s);
      const h = (txHash = keccak256(raw)), n = (relayNonce = nonce);
      return sendSync(raw, onPending && ((p) => onPending({ ...p, txHash: h, relayNonce: n })));
    }, 2, st.canSign);
    metrics?.add("syncSend", res.sendMs); metrics?.add("mined", res.minedMs); metrics?.mark("receiptReady");
    return { rc: normalizeReceipt(res.rc), via: res.via, sendMs: res.sendMs, minedMs: res.minedMs, txHash: res.rc.transactionHash as Hex, relayNonce };
  } catch (e) {
    const unclear = (e as { unclear?: unknown }).unclear === true;
    const notSent = !signed || (!unclear && classifySendError(e) !== "unclear");
    throw Object.assign(e as Error, { txHash: (e as RpcErr).txHash ?? txHash, notSent, ...(unclear ? { unclear: true } : {}), ...(relayNonce !== undefined ? { relayNonce } : {}) });
  }
}
/** Strike the sender's trust ledger (escalating backoff; admission's strike window refuses it). */
/** Strike the wallet, and when `did` is set also the Privy user, so a new linked wallet can't skip the window (M1). */
export const strikeSender = (sender: string, did?: string | null) => { TRUST.strike(sender); if (did) TRUST.strike(did); };
