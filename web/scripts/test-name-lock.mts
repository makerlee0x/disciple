/**
 * Off-chain name+ticker lock (lib/nameLock): key normalization, claim on ascend, launch refuse,
 * grandfathering, drop-back timer with reset + final check, mainnet-only gate, slipped-in copies.
 * Run: npm run test:name-lock
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAINNET_CHAIN_ID, TESTNET_CHAIN_ID } from "../lib/networkConfig";
import {
  NAME_LOCK_DROP_MS,
  NAME_LOCK_DROP_USD,
  NAME_LOCK_TAKEN_MSG,
  applyMcapTick,
  claimOnAscend,
  fetchNameLock,
  isSlippedInCopy,
  laterThan,
  launchBlockedByLock,
  nameLockEnforced,
  nameLockKey,
  normalizeLockPart,
  observeLockMcap,
} from "../lib/nameLock";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const pos = (block: number, logIndex = 0) => ({ block, logIndex });

test("normalize: trim + ASCII lowercase only; inner spaces and non-ASCII stay exact", () => {
  assert.equal(normalizeLockPart("  PePe  "), "pepe");
  assert.equal(normalizeLockPart("PEPE"), "pepe");
  assert.equal(normalizeLockPart("Pe pe"), "pe pe");
  assert.equal(normalizeLockPart("Pe  pe"), "pe  pe"); // inner spaces must match exactly
  assert.equal(normalizeLockPart("Café"), "café");
  assert.equal(normalizeLockPart("CAFE"), "cafe");
  assert.notEqual(normalizeLockPart("Café"), normalizeLockPart("Cafe"));
  // non-ASCII letters are not folded / lowercased by this helper
  assert.equal(normalizeLockPart("İSTANBUL"), "İstanbul".replace("s", "s")); // İ stays İ, S→s, T→t...
  assert.equal(normalizeLockPart("İSTANBUL"), "İstanbul");
  assert.notEqual(normalizeLockPart("İSTANBUL"), "istanbul");
});

test("key is name+ticker only (image is not in the key); share name or ticker but not both", () => {
  assert.equal(nameLockKey("Moon Falcon", "MOON"), nameLockKey(" moon falcon ", "moon"));
  assert.notEqual(nameLockKey("Moon Falcon", "MOON"), nameLockKey("Moon Falcon", "FALC")); // same name, different ticker
  assert.notEqual(nameLockKey("Moon Falcon", "MOON"), nameLockKey("Sun Falcon", "MOON")); // same ticker, different name
  assert.equal(nameLockKey("Moon", "PEPE"), nameLockKey("Moon", "PEPE",));
  // different images would not matter: there is no image argument
  assert.equal(nameLockKey("Moon", "PEPE"), nameLockKey("Moon", "pepe"));
});

test("mainnet only: testnet (and other chains) do not enforce", () => {
  assert.equal(nameLockEnforced(MAINNET_CHAIN_ID), true);
  assert.equal(nameLockEnforced(TESTNET_CHAIN_ID), false);
  assert.equal(nameLockEnforced(31337), false);
  const lock = claimOnAscend(null, A, pos(10), 1_000).lock;
  assert.equal(launchBlockedByLock({ enforced: false, lock }).blocked, false);
  assert.equal(launchBlockedByLock({ enforced: nameLockEnforced(TESTNET_CHAIN_ID), lock }).blocked, false);
});

test("claim on ascend: first rocket wins; same rocket is idempotent; another holder is a no-op", () => {
  const first = claimOnAscend(null, A, pos(10, 1), 1_000);
  assert.equal(first.wrote, true);
  assert.equal(first.lock.token, A);
  assert.equal(first.lock.claimedBlock, 10);
  assert.equal(first.lock.belowSince, null);

  const again = claimOnAscend(first.lock, A, pos(11, 0), 2_000);
  assert.equal(again.wrote, false);
  assert.equal(again.lock.claimedAt, 1_000);
  assert.equal(again.lock.token, A);

  const other = claimOnAscend(first.lock, B, pos(12, 0), 3_000);
  assert.equal(other.wrote, false);
  assert.equal(other.lock.token, A);
  assert.equal(other.lock.claimedAt, 1_000);
});

test("launch form refuses a taken name+ticker after a claim, with the draft message", () => {
  const lock = claimOnAscend(null, A, pos(10), 1_000).lock;
  const hit = launchBlockedByLock({ enforced: true, lock });
  assert.equal(hit.blocked, true);
  assert.equal(hit.reason, NAME_LOCK_TAKEN_MSG);
  // the holder itself is not blocked (e.g. a re-check)
  assert.equal(launchBlockedByLock({ enforced: true, lock, token: A }).blocked, false);
  assert.equal(launchBlockedByLock({ enforced: true, lock: null }).blocked, false);
});

test("copies live before the original ascends are grandfathered: not blocked, not flagged, do not take the lock", () => {
  // B launched at block 5, A ascends at block 10 and takes the lock
  const lock = claimOnAscend(null, A, pos(10, 0), 5_000).lock;
  assert.equal(isSlippedInCopy({ token: B, launched: pos(5, 0), lock }), false);
  // B may later ascend: claim is a no-op, A still holds
  const bAscend = claimOnAscend(lock, B, pos(20, 0), 9_000);
  assert.equal(bAscend.wrote, false);
  assert.equal(bAscend.lock.token, A);
  // B is still not a slipped-in copy
  assert.equal(isSlippedInCopy({ token: B, launched: pos(5, 0), lock: bAscend.lock }), false);
});

test("a launch after the claim is a slipped-in copy and is refused", () => {
  const lock = claimOnAscend(null, A, pos(10, 2), 5_000).lock;
  assert.equal(isSlippedInCopy({ token: B, launched: pos(10, 3), lock }), true, "later log in the same block");
  assert.equal(isSlippedInCopy({ token: B, launched: pos(11, 0), lock }), true);
  assert.equal(isSlippedInCopy({ token: B, launched: pos(10, 1), lock }), false, "earlier log in the same block is grandfathered");
  assert.equal(isSlippedInCopy({ token: A, launched: pos(11, 0), lock }), false, "the holder is never a copy");
  assert.equal(isSlippedInCopy({ token: B, launched: pos(11, 0), lock: null }), false);
  assert.equal(laterThan(pos(10, 3), pos(10, 2)), true);
});

test("drop-back: first reading below $33,333 starts the timer; at or above resets it", () => {
  const t0 = 1_000_000;
  const started = observeLockMcap(null, NAME_LOCK_DROP_USD - 1, t0);
  assert.equal(started.belowSince, t0);
  assert.equal(started.mayRelease, false);

  const still = observeLockMcap(t0, 10_000, t0 + NAME_LOCK_DROP_MS - 1);
  assert.equal(still.belowSince, t0);
  assert.equal(still.mayRelease, false);

  const reset = observeLockMcap(t0, NAME_LOCK_DROP_USD, t0 + NAME_LOCK_DROP_MS);
  assert.equal(reset.belowSince, null);
  assert.equal(reset.mayRelease, false);

  const resetAbove = observeLockMcap(t0, NAME_LOCK_DROP_USD + 1, t0 + 1000);
  assert.equal(resetAbove.belowSince, null);

  const ready = observeLockMcap(t0, 1_000, t0 + NAME_LOCK_DROP_MS);
  assert.equal(ready.belowSince, t0);
  assert.equal(ready.mayRelease, true);
});

test("drop-back: key frees only after 24h continuously below AND a final check still below", () => {
  const lock = { token: A, claimedAt: 0, claimedBlock: 10, claimedLogIndex: 0, belowSince: 1_000 as number | null };
  const tReady = 1_000 + NAME_LOCK_DROP_MS;

  // not yet 24h
  const early = applyMcapTick(lock, 1_000, 1_000 + NAME_LOCK_DROP_MS - 1);
  assert.equal(early.released, false);
  assert.equal(early.lock?.belowSince, 1_000);

  // 24h elapsed, but final check is back at/above the floor → timer resets, no release
  const bounced = applyMcapTick(lock, 1_000, tReady, NAME_LOCK_DROP_USD);
  assert.equal(bounced.released, false);
  assert.equal(bounced.lock?.belowSince, null);

  // 24h elapsed, final check still below → release
  const freed = applyMcapTick(lock, 1_000, tReady, 2_000);
  assert.equal(freed.released, true);
  assert.equal(freed.lock, null);

  // first reading already at/above: timer clear, no release
  const high = applyMcapTick({ ...lock, belowSince: 1_000 }, NAME_LOCK_DROP_USD, tReady);
  assert.equal(high.released, false);
  assert.equal(high.lock?.belowSince, null);
});

test("fetchNameLock: parses the API body; errors and a bad shape return null", async () => {
  const ok = (async () => ({ ok: true, json: async () => ({ enforced: true, available: false, reason: NAME_LOCK_TAKEN_MSG }) })) as never;
  assert.deepEqual(await fetchNameLock("Moon", "MOON", ok), { enforced: true, available: false, reason: NAME_LOCK_TAKEN_MSG });
  assert.equal(await fetchNameLock("Moon", "MOON", (async () => ({ ok: false, json: async () => ({}) })) as never), null);
  assert.equal(await fetchNameLock("Moon", "MOON", (async () => { throw new Error("down"); }) as never), null);
  assert.equal(await fetchNameLock("Moon", "MOON", (async () => ({ ok: true, json: async () => ({ enforced: true }) })) as never), null);
});
