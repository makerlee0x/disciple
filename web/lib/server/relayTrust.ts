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
export type TrustReason = "unknown" | "stale-balance" | "strike" | "unverified" | "resim-ops" | "resim-time" | "low-balance";

export class SenderTrust {
  private m = new Map<string, TrustEntry>();
  constructor(private now: () => number = Date.now) {}
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
  simulated(sender: string) { const e = this.entry(sender); e.verifiedAt = this.now(); e.fastOps = 0; }
  /** The relayer's handleOps reverted (validation failure the relayer paid for): escalating strike. Returns its length. */
  strike(sender: string): number {
    const e = this.entry(sender), t = this.now();
    if (e.lastStrikeAt && t - e.lastStrikeAt > STRIKE_DECAY_MS) e.strikes = 0;
    e.strikes++; e.lastStrikeAt = t;
    const ms = Math.min(STRIKE_MAX_MS, STRIKE_BASE_MS * 2 ** Math.min(e.strikes - 1, 20));
    e.strikeUntil = t + ms; e.verifiedAt = 0; e.fastOps = 0;
    return ms;
  }
  /** A successful send: count fast ops, and debit the max prefund until the next balance refresh (conservative). */
  succeeded(sender: string, fast: boolean, prefund: bigint) {
    const e = this.m.get(sender.toLowerCase()); if (!e) return;
    if (fast) e.fastOps++;
    e.bal -= prefund;
  }
  /** null ⇒ the op may skip simulation; else why it must be simulated. */
  check(sender: string, prefund: bigint): TrustReason | null {
    const e = this.m.get(sender.toLowerCase()), t = this.now();
    if (!e) return "unknown";
    if (t < e.strikeUntil) return "strike";
    if (!e.verifiedAt || e.verifiedAt < e.strikeUntil) return "unverified";
    if (t >= e.at + TRUST_TTL) return "stale-balance";
    if (e.fastOps >= RESIM_EVERY) return "resim-ops";
    if (t - e.verifiedAt >= RESIM_MS) return "resim-time";
    if (e.bal < prefund) return "low-balance";
    return null;
  }
}
