import "server-only";
import { relayReadTransport } from "./relayReadTransport";
/** F-02 admission. Exact signature validation/execution remains mandatory in fastRelay after these checks. */
import { createPublicClient, parseAbi, type Address } from "viem";
import { readSession } from "@disciple/session-keys";
import { ACTIVE_CHAIN, DEPLOYMENTS, robinhoodTestnet } from "../chains";
import { accountCalls } from "../aa/gasPolicy";
import { sessionPolicyFor } from "../aa/oneTap";
import type { UserOp } from "../aa/core";
import { ENTRYPOINT_V07 } from "../aa/constants";
import { selfBundlerMode } from "../aa/sponsorshipMode";
import { chainGradReads } from "./gradBuy";
import { checkSponsoredCalls } from "./gasSponsorship";
import { kv } from "./kv";
import { ImmutableRelayCache, type RelayMetrics } from "./relayMetrics";
export const admissionImmutableCache = new ImmutableRelayCache();
const timed = <T>(m: RelayMetrics | undefined, stage: string, task: () => Promise<T>) => m ? m.span(stage, task) : task();

const pc = createPublicClient({ chain: robinhoodTestnet, transport: relayReadTransport(5000, 0) });
const abi = parseAbi(["function verifiedUntil(address) view returns(uint64)", "function moduleId() view returns(string)", "function paymaster() view returns(address)"]);
const epNonceAbi = parseAbi(["function getNonce(address sender, uint192 key) view returns (uint256)"]);
export function requireSelfBundlerMode() {
  const preview = process.env.VERCEL_ENV === "preview";
  const local = (!process.env.VERCEL_ENV || process.env.VERCEL_ENV === "development") && (!process.env.VERCEL || process.env.VERCEL_ENV === "development") && process.env.NODE_ENV !== "production";
  if (!selfBundlerMode() || ACTIVE_CHAIN.id !== 46630 || (!preview && !local))
    throw new Error("self-bundler disabled: local or Preview testnet only");
}
export function sessionEntity(op: UserOp): number {
  const key = BigInt(op.nonce) >> 64n;
  const entity = Number((key >> 8n) & 0xffffffffn);
  // Non-global, non-deferred, no unknown flags; only installed session validation.
  if ((key & 255n) !== 0n || entity <= 0 || entity >= 2 ** 31 || op.factory || op.factoryData)
    throw new Error("session admission rejected");
  return entity;
}
export async function requireLogin(sender: Address, metrics?: RelayMetrics) {
  requireSelfBundlerMode();
  const [chainId, block, until] = await timed(metrics, "authLogin", () => Promise.all([pc.getChainId(), pc.getBlock(), pc.readContract({ address: DEPLOYMENTS[46630].loginGate, abi, functionName: "verifiedUntil", args: [sender] })]));
  if (chainId !== 46630 || until <= block.timestamp) throw new Error("unauthenticated LoginGate session");
  return Number(block.timestamp);
}
/** Synchronous, RPC-free admission shape (mode, session nonce key, trade-call batch). Runs before ANY speculative
 * RPC work so malformed / owner / self-call ops never reach simulation. Not authentication: admitRelay still decides. */
export function admissionShape(op: UserOp) {
  requireSelfBundlerMode();
  const entity = sessionEntity(op), policy = sessionPolicyFor(46630);
  if (!policy) throw new Error("session policy unavailable");
  const calls = accountCalls(op.callData);
  if (!calls?.length || calls.some(c => c.to.toLowerCase() === op.sender.toLowerCase())) throw new Error("trade calls only");
  return { entity, policy };
}
export async function admitRelay(op: UserOp, metrics?: RelayMetrics) {
  const { entity, policy } = admissionShape(op);
  const positiveAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/i.test(a);
  const base = chainGradReads(pc, 46630);
  const reads = { ...base, curveOf: (token: string) => admissionImmutableCache.get(`46630:curve:${DEPLOYMENTS[46630].launchpad}:${token.toLowerCase()}`, () => base.curveOf(token), positiveAddress) };
  // Only pure moduleId, immutable policy paymaster, and positive write-once registry mappings cache.
  // Curve metadata (incl. graduation), LoginGate and revocable session state are ALWAYS fresh.
  const login = requireLogin(op.sender, metrics);
  const session = timed(metrics, "sessionRead", async () => {
    const [id, pm, state] = await Promise.all([
      admissionImmutableCache.get(`46630:module:${policy}`, () => pc.readContract({ address: policy, abi, functionName: "moduleId" }), v => v === "disciple.session-policy.1.4.3"),
      admissionImmutableCache.get(`46630:paymaster:${policy}`, () => pc.readContract({ address: policy, abi, functionName: "paymaster" }), positiveAddress),
      readSession(pc, policy, op.sender, entity),
    ]);
    return { id, pm, state };
  });
  // Target registry reads start immediately, but deadlines still use the fresh chain timestamp.
  const targets = timed(metrics, "targetSelector", () => checkSponsoredCalls(op.callData, op.sender, reads, login));
  const [now, { id, pm, state }] = await Promise.all([login, session, targets]);
  if (id !== "disciple.session-policy.1.4.3" || !state.active || state.validUntil <= now) throw new Error("inactive or expired session");
  if (op.paymaster && op.paymaster.toLowerCase() !== pm.toLowerCase()) throw new Error("wrong session paymaster");
}
/** Strict shared caps: store failure rejects, never a local fallback. Charged only after full exact simulation. */
export async function relaySendBudget(sender: string, metrics?: RelayMetrics) {
  const store = kv();
  const [senderCount, globalCount] = await timed(metrics, "rateLimitStore", () => Promise.all([
    store.incrEx(`relay:paid:sender:${sender.toLowerCase()}`, 60), store.incrEx("relay:paid:global", 60),
  ]));
  if (senderCount > 20 || globalCount > 60) throw new Error("relay rate limited");
}
/**
 * Speedup 1 (lee, Nov 7 11:02 AM CT: "simulate before the lease, re-check the nonce under the lease").
 * Fresh state the speculative simulation depended on, re-read UNDER the sender lease before anything is signed:
 *  - EntryPoint nonce for this op's own 2D key must still equal op.nonce (the exact sequence the simulation validated);
 *  - LoginGate verifiedUntil and the session (active, validUntil) must still pass against a fresh block timestamp.
 * One batched read wave. Any failure ⇒ notSent (nothing signed). Same-sender self-route ops with OTHER nonce keys are
 * caught by the lease generation fence in lockedRelay, which forces a full re-simulation instead.
 */
export async function recheckUnderLease(op: UserOp, metrics?: RelayMetrics) {
  const { entity, policy } = admissionShape(op);
  const key = BigInt(op.nonce) >> 64n;
  const [block, until, state, nonce] = await timed(metrics, "leaseRecheckReads", () => Promise.all([
    pc.getBlock(),
    pc.readContract({ address: DEPLOYMENTS[46630].loginGate, abi, functionName: "verifiedUntil", args: [op.sender] }),
    readSession(pc, policy, op.sender, entity),
    pc.readContract({ address: ENTRYPOINT_V07, abi: epNonceAbi, functionName: "getNonce", args: [op.sender, key], blockTag: "pending" }),
  ]));
  if (BigInt(nonce) !== BigInt(op.nonce)) throw Object.assign(new Error("stale simulation: sender nonce changed before signing; nothing sent, retry"), { notSent: true, retryable: true });
  if (until <= block.timestamp) throw Object.assign(new Error("unauthenticated LoginGate session"), { notSent: true });
  if (!state.active || state.validUntil <= Number(block.timestamp)) throw Object.assign(new Error("inactive or expired session"), { notSent: true });
}
/** Validate → (lease) → fresh re-check → commit. `validate` MUST be today's complete pre-sign validation (gas/fee caps,
 * deposit guard, account template, exact handleOps simulation, L1 sizing); `commit` charges the paid budget, awaits
 * `fresh`, and only then allocates a relayer nonce, signs and sends. */
export type SpeculativeRelay<V, T> = { validate: () => Promise<V>; recheck: (v: V) => Promise<void>; commit: (v: V, fresh: Promise<void>) => Promise<T> };
const leaseKey = (sender: string) => `relay:pending:${sender.toLowerCase()}`;
/** Lease generation: atomically fetch-and-incremented by every lease holder (sliding TTL). Only lease holders write it. */
const genKey = (sender: string) => `relay:leasegen:${sender.toLowerCase()}`;
const GEN_TTL_SEC = 30 * 24 * 3600;
const notSent = (e: unknown) => Object.assign(e as Error, { notSent: true });
/**
 * One in-flight paid bundle per sender. Ambiguous sends quarantine until TTL rather than retrying.
 * With a SpeculativeRelay: the IP limit already ran in the route; the RPC-free shape gate runs first; then exact
 * simulation + account/L1/gas/deposit checks run CONCURRENTLY with admission (LoginGate, session, target registry),
 * BEFORE the lease. Nothing is leased, charged, nonce-allocated, signed or sent until BOTH pass. Under the lease:
 *  - stale speculation (lease queued, lease held when the snapshot was taken, or any other lease holder in between
 *    per the generation fence) ⇒ full re-admission when queued + full re-validation under the lease, i.e. today's order;
 *  - otherwise ⇒ recheck (nonce for this key, LoginGate, session, deposit guard, account template) in parallel with the
 *    paid budget; any failure ⇒ notSent, nothing signed.
 * A plain function keeps the original (validate-under-lease) behaviour.
 */
export async function lockedRelay<T, V = unknown>(op: UserOp, relay: (() => Promise<T>) | SpeculativeRelay<V, T>, metrics?: RelayMetrics, confirmed?: (value: T) => void): Promise<T> {
  const store = kv(), key = leaseKey(op.sender), gkey = genKey(op.sender), tag = crypto.randomUUID();
  const spec = typeof relay === "function" ? undefined : relay;
  let fence: Promise<number | undefined> = Promise.resolve(undefined), speculative: Promise<V | undefined> = Promise.resolve(undefined);
  if (spec) {
    try { admissionShape(op); } catch (e) { throw notSent(e); }
    // Atomic MGET snapshot BEFORE the simulation is issued: undefined (⇒ must re-validate) when a lease is held or the
    // store is unreadable. The simulation only starts after this resolves.
    fence = timed(metrics, "freshnessSnapshot", () => store.mget([gkey, key]))
      .then(([g, holder]) => (holder === null || holder === undefined ? Number(g ?? 0) : undefined), () => undefined);
    speculative = fence.then(() => timed(metrics, "speculativePreflight", spec.validate));
    void speculative.catch(() => undefined);
  }
  const admission = timed(metrics, "admissionWall", () => admitRelay(op, metrics));
  const [a, s] = await timed(metrics, "admissionSimulationWall", () => Promise.allSettled([admission, speculative]));
  // Admission has priority even when speculation fails first: an auth error is reported as such.
  if (a.status === "rejected") throw notSent(a.reason);
  if (s.status === "rejected") throw notSent(s.reason);
  const deadline = Date.now() + 5000;
  let waited = false;
  while (!await timed(metrics, "leaseAcquire", () => store.setNX(key, tag, 90))) {
    waited = true;
    if (Date.now() >= deadline) throw Object.assign(new Error("sender already confirming; no submission"), { notSent: true });
    await timed(metrics, "leaseQueueWait", () => new Promise(resolve => setTimeout(resolve, 25)));
  }
  let release = true;
  try {
    if (waited) await timed(metrics, "admissionWall", () => admitRelay(op, metrics)); // never reuse authentication/session state across a queued wait
    let value: T;
    if (spec) {
      const before = await timed(metrics, "leaseGeneration", () => store.nonceAlloc(gkey, `${gkey}:holes`, 0, GEN_TTL_SEC));
      const g0 = await fence;
      const stale = waited || g0 === undefined || before !== g0;
      metrics?.add("speculationStale", stale ? 1 : 0);
      value = await timed(metrics, "relayCoreWall", async () => {
        if (stale) return spec.commit(await timed(metrics, "resimulateUnderLease", spec.validate), Promise.resolve());
        const v = (s as PromiseFulfilledResult<V>).value;
        const fresh = timed(metrics, "leaseRecheck", () => spec.recheck(v));
        void fresh.catch(() => undefined);
        return spec.commit(v, fresh);
      });
    } else value = await timed(metrics, "relayCoreWall", relay as () => Promise<T>);
    // Only the streaming caller with a registered waitUntil uses this hook. Receipt is already final.
    try { confirmed?.(value); } catch { /* disconnected browser never changes lease/receipt semantics */ }
    return value;
  }
  catch (e) {
    const x = e as { txHash?: string; notSent?: boolean; unclear?: boolean };
    if (x.unclear || (x.txHash && x.notSent !== true)) release = false;
    throw e;
  } finally { if (release) await timed(metrics, "leaseRelease", () => store.delIfEq(key, tag)); }
}
