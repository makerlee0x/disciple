// Cross-instance relayer nonces (lib/server/relayerNonce.SharedNonceCursor over lib/server/kv.nonceAlloc).
// Mocked sequencer, N "instances" (separate cursors), many overlapping relays.  pnpm test:relayer-nonce-shared
import { test } from "node:test";
import assert from "node:assert/strict";
import { RelayerNonceCursor, SharedNonceCursor, chainNonceHint, sendWithCursor, type NonceCursor, type NonceStore } from "../lib/server/relayerNonce";

process.env.KV_LOCAL_FILE = `/tmp/disciple-kv-nonce-shared-${process.pid}.json`;
delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.KV_REST_API_URL;
const { kv } = await import("../lib/server/kv");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rnd = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));
const nodeErr = (m: string) => Object.assign(new Error(m), { code: -32000 });

/**
 * Mock Arbitrum sequencer for ONE EOA: nonce == state ⇒ accepted; < state ⇒ "nonce too low … state: N"; > state ⇒ held
 * up to holdMs for the gap to fill, then "nonce too high". A lagging RPC serves the pending count from lagMs ago.
 */
function mockNode(o: { holdMs?: number; lagMs?: number; rejectOnce?: Set<string> } = {}) {
  let state = 100;
  const hist: { t: number; n: number }[] = [{ t: Date.now(), n: state }];
  const byNonce = new Map<number, string>(), accepted: string[] = [];
  const waiters = new Set<() => void>();
  let tooLow = 0, tooHigh = 0;
  const bump = () => { state++; hist.push({ t: Date.now(), n: state }); waiters.forEach((w) => w()); };
  return {
    get state() { return state; }, byNonce, accepted, stats: () => ({ tooLow, tooHigh }),
    pending: async () => { await sleep(rnd(1, 6)); const t = Date.now() - (o.lagMs ?? 0); let n = hist[0].n; for (const h of hist) if (h.t <= t) n = h.n; return n; },
    /** an outside writer on the same EOA (e.g. a pre-fix cron with viem's auto nonce) */
    external() { byNonce.set(state, "external"); bump(); },
    async send(op: string, nonce: number): Promise<string> {
      await sleep(rnd(0, 4));
      if (o.rejectOnce?.delete(op)) throw nodeErr("insufficient funds for gas * price + value");
      const deadline = Date.now() + (o.holdMs ?? 60);
      while (nonce > state && Date.now() < deadline) await new Promise<void>((r) => { const w = () => { waiters.delete(w); r(); }; waiters.add(w); setTimeout(w, 5); });
      if (nonce < state) { tooLow++; throw nodeErr(`nonce too low: address 0xce2b, tx: ${nonce} state: ${state}`); }
      if (nonce > state) { tooHigh++; throw nodeErr(`nonce too high: address 0xce2b, tx: ${nonce} state: ${state}`); }
      byNonce.set(nonce, op); accepted.push(op); bump();
      return `0x${nonce.toString(16)}`;
    },
  };
}
type Node = ReturnType<typeof mockNode>;

let seq = 0;
function kvStore(): NonceStore {
  const k = `relayer:nonce:test:${process.pid}:${seq++}`, h = `${k}:holes`, s = kv();
  return { alloc: (f) => s.nonceAlloc(k, h, f, 3600), release: (n) => s.nonceRelease(k, h, n, 3600), claim: (t, ttl) => s.setNX(`${k}:${t}`, "1", ttl) };
}

/** Fire `ops` overlapping relays round-robin over `instances` cursors; returns per-op outcome. */
async function storm(node: Node, cursors: NonceCursor[], ops: number, retries = 2) {
  const out = await Promise.all(Array.from({ length: ops }, async (_, i) => {
    await sleep(rnd(0, 25));
    const op = `op${i}`;
    try { await sendWithCursor(cursors[i % cursors.length], (n) => node.send(op, n), retries); return { op, ok: true }; }
    catch (e) { return { op, ok: false, err: (e as Error).message }; }
  }));
  return { ok: out.filter((x) => x.ok).length, failed: out.filter((x) => !x.ok), ...node.stats() };
}

test("hint: nitro / geth wording", () => {
  assert.equal(chainNonceHint(new Error("nonce too low: address 0xCE2B, tx: 18730 state: 18732")), 18732);
  assert.equal(chainNonceHint(new Error("nonce too low: next nonce 18732, tx nonce 18730")), 18732);
  assert.equal(chainNonceHint(Object.assign(new Error("x"), { cause: { details: "nonce too high: tx: 9 state: 7" } })), 7);
  assert.equal(chainNonceHint(new Error("already known")), undefined);
});

test("kv.nonceAlloc / nonceRelease (local backend): atomic counter, floor, rollback, holes, stale holes dropped", async () => {
  const s = kvStore();
  assert.deepEqual(await Promise.all([s.alloc(5), s.alloc(5), s.alloc(5)]).then((a) => a.sort()), [5, 6, 7]);
  assert.equal(await s.alloc(20), 20, "floor pulls the counter forward");
  assert.equal(await s.release(20), 1, "last one out ⇒ rollback"); assert.equal(await s.alloc(0), 20);
  await s.alloc(0);                       // 21 out
  assert.equal(await s.release(6), 2, "behind the counter ⇒ hole");
  assert.equal(await s.alloc(0), 6, "next alloc fills the hole first"); assert.equal(await s.alloc(0), 22);
  await s.release(7); assert.equal(await s.alloc(10), 23, "a hole below the floor is stale (chain moved on) ⇒ dropped");
});

test("BEFORE: one per-process cursor per instance (old code) ⇒ cross-instance nonce collisions", async () => {
  const node = mockNode({ lagMs: 40 });
  const cursors = Array.from({ length: 4 }, () => new RelayerNonceCursor(node.pending));
  const r = await storm(node, cursors, 40);
  console.log(`  before: ok ${r.ok}/40, nonce-too-low ${r.tooLow}, too-high ${r.tooHigh}, user-visible failures ${r.failed.length}`);
  assert.ok(r.tooLow > 0, "the old per-instance cursors collide");
});

test("AFTER: 4 instances × 40 overlapping relays on ONE shared allocator ⇒ zero collisions, every op once, no gaps", async () => {
  const node = mockNode({ lagMs: 40 }), store = kvStore();
  const cursors = Array.from({ length: 4 }, () => new SharedNonceCursor(store, node.pending));
  const r = await storm(node, cursors, 40);
  console.log(`  after:  ok ${r.ok}/40, nonce-too-low ${r.tooLow}, too-high ${r.tooHigh}, user-visible failures ${r.failed.length}`);
  assert.equal(r.tooLow, 0, "no nonce handed out twice"); assert.equal(r.failed.length, 0);
  assert.equal(new Set(node.accepted).size, 40); assert.equal(node.accepted.length, 40, "no op sent twice");
  assert.equal(node.state, 140, "contiguous: 100..139");
});

test("AFTER, hostile: 6 instances × 60 relays + definitive rejections (holes) + an outside writer + lagging RPC", async () => {
  const reject = new Set(["op3", "op17", "op29", "op44"]);
  const node = mockNode({ lagMs: 80, rejectOnce: reject }), store = kvStore();
  const cursors = Array.from({ length: 6 }, () => new SharedNonceCursor(store, node.pending, { floorMaxAgeMs: 50 }));
  const ext = setInterval(() => node.external(), 7);
  const r = await storm(node, cursors, 60, 3);
  clearInterval(ext);
  const rejected = r.failed.filter((f) => /insufficient funds/.test(f.err ?? ""));
  const other = r.failed.filter((f) => !/insufficient funds/.test(f.err ?? ""));
  console.log(`  hostile: ok ${r.ok}/60, definitive rejections ${rejected.length}, nonce-too-low ${r.tooLow} (outside writer), other failures ${other.length}`);
  assert.equal(other.length, 0, `only the injected rejections fail: ${JSON.stringify(other)}`);
  assert.equal(new Set(node.accepted).size, node.accepted.length, "no op accepted twice");
  // the released nonces were refilled: after one more relay per instance, nothing is stuck behind a gap
  const tail = await storm(node, cursors, 6);
  assert.equal(tail.failed.length, 0);
});

test("lost tx (unclear send that never landed) ⇒ gap healed: the node's next nonce is re-allocated once, then traffic flows", async () => {
  const node = mockNode({ holdMs: 20 }), store = kvStore();
  const a = new SharedNonceCursor(store, node.pending, { gapWaitMs: 5 }), b = new SharedNonceCursor(store, node.pending, { gapWaitMs: 5 });
  await assert.rejects(sendWithCursor(a, async () => { throw Object.assign(new Error("request timed out"), { unclear: true }); }));   // nonce 100 lost
  await assert.rejects(sendWithCursor(b, (n) => node.send("x", n)), /nonce too high/);   // 101 can't land: gap at 100 → claimed as a hole
  const r = await storm(node, [a, b], 6);
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed)); assert.equal(node.state, 106);
});

test("already known ⇒ ONE signature, never re-sent with another nonce (no double-send)", async () => {
  const store = kvStore(), c = new SharedNonceCursor(store, async () => 7);
  const signed: number[] = [];
  await assert.rejects(sendWithCursor(c, async (n) => { signed.push(n); throw new Error("already known"); }), /already known/);
  assert.deepEqual(signed, [7]); assert.equal(await c.take(), 8, "nonce 7 stays reserved");
});

test("KV down ⇒ falls back to the per-process cursor (old behaviour), logged, no throw", async () => {
  const logs: string[] = [];
  const dead: NonceStore = { alloc: () => new Promise(() => {}), release: async () => 0, claim: async () => false };
  const c = new SharedNonceCursor(dead, async () => 42, { kvTimeoutMs: 20, log: (m) => logs.push(m) });
  assert.equal(await c.take(), 42); assert.equal(await c.take(), 43);
  assert.equal(c.stats.fallbacks, 1); assert.match(logs[0], /per-instance cursor/);
});
