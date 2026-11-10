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
import { chainGradReads, type CurveMeta, type GradReads } from "./gradBuy";
import { checkSponsoredCalls } from "./gasSponsorship";
import { kv } from "./kv";
import { REVOKE_MARKER_TTL_SEC, revokeMarkerKey, banKey } from "../relayRevokeMarker";
import { ImmutableRelayCache, type RelayMetrics } from "./relayMetrics";
/** Per-instance only (never KV), 1 h TTL, 256 entries. Holds ONLY: pure policy moduleId, its immutable paymaster, positive
 * write-once Launchpad.curveOf(token) (Launchpad.sol: assigned once at launch, no setter) and a curve's immutable
 * token()/quote() (BondingCurve.sol `immutable`). Never graduated, LoginGate, sessions, nonces, block timestamps,
 * balances, zero/invalid values or failed reads. */
export const ADMISSION_CACHE_TTL_MS = 3_600_000;
export const admissionImmutableCache = new ImmutableRelayCache(ADMISSION_CACHE_TTL_MS);
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
  return loginTimestamp(sender, metrics);
}
/** The LoginGate admission read shared by the self-bundler (requireLogin, mode-checked above) and the gasless relay
 *  (lib/server/gaslessRelay, which runs its own mode check first): fresh chain id + block + verifiedUntil, never cached. */
export async function loginTimestamp(sender: Address, metrics?: RelayMetrics) {
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
// AUDIT hardening 5 (M4): see lib/relayRevokeMarker (written by the revocation tooling before its on-chain revoke).
export { REVOKE_MARKER_TTL_SEC, revokeMarkerKey, banKey };
/** AUDIT hardening 6: the strike ledger (fastRelay TRUST, persisted at relay:trust:<sender>) becomes a gate. */
export const strikeSource: { local: (sender: string) => number } = { local: () => 0 };
const trustKey = (sender: string) => `relay:trust:${sender.toLowerCase()}`;
const revoked = () => Object.assign(new Error("session revoked; no submission"), { notSent: true });
const banned = () => Object.assign(new Error("session banned; no submission"), { notSent: true });
const strikeUntilOf = (raw: string | null | undefined): number => {
  if (!raw) return 0;
  try { const v = Number((JSON.parse(raw) as { strikeUntil?: unknown }).strikeUntil ?? 0); return Number.isFinite(v) ? v : Infinity; }
  catch { return Infinity; }   // unreadable ledger entry ⇒ fail closed
};
/** Wallet (+ optional Privy DID) revoke marker, permanent ban, and strike window, one MGET. Fail closed.
 *  did is the Privy user id (`did:privy:…`); when set, a ban/revoke/strike on the did also blocks any of that
 *  user's wallets (H1 / M1). Self-bundler calls without a did still check the wallet keys (incl. the ban). */
export async function requireNotRevokedOrStruck(sender: string, now = Date.now(), did?: string | null) {
  const ids = did ? [sender, did] : [sender];
  const keys = ids.flatMap(id => [banKey(id), revokeMarkerKey(id), trustKey(id)]);
  let vals: (string | null)[];
  try { vals = await kv().mget(keys); }
  catch { throw Object.assign(new Error("relay gate store unavailable; no submission"), { notSent: true }); }
  let until = ids.reduce((u, id) => Math.max(u, strikeSource.local(id)), 0);
  for (let i = 0; i < ids.length; i++) {
    const [ban, marker, trust] = vals.slice(i * 3, i * 3 + 3);
    if (ban !== null && ban !== undefined) throw banned();
    if (marker !== null && marker !== undefined) throw revoked();
    until = Math.max(until, strikeUntilOf(trust));
  }
  if (now < until) throw Object.assign(new Error("sender in relay strike backoff; no submission"), { notSent: true });
}
export async function admitRelay(op: UserOp, metrics?: RelayMetrics) {
  const { entity, policy } = admissionShape(op);
  const positiveAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/i.test(a);
  const base = chainGradReads(pc, 46630), lp = DEPLOYMENTS[46630].launchpad.toLowerCase();
  const miss = <R>(name: string, read: () => Promise<R>) => () => { metrics?.add(name, 1); return read(); };
  const reads: GradReads = {
    ...base,
    curveOf: (token: string) => timed(metrics, "targetCurveOf", () => admissionImmutableCache.get(`46630:curve:${lp}:${token.toLowerCase()}`,
      miss("targetCurveOfMiss", () => base.curveOf(token)), positiveAddress) as Promise<string>),
    // Projected to {token, quote}: graduated is never read into or served from the cache.
    curveMeta: (curve: string) => timed(metrics, "targetCurveMeta", () => admissionImmutableCache.get(`46630:curvemeta:${lp}:${curve.toLowerCase()}`,
      miss("targetCurveMetaMiss", async () => { const i = await (base.curveMeta ? base.curveMeta(curve) : base.curveInfo(curve)); return { token: i.token, quote: i.quote }; }),
      (v: CurveMeta) => positiveAddress(v.token) && positiveAddress(v.quote)) as Promise<CurveMeta>),
  };
  // Cached: pure moduleId, immutable policy paymaster, positive write-once curveOf, immutable curve token/quote.
  // Graduation, LoginGate, the block timestamp and revocable session state are ALWAYS fresh. relayCaps (fastRelay
  // validateOp) uses its own uncached chainGradReads, so the grad-cap decision reads graduated fresh.
  const login = requireLogin(op.sender, metrics);
  // AUDIT hardening 5/6: KV revoke marker + strike window, one MGET in parallel with the RPC reads. Fail closed.
  const gate = timed(metrics, "revokeStrikeGate", () => requireNotRevokedOrStruck(op.sender));
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
  const [now, { id, pm, state }] = await Promise.all([login, session, targets, gate]);
  if (id !== "disciple.session-policy.1.4.3" || !state.active || state.validUntil <= now) throw new Error("inactive or expired session");
  if (op.paymaster && op.paymaster.toLowerCase() !== pm.toLowerCase()) throw new Error("wrong session paymaster");
}
/** Strict shared caps: store failure rejects, never a local fallback. Charged only after full exact simulation. */
export const RELAY_SENDER_CAP = 20, RELAY_GLOBAL_CAP = 60, RELAY_BUDGET_WINDOW_SEC = 60;
export const RELAY_GLOBAL_KEY = "relay:paid:global";
/**
 * Paid-send budget (caps unchanged: 20/sender/min, 60 global/min; a store error throws ⇒ fail closed).
 * Vercel Security finding 1: one atomic EVAL checks the sender cap FIRST and charges the global counter only when the
 * sender is under its cap (and refunds it when the global cap is hit), so one sender's over-cap replays can't burn
 * everyone's global quota. Returns a refund for the global unit: the caller calls it when the op is rejected before
 * anything is signed (only an admitted send/broadcast keeps the global charge).
 */
export async function relaySendBudget(sender: string, metrics?: RelayMetrics): Promise<() => Promise<void>> {
  const store = kv();
  const r = await timed(metrics, "rateLimitStore", () => store.relayBudget(`relay:paid:sender:${sender.toLowerCase()}`, RELAY_GLOBAL_KEY,
    RELAY_SENDER_CAP, RELAY_GLOBAL_CAP, RELAY_BUDGET_WINDOW_SEC));
  if (r !== 0) throw new Error("relay rate limited");
  let refunded = false;
  return async () => { if (refunded) return; refunded = true; await store.decrIfPositive(RELAY_GLOBAL_KEY); };
}
/** Facts the fresh read wave established (block timestamp, LoginGate expiry, session expiry). */
export type FreshFacts = { blockTs: number; verifiedUntil: number; validUntil: number; /** local Date.now() when the wave was issued */ readAtMs: number };
/** AUDIT hardening 2 (M2): expiry must clear the read block time, advanced by the local time elapsed since the read
 * (rounded up; chain-time based, so server clock skew can't loosen it), by this margin. */
export const EXPIRY_MARGIN_SEC = 3;
export function requireExpiryMargin(f: FreshFacts, nowMs = Date.now()) {
  const now = f.blockTs + Math.ceil(Math.max(0, nowMs - f.readAtMs) / 1000) + EXPIRY_MARGIN_SEC;
  if (f.verifiedUntil <= now) throw Object.assign(new Error("unauthenticated LoginGate session (expiry margin)"), { notSent: true });
  if (f.validUntil <= now) throw Object.assign(new Error("inactive or expired session (expiry margin)"), { notSent: true });
}
/**
 * Fresh read wave (speedup (a), lee 12:21 CT Nov 9): issued BEFORE the lease, after the fence snapshot, concurrently
 * with simulation; and again UNDER the lease whenever the pre-lease reads are older than PRE_LEASE_MAX_AGE_MS.
 *  - EntryPoint nonce for this op's own 2D key must equal op.nonce;
 *  - LoginGate verifiedUntil and the session (active, validUntil) must pass against the fresh block timestamp + margin.
 * Any failure ⇒ notSent (nothing signed).
 */
export async function recheckUnderLease(op: UserOp, metrics?: RelayMetrics): Promise<FreshFacts> {
  const { entity, policy } = admissionShape(op);
  const key = BigInt(op.nonce) >> 64n, readAtMs = Date.now();
  const [block, until, state, nonce] = await timed(metrics, "leaseRecheckReads", () => Promise.all([
    pc.getBlock(),
    pc.readContract({ address: DEPLOYMENTS[46630].loginGate, abi, functionName: "verifiedUntil", args: [op.sender] }),
    readSession(pc, policy, op.sender, entity),
    pc.readContract({ address: ENTRYPOINT_V07, abi: epNonceAbi, functionName: "getNonce", args: [op.sender, key], blockTag: "pending" }),
  ]));
  if (BigInt(nonce) !== BigInt(op.nonce)) throw Object.assign(new Error("stale simulation: sender nonce changed before signing; nothing sent, retry"), { notSent: true, retryable: true });
  if (until <= block.timestamp) throw Object.assign(new Error("unauthenticated LoginGate session"), { notSent: true });
  if (!state.active || state.validUntil <= Number(block.timestamp)) throw Object.assign(new Error("inactive or expired session"), { notSent: true });
  const facts = { blockTs: Number(block.timestamp), verifiedUntil: Number(until), validUntil: Number(state.validUntil), readAtMs };
  requireExpiryMargin(facts);
  return facts;
}
/** `validate` MUST be today's complete pre-sign validation (gas/fee caps, deposit guard, account template, exact
 * handleOps simulation, L1 sizing). `freshReads` = recheckUnderLease + account runtime/implementation slot.
 * `underLease` = the checks that always run under the lease: deposit guard (M1) and the expiry margin (M2), CPU/cache
 * only. `commit` charges the paid budget, awaits `fresh`, and only then allocates a relayer nonce, signs and sends. */
export type SpeculativeRelay<V, T> = {
  validate: () => Promise<V>;
  freshReads: () => Promise<FreshFacts>;
  underLease: (v: V, f: FreshFacts) => Promise<void>;
  commit: (v: V, fresh: Promise<void>) => Promise<T>;
};
/** AUDIT hardening 4 (M3), measured at the under-lease decision from the ISSUE time of the pre-lease read wave. The
 * remaining budget/nonce/sign steps (~20–50 ms) keep the read age at signing ≤ ~300 ms; past the cap ⇒ the full
 * fresh read wave runs again under the lease (the pre-(a) re-check). */
export const PRE_LEASE_MAX_AGE_MS = 250;
const leaseKey = (sender: string) => `relay:pending:${sender.toLowerCase()}`;
/** Lease generation: atomically fetch-and-incremented by every lease holder (sliding TTL). Only lease holders write it. */
const genKey = (sender: string) => `relay:leasegen:${sender.toLowerCase()}`;
const GEN_TTL_SEC = 30 * 24 * 3600;
const notSent = (e: unknown) => Object.assign(e as Error, { notSent: true });
/**
 * One in-flight paid bundle per sender. Ambiguous sends quarantine until TTL rather than retrying.
 * With a SpeculativeRelay (speedup (a), lee 12:21 CT Nov 9, with AUDIT's 7 hardening steps): the IP limit already ran
 * in the route; the RPC-free shape gate runs first; then, CONCURRENTLY and BEFORE the lease: admission (LoginGate,
 * session, target registry, revoke marker, strike window), and — after the fence snapshot — exact simulation +
 * account/L1/gas/deposit checks and the fresh read wave (nonce, LoginGate, session, account implementation). Nothing is
 * leased, charged, nonce-allocated, signed or sent until ALL pass. Under the lease, concurrently: the generation
 * fetch-add (fence) and the revoke marker read. Then:
 *  - marker present ⇒ notSent;
 *  - stale (queued, lease held at snapshot, unreadable snapshot, generation moved, marker unreadable) ⇒ the FULL stale
 *    path: re-admission + exact re-simulation under the lease;
 *  - pre-lease reads older than PRE_LEASE_MAX_AGE_MS ⇒ the fresh read wave runs again under the lease;
 *  - always: deposit guard + expiry margin under the lease, in parallel with the paid budget.
 * Any failure ⇒ notSent, nothing signed. A plain function keeps the original (validate-under-lease) behaviour.
 */
export async function lockedRelay<T, V = unknown>(op: UserOp, relay: (() => Promise<T>) | SpeculativeRelay<V, T>, metrics?: RelayMetrics, confirmed?: (value: T) => void): Promise<T> {
  const store = kv(), key = leaseKey(op.sender), gkey = genKey(op.sender), tag = crypto.randomUUID();
  const spec = typeof relay === "function" ? undefined : relay;
  let fence: Promise<number | undefined> = Promise.resolve(undefined), speculative: Promise<V | undefined> = Promise.resolve(undefined);
  let pre: Promise<{ at: number; facts: FreshFacts } | undefined> = Promise.resolve(undefined);
  if (spec) {
    try { admissionShape(op); } catch (e) { throw notSent(e); }
    // Atomic MGET snapshot BEFORE the simulation / fresh reads are issued: undefined (⇒ must re-validate) when a lease is
    // held or the store is unreadable. Both only start after this resolves.
    fence = timed(metrics, "freshnessSnapshot", () => store.mget([gkey, key]))
      .then(([g, holder]) => (holder === null || holder === undefined ? Number(g ?? 0) : undefined), () => undefined);
    speculative = fence.then(() => timed(metrics, "speculativePreflight", spec.validate));
    // Known-stale speculation (lease held / unreadable snapshot) skips the pre-lease wave: the stale path re-validates.
    pre = fence.then(g => g === undefined ? undefined
      : (() => { const at = Date.now(); return timed(metrics, "preLeaseRecheck", spec.freshReads).then(facts => ({ at, facts })); })());
    void speculative.catch(() => undefined); void pre.catch(() => undefined);
  }
  const admission = timed(metrics, "admissionWall", () => admitRelay(op, metrics));
  const [a, s, r] = await timed(metrics, "admissionSimulationWall", () => Promise.allSettled([admission, speculative, pre]));
  // Admission has priority even when speculation fails first: an auth error is reported as such.
  if (a.status === "rejected") throw notSent(a.reason);
  if (s.status === "rejected") throw notSent(s.reason);
  if (r.status === "rejected") throw notSent(r.reason);
  const deadline = Date.now() + 5000;
  let waited = false;
  while (!await timed(metrics, "leaseAcquire", () => store.setNX(key, tag, 90))) {
    waited = true;
    if (Date.now() >= deadline) throw Object.assign(new Error("sender already confirming; no submission"), { notSent: true });
    await timed(metrics, "leaseQueueWait", () => new Promise(resolve => setTimeout(resolve, 25)));
  }
  let release = true;
  try {
    // Plain relay: never reuse authentication/session state across a queued wait (the spec path re-admits when stale).
    if (waited && !spec) await timed(metrics, "admissionWall", () => admitRelay(op, metrics));
    let value: T;
    if (spec) {
      const g0 = await fence, early = (r as PromiseFulfilledResult<{ at: number; facts: FreshFacts } | undefined>).value;
      // Fence (generation fetch-add; a store failure is before any nonce/sign/send ⇒ notSent) ∥ revoke marker read.
      const [before, marker] = await timed(metrics, "leaseGeneration", () => Promise.all([
        store.nonceAlloc(gkey, `${gkey}:holes`, 0, GEN_TTL_SEC).catch(e => { throw notSent(e); }),
        store.mget([revokeMarkerKey(op.sender), banKey(op.sender)]).then(([m, b]) => (m !== null && m !== undefined) || (b !== null && b !== undefined), () => undefined),
      ]));
      if (marker === true) throw revoked();
      const stale = waited || g0 === undefined || !early || before !== g0 || marker === undefined;
      metrics?.add("speculationStale", stale ? 1 : 0);
      value = await timed(metrics, "relayCoreWall", async () => {
        if (stale) {
          // Full stale path: never reuse authentication/session state or the speculative simulation.
          await timed(metrics, "admissionWall", () => admitRelay(op, metrics));
          const v = await timed(metrics, "resimulateUnderLease", spec.validate);
          const fresh = timed(metrics, "leaseRecheck", async () => spec.underLease(v, await spec.freshReads()));
          void fresh.catch(() => undefined);
          return spec.commit(v, fresh);
        }
        const v = (s as PromiseFulfilledResult<V>).value;
        const aged = Date.now() - early.at > PRE_LEASE_MAX_AGE_MS;
        metrics?.add("preLeaseAgeCap", aged ? 1 : 0);
        const fresh = timed(metrics, "leaseRecheck", async () => spec.underLease(v, aged ? await spec.freshReads() : early.facts));
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
