// Unit tests for the trade-latency changes (SITE, latency plan #4/#5 + timing):
//  - HybridLimiter (lib/server/limits): in-memory decision, shared-store INCR off the critical path, global count learned
//  - afterResponse (lib/server/defer): waitUntil / await / background modes
//  - TtlCache.rewarm + Requoter (lib/trade/hotCache): re-quote after our own trade instead of wiping
//  - startTradeTiming (lib/trade/timing): stage keys aligned with GAME's 'disciple:op' filled ms
//  - ReadFloor (lib/trade/readFloor): post-trade reads pinned to our receipt block (never pre-trade state)
//   pnpm test:trade-latency   (pure: no RPC, no live endpoint)
import { test } from "node:test";
import assert from "node:assert/strict";
import { HybridLimiter, memoryCounter, type CounterStore } from "../lib/server/limits";
import { afterResponse, waitUntilFn } from "../lib/server/defer";
import { TtlCache, Requoter, scaledQuote } from "../lib/trade/hotCache";
import { startTradeTiming } from "../lib/trade/timing";
import { ReadFloor, flooredRequest, flooredTransport, receiptBlock, withBlock } from "../lib/trade/readFloor";
import { createPublicClient, custom } from "viem";

const tick = () => new Promise((r) => setTimeout(r, 0));

/* ---------- rate limiter ---------- */
test("hybrid limiter: memory-only blocks at limit+1 and resets after the window", () => {
  let t = 0; const L = new HybridLimiter(() => null, () => t);
  for (let i = 1; i <= 3; i++) assert.equal(L.hit("k", 3, 60).ok, true);
  const r = L.hit("k", 3, 60);
  assert.equal(r.ok, false); assert.equal(r.count, 4); assert.ok(r.retryAfterSec >= 1 && r.retryAfterSec <= 60);
  assert.equal(r.sync, undefined, "no store ⇒ no background work");
  t += 60_001; assert.equal(L.hit("k", 3, 60).ok, true);
});
test("hybrid limiter: the decision never waits for the store (a hung store still answers synchronously)", () => {
  let incrs = 0;
  const hung: CounterStore = { incrEx: () => { incrs++; return new Promise<number>(() => {}); }, ttl: async () => 60 };
  const L = new HybridLimiter(() => hung);
  const r = L.hit("k", 5, 60);
  assert.equal(r.ok, true); assert.ok(r.sync instanceof Promise); assert.equal(incrs, 1);
});
test("hybrid limiter: in-flight shared increments count against the limit (burst on one instance)", () => {
  const hung: CounterStore = { incrEx: () => new Promise<number>(() => {}), ttl: async () => 60 };
  const L = new HybridLimiter(() => hung);
  const res = Array.from({ length: 4 }, () => L.hit("k", 3, 60).ok);
  assert.deepEqual(res, [true, true, true, false]);
});
test("hybrid limiter: a key over the limit in the shared store (other instances) is blocked on its next hit", async () => {
  const shared = memoryCounter, key = `k${Date.now()}`;
  for (let i = 0; i < 10; i++) await shared.incrEx(`rl:${key}`, 60);   // 10 hits elsewhere
  const L = new HybridLimiter(() => shared, () => 0);
  const first = L.hit(key, 5, 60);
  assert.equal(first.ok, true, "first hit decided locally (overshoot bound: hits before the first store answer)");
  await first.sync;
  assert.equal(L.peek(key)!.g, 11);
  const second = L.hit(key, 5, 60);
  assert.equal(second.ok, false); assert.ok(second.count >= 11);
  await second.sync;
});
test("hybrid limiter: store errors fall back to memory (degraded, never unlimited)", async () => {
  const broken: CounterStore = { incrEx: async () => { throw new Error("upstash down"); }, ttl: async () => 0 };
  const L = new HybridLimiter(() => broken, () => 0);
  const out: boolean[] = [];
  for (let i = 0; i < 3; i++) { const r = L.hit("k", 2, 60); out.push(r.ok); await r.sync; }
  assert.deepEqual(out, [true, true, false]);
  assert.equal(L.peek("k")!.pending, 0);
});
test("hybrid limiter: keys are independent", () => {
  const L = new HybridLimiter(() => null, () => 0);
  assert.equal(L.hit("a", 1, 60).ok, true); assert.equal(L.hit("a", 1, 60).ok, false); assert.equal(L.hit("b", 1, 60).ok, true);
});

/* ---------- afterResponse ---------- */
test("afterResponse: uses the platform waitUntil when present, without awaiting", async () => {
  const handed: Promise<unknown>[] = []; let ran = false;
  const g = { [Symbol.for("@vercel/request-context")]: { get: () => ({ waitUntil: (p: Promise<unknown>) => { handed.push(p); } }) } };
  assert.ok(waitUntilFn(g));
  const mode = await afterResponse(async () => { await tick(); ran = true; }, { g, onVercel: true });
  assert.equal(mode, "waitUntil"); assert.equal(handed.length, 1); assert.equal(ran, false);
  await handed[0]; assert.equal(ran, true);
});
test("afterResponse: on Vercel without waitUntil it awaits (never loses a write); elsewhere background; never throws", async () => {
  let ran = false;
  assert.equal(await afterResponse(async () => { await tick(); ran = true; }, { g: {}, onVercel: true }), "await");
  assert.equal(ran, true);
  assert.equal(await afterResponse(async () => { throw new Error("x"); }, { g: {}, onVercel: false }), "background");
  assert.equal(await afterResponse(async () => { throw new Error("x"); }, { g: {}, onVercel: true }), "await");
});

/* ---------- quote re-warm ---------- */
const Q = (n: number) => ({ amountOut: BigInt(n) });
test("TtlCache.rewarm: old value is gone at once, taps join the ONE re-read", async () => {
  const c = new TtlCache<{ amountOut: bigint }>(1500);
  c.set("k", Q(100));
  let reads = 0, release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const p = c.rewarm("k", async () => { reads++; await gate; return Q(90); });
  assert.equal(c.fresh("k"), undefined, "pre-trade quote must not be served after the trade");
  const tap = c.get("k", async () => { reads++; return Q(1); });
  release();
  assert.equal((await tap).amountOut, BigInt(90)); assert.equal((await p).amountOut, BigInt(90));
  assert.equal(reads, 1); assert.equal(c.fresh("k")!.amountOut, BigInt(90));
});
test("TtlCache.rewarm: a failed re-read leaves nothing cached (next tap reads live)", async () => {
  const c = new TtlCache<{ amountOut: bigint }>(1500);
  c.set("k", Q(100));
  await c.rewarm("k", async () => { throw new Error("rpc"); }).catch(() => undefined);
  assert.equal(c.fresh("k"), undefined);
  assert.equal((await c.get("k", async () => Q(7))).amountOut, BigInt(7));
});
test("Requoter: re-reads the recently used route quotes, drops the rest + the scaling base, re-sets LAST_QUOTE", async () => {
  let t = 1_000_000;
  const quotes = new TtlCache<{ amountOut: bigint }>(1500, () => t), trader = new TtlCache<{ amountOut: bigint }>(1500, () => t);
  const last = new Map<string, { amountIn: bigint; amountOut: bigint; at: number }>();
  const R = new Requoter([quotes, trader], last, () => t);
  const reads: string[] = [];
  const reg = (k: string, v: number, c = quotes, lk?: string) => { c.set(k, Q(v + 1)); R.remember(k, async () => { reads.push(k); return Q(v); }, lk ? { lk, amountIn: BigInt(10) } : undefined, c); };
  reg("0xtok|buy|10", 50, quotes, "0xtok|buy");
  reg("pvq|0xtok|buy|0xme|10", 40, trader);
  last.set("0xtok|buy", { amountIn: BigInt(10), amountOut: BigInt(51), at: t });
  t += 40_000; reg("0xtok|sell|5", 30);   // the buy keys are now 40 s old ⇒ not hot
  reg("0xother|buy|10", 70);
  t += 1;
  const hot = R.requote((k) => k.startsWith("0xtok") || k.startsWith("pvq|0xtok"), ["0xtok|buy"]);
  assert.deepEqual(hot, ["0xtok|sell|5"]);
  assert.equal(quotes.fresh("0xtok|buy|10"), undefined, "stale cold quote dropped");
  assert.equal(trader.fresh("pvq|0xtok|buy|0xme|10"), undefined);
  assert.equal(last.get("0xtok|buy"), undefined, "no down-scaling from a pre-trade quote");
  assert.equal(quotes.fresh("0xother|buy|10")!.amountOut, BigInt(71), "other routes untouched");
  await tick(); await tick();
  assert.deepEqual(reads, ["0xtok|sell|5"]);
  assert.equal(quotes.fresh("0xtok|sell|5")!.amountOut, BigInt(30));
});
test("Requoter: trader quotes re-warm into their own cache and LAST_QUOTE is re-set from the fresh read", async () => {
  const t = 5;
  const quotes = new TtlCache<{ amountOut: bigint }>(1500, () => t), trader = new TtlCache<{ amountOut: bigint }>(1500, () => t);
  const last = new Map<string, { amountIn: bigint; amountOut: bigint; at: number }>();
  const R = new Requoter([quotes, trader], last, () => t);
  R.remember("pvq|0xt|buy|0xme|10", async () => Q(40), undefined, trader);
  R.remember("0xt|buy|10", async () => Q(50), { lk: "0xt|buy", amountIn: BigInt(10) });
  R.requote((k) => k.includes("0xt"), ["0xt|buy"], 4);
  await tick(); await tick();
  assert.equal(trader.fresh("pvq|0xt|buy|0xme|10")!.amountOut, BigInt(40));
  assert.equal(quotes.fresh("pvq|0xt|buy|0xme|10"), undefined);
  assert.equal(last.get("0xt|buy")!.amountOut, BigInt(50));
  assert.equal(scaledQuote(last.get("0xt|buy"), BigInt(5), 1500, t), BigInt(25), "scaled lower bound from the fresh quote");
});
test("Requoter: at most `max` re-reads per trade (most recent first)", () => {
  let t = 0; const c = new TtlCache<{ amountOut: bigint }>(1500, () => t);
  const R = new Requoter([c], new Map(), () => t);
  for (let i = 0; i < 10; i++) { t = i; R.remember(`0xt|buy|${i}`, async () => Q(i)); }
  assert.deepEqual(R.requote((k) => k.startsWith("0xt"), [], 3), ["0xt|buy|9", "0xt|buy|8", "0xt|buy|7"]);
});

/* ---------- client timing ---------- */
test("trade timing: ms keys match GAME's filled event; submit/confirm split by the relay's mined wait", () => {
  let now = 1000; const rows: Record<string, unknown>[] = [];
  const tt = startTradeTiming("buy", () => now, (o) => rows.push(o));
  now = 1040; tt.mark("send"); now = 1300; tt.mark("response");
  tt.note({ path: "fast", server: { mined: 150, send: 60 } });
  now = 1310; tt.done("fill");
  assert.equal(tt.done("fill"), undefined, "logs once");
  const ms = rows[0].ms as Record<string, number>;
  assert.deepEqual(ms, { total: 310, quote: 40, confirm: 150, submit: 110, fill: 10 });
  assert.equal(rows[0].outcome, "fill"); assert.equal(rows[0].path, "fast");
});

/* ---------- post-trade read floor (sequencer receipt vs lagging public RPC) ---------- */
test("receiptBlock / withBlock: highest block from raw-hex or bigint logs; stamped for wallet.execCalls pass-through", () => {
  assert.equal(receiptBlock([{ blockNumber: "0x10" }, { blockNumber: 18n }, {}]), 18n);
  assert.equal(receiptBlock([]), undefined);
  assert.equal(receiptBlock(undefined), undefined);
  assert.equal(receiptBlock([{ blockNumber: "garbage" }]), undefined);
  const out = withBlock([{ address: "0x1" }, { address: "0x2", blockNumber: 5n }], "0x20");
  assert.deepEqual(out.map((l) => l.blockNumber), ["0x20", "0x5"]);
  assert.deepEqual(withBlock([{ a: 1 }], undefined), [{ a: 1 }]);
  assert.equal(receiptBlock(withBlock([{}, {}], 99n)), 99n);
});

test("read floor: only raises while live, expires after the window", () => {
  let t = 0; const f = new ReadFloor(() => t, 3000);
  assert.equal(f.pin(), undefined);
  f.raise(100n); assert.equal(f.pin(), 100n);
  f.raise(90n); assert.equal(f.pin(), 100n, "an older block never lowers a live floor");
  f.raise(undefined); assert.equal(f.pin(), 100n);
  t = 3001; assert.equal(f.pin(), undefined, "window over ⇒ plain latest");
  f.raise(90n); assert.equal(f.pin(), 90n);
});

test("floored request: latest state reads pinned to the receipt block; node behind ⇒ retried, never pre-trade state", async () => {
  let t = 0; const f = new ReadFloor(() => t, 3000);
  let head = 99; const seen: unknown[] = [];
  const inner = async ({ method, params }: { method: string; params?: unknown }) => {
    seen.push([method, params]);
    const tag = (params as unknown[])[1] as string;
    if (tag !== "latest" && BigInt(tag) > BigInt(head)) { head++; throw new Error("header not found"); }
    return method === "eth_call" ? "0xquote" : "0x1";
  };
  const sleeps: number[] = [];
  const req = flooredRequest(inner, f, { sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(await req({ method: "eth_call", params: [{ to: "0x1" }, "latest"] }), "0xquote");
  assert.deepEqual(seen.pop(), ["eth_call", [{ to: "0x1" }, "latest"]], "no own trade ⇒ untouched");
  f.raise(101n);                                    // our receipt: block 101, public node still at 99
  seen.length = 0;
  assert.equal(await req({ method: "eth_call", params: [{ to: "0x1" }, "latest"] }), "0xquote");
  assert.deepEqual(seen.map((x) => (x as [string, unknown[]])[1][1]), ["0x65", "0x65", "0x65"], "pinned to 0x65 (101) and retried until the node has it");
  assert.deepEqual(sleeps, [80, 80]);
  seen.length = 0;
  await req({ method: "eth_getBalance", params: ["0xabc"] });
  assert.deepEqual(seen.pop(), ["eth_getBalance", ["0xabc", "0x65"]], "missing tag filled in");
  await req({ method: "eth_call", params: [{ to: "0x1" }, "0x10"] });
  assert.deepEqual(seen.pop(), ["eth_call", [{ to: "0x1" }, "0x10"]], "explicit block kept");
  await req({ method: "eth_blockNumber", params: [] }).catch(() => {});
  assert.deepEqual(seen.pop(), ["eth_blockNumber", []], "non-state methods untouched");
});

test("floored request: a lagging node that never catches up fails the read (bounded) instead of serving old state", async () => {
  const f = new ReadFloor(() => 0, 3000); f.raise(500n);
  let n = 0;
  const req = flooredRequest(async () => { n++; throw new Error("RPC error: header not found"); }, f, { tries: 5, sleep: async () => {} });
  await assert.rejects(req({ method: "eth_call", params: [{}, "latest"] }), /header not found/);
  assert.equal(n, 5);
  let m = 0;
  const other = flooredRequest(async () => { m++; throw new Error("execution reverted"); }, f, { sleep: async () => {} });
  await assert.rejects(other({ method: "eth_call", params: [{}, "latest"] }), /reverted/);
  assert.equal(m, 1, "real reverts are not retried");
});

test("floored transport through viem: getBalance / call go out pinned while the floor is up", async () => {
  const f = new ReadFloor(() => 0, 3000);
  const seen: unknown[][] = [];
  const base = custom({ request: async ({ method, params }: { method: string; params?: unknown }) => { seen.push([method, params]); return method === "eth_chainId" ? "0x1" : "0x0"; } });
  const pc = createPublicClient({ transport: flooredTransport(base, f) });
  await pc.getBalance({ address: "0x000000000000000000000000000000000000dEaD" });
  assert.equal((seen.pop()![1] as unknown[])[1], "latest");
  f.raise(0x77n);
  await pc.getBalance({ address: "0x000000000000000000000000000000000000dEaD" });
  assert.equal((seen.pop()![1] as unknown[])[1], "0x77");
  await pc.call({ to: "0x000000000000000000000000000000000000dEaD", data: "0x" });
  assert.equal((seen.pop()![1] as unknown[])[1], "0x77");
});
