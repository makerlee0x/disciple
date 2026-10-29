/**
 * Anti-grief trust ledger for the fast relay path (lib/server/fastRelay). Pure (no RPC, injectable clock) so it is
 * unit-testable.
 *
 * Who pays (EntryPoint v0.7): an op whose EXECUTION reverts still lets handleOps succeed and the account reimburses the
 * relayer; an op whose VALIDATION fails (bad sig, no prefund, bad nonce, …) reverts handleOps and the RELAYER eats the
 * tx. The fast path skips the eth_call simulation, so a trusted sender could otherwise grief with one reverted tx per
 * strike window. Policy:
 *  - fast path only with a fresh (≤ TRUST_TTL) balance covering the op's max prefund, outside any strike, and
 *    VERIFIED recently: re-simulate every RESIM_EVERY fast ops or RESIM_MS since the last verification;
 *  - a reverted handleOps = strike with ESCALATING backoff (STRIKE_BASE_MS × 2^(n-1), capped at STRIKE_MAX_MS; the
 *    count decays after STRIKE_DECAY_MS clean). During a strike every op is simulated; after it, the sender gets the
 *    fast path back only once a simulation has passed again (a balance refresh alone doesn't restore trust).
 * Honest one-tap users: verified at the first prime (login warm / first deploy op), then ≤ 1 eth_call per
 * RESIM_EVERY trades or RESIM_MS — the rest stay one round trip.
 *
 * AUDIT Low (shared state): with a TrustStore (lib/server/relayTrustStore → shared KV) the verification + strike state
 * survives restarts / cold serverless instances and is shared across them: primeShared() hydrates it before the first
 * check on an instance, and the one-time "fresh sender ⇒ verified at first prime" grant is taken at most ONCE per
 * sender globally (SET NX), not once per instance. Without a store (tests, local) it behaves exactly as before.
 */
export const TRUST_TTL = 60_000;
export const RESIM_EVERY = 16;
export const RESIM_MS = 5 * 60_000;
export const STRIKE_BASE_MS = 2 * 60_000;
export const STRIKE_MAX_MS = 60 * 60_000;
export const STRIKE_DECAY_MS = 24 * 60 * 60_000;
const MAX_ENTRIES = 50_000;

export type TrustEntry = {
  bal: bigint; at: number;           // cached balance and when it was read
  verifiedAt: number;                // last passed simulation (or first clean prime); 0 = never
  fastOps: number;                   // fast-path ops since verifiedAt
  strikes: number; lastStrikeAt: number; strikeUntil: number;
};
/** The durable part of a TrustEntry (balances are re-read, never persisted). */
export type PersistedTrust = Pick<TrustEntry, "verifiedAt" | "fastOps" | "strikes" | "lastStrikeAt" | "strikeUntil">;
export interface TrustStore {
  load(sender: string): Promise<PersistedTrust | null>;
  save(sender: string, p: PersistedTrust): Promise<void>;
  /** true exactly once per sender across all instances (the first-prime grant); false if it was already taken. */
  claimFirstPrime(sender: string): Promise<boolean>;
}
export const persistedOf = (e: TrustEntry): PersistedTrust =>
  ({ verifiedAt: e.verifiedAt, fastOps: e.fastOps, strikes: e.strikes, lastStrikeAt: e.lastStrikeAt, strikeUntil: e.strikeUntil });
export type TrustReason = "unknown" | "stale-balance" | "strike" | "unverified" | "resim-ops" | "resim-time" | "low-balance";

export class SenderTrust {
  private m = new Map<string, TrustEntry>();
  private hydrated = new Set<string>();
  private pending = new Set<Promise<unknown>>();
  constructor(private now: () => number = Date.now, private store?: TrustStore) {}
  /** Write-through to the store (no-op without one). Errors are swallowed: the in-memory state stays authoritative. */
  private persist(sender: string) {
    if (!this.store) return;
    const e = this.m.get(sender.toLowerCase()); if (!e) return;
    const p = this.store.save(sender.toLowerCase(), persistedOf(e)).catch(() => undefined);
    this.pending.add(p); void p.finally(() => this.pending.delete(p));
  }
  /** Await pending store writes (call before a serverless response returns, so a strike isn't lost). */
  async flush() { await Promise.all([...this.pending]); }
  /**
   * Balance read with shared state (use instead of prime() when a store is set). First call per sender on this instance
   * loads the persisted entry; the stricter of memory/store wins (later strike, earlier-expiring trust). A sender with no
   * persisted record is verified at its first prime only if it wins the global SET NX — a cold instance never grants it
   * again. Store errors ⇒ not verified (the op is simulated: fail safe).
   */
  async primeShared(sender: string, bal: bigint) {
    if (!this.store) return this.prime(sender, bal);
    const k = sender.toLowerCase();
    if (!this.hydrated.has(k)) {
      let p: PersistedTrust | null | undefined;
      try { p = await this.store.load(k); } catch { p = undefined; }
      const had = this.m.has(k), e = this.entry(k);
      if (p) {
        e.strikes = Math.max(e.strikes, p.strikes); e.lastStrikeAt = Math.max(e.lastStrikeAt, p.lastStrikeAt);
        e.strikeUntil = Math.max(e.strikeUntil, p.strikeUntil); e.fastOps = Math.max(e.fastOps, p.fastOps);
        e.verifiedAt = had ? Math.min(e.verifiedAt, p.verifiedAt) : p.verifiedAt;
      } else if (p === null && !had) {
        let first = false; try { first = await this.store.claimFirstPrime(k); } catch { first = false; }
        if (first) e.verifiedAt = this.now();
      }
      if (p !== undefined) this.hydrated.add(k);
      if (this.hydrated.size > MAX_ENTRIES) this.hydrated.delete(this.hydrated.values().next().value!);
    }
    const e = this.entry(k);
    e.bal = bal; e.at = this.now();
    this.persist(k);
  }
  get(sender: string) { return this.m.get(sender.toLowerCase()); }
  private entry(sender: string): TrustEntry {
    const k = sender.toLowerCase();
    let e = this.m.get(k);
    if (!e) {
      if (this.m.size >= MAX_ENTRIES) this.m.delete(this.m.keys().next().value!); // bounded memory (oldest first)
      e = { bal: BigInt(0), at: 0, verifiedAt: 0, fastOps: 0, strikes: 0, lastStrikeAt: 0, strikeUntil: 0 }; this.m.set(k, e); }
    return e;
  }
  /** Balance read. A brand-new, never-struck sender counts as verified at its first prime (login warm / deploy op). */
  prime(sender: string, bal: bigint) {
    const fresh = !this.m.has(sender.toLowerCase());
    const e = this.entry(sender);
    e.bal = bal; e.at = this.now();
    if (fresh) e.verifiedAt = e.at;
  }
  /** A simulation (eth_call of handleOps) passed: restore / renew the fast path. */
  simulated(sender: string) { const e = this.entry(sender); e.verifiedAt = this.now(); e.fastOps = 0; this.persist(sender); }
  /** The relayer's handleOps reverted (validation failure the relayer paid for): escalating strike. Returns its length. */
  strike(sender: string): number {
    const e = this.entry(sender), t = this.now();
    if (e.lastStrikeAt && t - e.lastStrikeAt > STRIKE_DECAY_MS) e.strikes = 0;
    e.strikes++; e.lastStrikeAt = t;
    const ms = Math.min(STRIKE_MAX_MS, STRIKE_BASE_MS * 2 ** Math.min(e.strikes - 1, 20));
    e.strikeUntil = t + ms; e.verifiedAt = 0; e.fastOps = 0;
    this.persist(sender);
    return ms;
  }
  /** A successful send: count fast ops, and debit the max prefund until the next balance refresh (conservative). */
  succeeded(sender: string, fast: boolean, prefund: bigint) {
    const e = this.m.get(sender.toLowerCase()); if (!e) return;
    if (fast) e.fastOps++;
    e.bal -= prefund;
    if (fast) this.persist(sender);
  }
  /** null ⇒ the op may skip simulation; else why it must be simulated. */
  check(sender: string, prefund: bigint): TrustReason | null {
    const k = sender.toLowerCase(), e = this.m.get(k), t = this.now();
    if (!e) return "unknown";
    if (this.store && !this.hydrated.has(k)) return "unknown";   // shared state not loaded on this instance yet
    if (t < e.strikeUntil) return "strike";
    if (!e.verifiedAt || e.verifiedAt < e.strikeUntil) return "unverified";
    if (t >= e.at + TRUST_TTL) return "stale-balance";
    if (e.fastOps >= RESIM_EVERY) return "resim-ops";
    if (t - e.verifiedAt >= RESIM_MS) return "resim-time";
    if (e.bal < prefund) return "low-balance";
    return null;
  }
}

/**
 * AUDIT #145 L-B: at most ONE unsimulated (fast-path) op in flight per sender. Concurrent junk ops naming a trusted
 * sender all passed trusted() before the first strike landed (each signed + sent, charged to the victim). acquire()
 * returns a release fn, or null when the sender already has a fast op in flight ⇒ the caller simulates instead.
 * In-memory per instance, plus (optional) a shared SET NX lease with a TTL across instances; a store error ⇒ null
 * (simulate: fail-safe, only slower).
 * AUDIT #145 Info: each acquire stores a random owner token (crypto.randomUUID) for the sender, locally and as the
 * lease value. release() deletes only while the stored token is still ours (local check + atomic compare-and-delete in
 * the store), so a stale release (e.g. after the TTL lapsed and another op/instance took the slot) never frees
 * someone else's slot.
 */
export interface LeaseStore { setNX(k: string, v: string, ttlSec?: number): Promise<boolean>; delIfEq(k: string, v: string): Promise<boolean> }
export class FastInflight {
  private held = new Map<string, string>();   // sender → owner token
  constructor(private store?: LeaseStore, private ttlSec = 60) {}
  async acquire(sender: string): Promise<(() => Promise<void>) | null> {
    const k = sender.toLowerCase();
    if (this.held.has(k)) return null;
    const token = globalThis.crypto.randomUUID();
    this.held.set(k, token);
    if (this.store && !(await this.store.setNX(`relay:fast:${k}`, token, this.ttlSec).catch(() => false))) {
      if (this.held.get(k) === token) this.held.delete(k);
      return null;
    }
    let done = false;
    return async () => {
      if (done) return; done = true;
      if (this.held.get(k) === token) this.held.delete(k);
      await this.store?.delIfEq(`relay:fast:${k}`, token).catch(() => false);
    };
  }
}
