import "server-only";
/** F-02 admission. Exact signature validation/execution remains mandatory in fastRelay after these checks. */
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { readSession } from "@disciple/session-keys";
import { ACTIVE_CHAIN, DEPLOYMENTS, robinhoodTestnet } from "../chains";
import { accountCalls } from "../aa/gasPolicy";
import { sessionPolicyFor } from "../aa/oneTap";
import type { UserOp } from "../aa/core";
import { selfBundlerMode } from "../aa/sponsorshipMode";
import { chainGradReads } from "./gradBuy";
import { checkSponsoredCalls } from "./gasSponsorship";
import { kv } from "./kv";
import { ImmutableRelayCache, type RelayMetrics } from "./relayMetrics";
export const admissionImmutableCache = new ImmutableRelayCache();
const timed = <T>(m: RelayMetrics | undefined, stage: string, task: () => Promise<T>) => m ? m.span(stage, task) : task();

const pc = createPublicClient({ chain: robinhoodTestnet, transport: http(undefined, { fetchOptions: { keepalive: true }, timeout: 5000, retryCount: 0 }) });
const abi = parseAbi(["function verifiedUntil(address) view returns(uint64)", "function moduleId() view returns(string)", "function paymaster() view returns(address)"]);
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
export async function admitRelay(op: UserOp, metrics?: RelayMetrics) {
  requireSelfBundlerMode();
  const entity = sessionEntity(op), policy = sessionPolicyFor(46630);
  if (!policy) throw new Error("session policy unavailable");
  const calls = accountCalls(op.callData);
  if (!calls?.length || calls.some(c => c.to.toLowerCase() === op.sender.toLowerCase())) throw new Error("trade calls only");
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
/** One in-flight paid bundle per sender. Ambiguous sends quarantine until TTL rather than retrying. */
export async function lockedRelay<T>(op: UserOp, send: () => Promise<T>, metrics?: RelayMetrics, confirmed?: (value: T) => void): Promise<T> {
  await timed(metrics, "admissionWall", () => admitRelay(op, metrics)).catch(e => { throw Object.assign(e as Error, { notSent: true }); });
  const store = kv(), key = `relay:pending:${op.sender.toLowerCase()}`, tag = crypto.randomUUID();
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
    const value = await timed(metrics, "relayCoreWall", send);
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
