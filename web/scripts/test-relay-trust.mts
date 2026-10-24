// Unit tests for the fast-relay anti-grief ledger (lib/server/relayTrust): periodic re-simulation of trusted senders,
// escalating strikes on reverted handleOps, and the honest one-tap path staying simulation-free.
//   pnpm test:relay-trust   (pure: fake clock, no RPC, no live endpoint)
import { test } from "node:test";
import assert from "node:assert/strict";
import { RESIM_EVERY, RESIM_MS, SenderTrust, STRIKE_BASE_MS, STRIKE_DECAY_MS, STRIKE_MAX_MS, TRUST_TTL, type PersistedTrust, type TrustStore } from "../lib/server/relayTrust";

const A = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const BAL = BigInt(10) ** BigInt(18), PREFUND = BigInt(10) ** BigInt(14);
function setup() { let t = 1_000_000; const tr = new SenderTrust(() => t); return { tr, adv: (ms: number) => { t += ms; }, now: () => t }; }

test("unknown sender is simulated; first clean prime (login warm / deploy) enables the fast path", () => {
  const { tr } = setup();
  assert.equal(tr.check(A, PREFUND), "unknown");
  tr.prime(A, BAL);
  assert.equal(tr.check(A.toLowerCase(), PREFUND), null);
  assert.equal(tr.check(A, BAL + BigInt(1)), "low-balance");
});

test("honest one-tap: ≤ 1 simulation per RESIM_EVERY trades / RESIM_MS, everything else fast", () => {
  const { tr, adv } = setup();
  tr.prime(A, BAL);
  let sims = 0;
  for (let i = 0; i < 100; i++) {
    adv(1_500); // a trade every 1.5 s, balance refreshed after each (fastRelay re-primes in the background)
    const fast = tr.check(A, PREFUND) === null;
    if (!fast) { sims++; tr.simulated(A); }
    tr.succeeded(A, fast, PREFUND); tr.prime(A, BAL);
  }
  assert.ok(sims >= Math.floor(100 / (RESIM_EVERY + 1)) && sims <= Math.ceil(100 / RESIM_EVERY) + 1, `sims=${sims}`);
  // idle longer than RESIM_MS ⇒ the next trade is re-simulated once, then fast again
  const t2 = setup(); t2.tr.prime(A, BAL);
  t2.adv(RESIM_MS - 1_000); t2.tr.prime(A, BAL); assert.equal(t2.tr.check(A, PREFUND), null);
  t2.adv(1_000); t2.tr.prime(A, BAL); assert.equal(t2.tr.check(A, PREFUND), "resim-time");
  t2.tr.simulated(A); assert.equal(t2.tr.check(A, PREFUND), null);
});

test("Nth fast op forces a re-simulation", () => {
  const { tr } = setup();
  tr.prime(A, BAL);
  for (let i = 0; i < RESIM_EVERY; i++) { assert.equal(tr.check(A, PREFUND), null); tr.succeeded(A, true, BigInt(0)); }
  assert.equal(tr.check(A, PREFUND), "resim-ops");
  tr.simulated(A); assert.equal(tr.check(A, PREFUND), null);
});

test("stale balance (> TRUST_TTL) is simulated", () => {
  const { tr, adv } = setup();
  tr.prime(A, BAL); adv(TRUST_TTL);
  assert.equal(tr.check(A, PREFUND), "stale-balance");
});

test("revert ⇒ strike shorter than the old 10 min, escalating 2x per repeat, capped, decays after a clean day", () => {
  const { tr, adv } = setup();
  tr.prime(A, BAL);
  assert.equal(tr.strike(A), STRIKE_BASE_MS);
  assert.ok(STRIKE_BASE_MS < 10 * 60_000);
  assert.equal(tr.check(A, PREFUND), "strike");
  const lens: number[] = [STRIKE_BASE_MS];
  for (let i = 0; i < 8; i++) { adv(lens[lens.length - 1]); tr.simulated(A); lens.push(tr.strike(A)); }
  assert.deepEqual(lens.slice(0, 5), [1, 2, 4, 8, 16].map((x) => Math.min(STRIKE_MAX_MS, x * STRIKE_BASE_MS)));
  assert.equal(lens[lens.length - 1], STRIKE_MAX_MS);
  adv(STRIKE_DECAY_MS + 1);
  assert.equal(tr.strike(A), STRIKE_BASE_MS, "strike count decays");
});

test("after a strike the fast path needs a passing simulation (a balance refresh is not enough)", () => {
  const { tr, adv } = setup();
  tr.prime(A, BAL);
  const ms = tr.strike(A);
  adv(ms - 1); tr.prime(A, BAL); assert.equal(tr.check(A, PREFUND), "strike");
  adv(1); tr.prime(A, BAL); assert.equal(tr.check(A, PREFUND), "unverified");
  tr.simulated(A); assert.equal(tr.check(A, PREFUND), null);
  // a never-primed sender that got struck stays unverified after its first prime
  const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; adv(1);
  tr.strike(B); adv(STRIKE_BASE_MS); tr.prime(B, BAL); assert.equal(tr.check(B, PREFUND), "unverified");
});

test("griefer budget: reverted fast-path txs per hour are bounded by the escalating backoff", () => {
  const { tr, adv, now } = setup();
  tr.prime(A, BAL);
  const end = now() + 6 * 60 * 60_000; let reverts = 0;
  while (now() < end) {
    // attacker: pass one simulation with a good op, then send a bad op on the fast path
    if (tr.check(A, PREFUND) !== null) { tr.simulated(A); tr.prime(A, BAL); }
    if (tr.check(A, PREFUND) === null) { reverts++; tr.strike(A); }
    adv(1_000);
  }
  // old policy (10 min strike, no escalation): 36 in 6 h. New: 2+4+8+16+32+60+60+60+60… min
  assert.ok(reverts <= 10, `reverts=${reverts}`);
});

test("successful sends debit the cached balance until the next refresh", () => {
  const { tr } = setup();
  tr.prime(A, PREFUND * BigInt(2));
  tr.succeeded(A, true, PREFUND); assert.equal(tr.check(A, PREFUND), null);
  tr.succeeded(A, true, PREFUND); assert.equal(tr.check(A, PREFUND), "low-balance");
});

// AUDIT Low: shared / durable trust state (TrustStore → KV). Strikes and verification survive a restart / cold instance.
function memStore() {
  const rec = new Map<string, PersistedTrust>(), first = new Set<string>();
  const store: TrustStore = {
    async load(s) { return rec.get(s) ?? null; },
    async save(s, p) { rec.set(s, { ...p }); },
    async claimFirstPrime(s) { if (first.has(s)) return false; first.add(s); return true; },
  };
  return { store, rec };
}
test("shared store: first-prime grant happens once globally, not once per (cold) instance", async () => {
  let t = 1_000_000; const now = () => t; const { store } = memStore();
  const a = new SenderTrust(now, store);
  assert.equal(a.check(A, PREFUND), "unknown");
  await a.primeShared(A, BAL);
  assert.equal(a.check(A, PREFUND), null);                  // honest first login stays fast
  await a.flush();
  // restart / new lambda: the verification is loaded, not re-granted from a balance read
  const b = new SenderTrust(now, store);
  assert.equal(b.check(A, PREFUND), "unknown");             // not hydrated yet ⇒ simulate
  await b.primeShared(A, BAL);
  assert.equal(b.check(A, PREFUND), null);
  // a sender whose record was lost but whose grant was used is NOT verified again by a balance read
  const B = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb";
  await a.primeShared(B, BAL); a.strike(B); await a.flush();
  const c = new SenderTrust(now, store);
  await c.primeShared(B, BAL);
  assert.equal(c.check(B, PREFUND), "strike");               // strike crosses instances
  t += STRIKE_MAX_MS + 1;
  await c.primeShared(B, BAL);
  assert.equal(c.check(B, PREFUND), "unverified");           // and still needs a passing simulation afterwards
  c.simulated(B); await c.flush();
  assert.equal(c.check(B, PREFUND), null);
});
test("shared store errors fail safe (simulate), never grant trust", async () => {
  const bad: TrustStore = { load: async () => { throw new Error("kv down"); }, save: async () => { throw new Error("kv down"); }, claimFirstPrime: async () => { throw new Error("kv down"); } };
  const tr = new SenderTrust(() => 1_000_000, bad);
  await tr.primeShared(A, BAL);
  assert.notEqual(tr.check(A, PREFUND), null);
  tr.simulated(A); await tr.flush();                        // write errors are swallowed
});

// ---- AUDIT #145 L-B: at most one unsimulated (fast-path) op in flight per sender ----
import { FastInflight } from "../lib/server/relayTrust";
function memLease() {
  const m = new Map<string, string>();
  return { m, setNX: async (k: string, v: string) => (m.has(k) ? false : (m.set(k, v), true)), del: async (...ks: string[]) => { for (const k of ks) m.delete(k); } };
}
test("L-B: a 2nd concurrent fast op for the same sender is refused (⇒ simulated); released ⇒ fast again", async () => {
  const g = new FastInflight();
  const r1 = await g.acquire(A);
  assert.ok(r1);
  assert.equal(await g.acquire(A.toLowerCase()), null);   // same sender, any case
  assert.ok(await g.acquire("0x" + "bb".repeat(20)));       // other senders unaffected
  await r1!(); await r1!();                                  // idempotent release
  assert.ok(await g.acquire(A));
});
test("L-B: shared lease across instances (SET NX); store error ⇒ refuse (simulate, fail-safe)", async () => {
  const st = memLease();
  const i1 = new FastInflight(st), i2 = new FastInflight(st);
  const r = await i1.acquire(A);
  assert.ok(r);
  assert.equal(await i2.acquire(A), null);                   // another instance sees the lease
  await r!();
  assert.equal(st.m.size, 0);
  const r2 = await i2.acquire(A);
  assert.ok(r2);
  assert.equal(await i1.acquire(A), null);
  await r2!();
  // a failed setNX releases the local hold too, so the sender isn't stuck on this instance
  const bad = new FastInflight({ setNX: async () => { throw new Error("kv down"); }, del: async () => undefined });
  assert.equal(await bad.acquire(A), null);
  const flaky = { ...memLease() }; let fail = true;
  const f = new FastInflight({ setNX: async (k, v) => (fail ? (fail = false, Promise.reject(new Error("x"))) : flaky.setNX(k, v)), del: flaky.del });
  assert.equal(await f.acquire(A), null);
  assert.ok(await f.acquire(A));
});
