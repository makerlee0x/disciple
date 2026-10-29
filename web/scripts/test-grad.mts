/**
 * SITE job 7 — GAME contract: every engine update ("State", "Trade", "Graduate" on window "disciple:event") carries
 * { graduated, poolId, graduatedAt } next to mcapUsd (lib/events mcapOrderer), and GET /api/coin/grad is parsed
 * defensively (lib/grad). Run: npm run test:grad
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockTs, mcapOrderer } from "../lib/events";
import { fetchGrad, parseGrad } from "../lib/grad";

const POOL = `0x${"ab".repeat(32)}` as `0x${string}`;
const tr = (block: number, logIndex: number, mcapUsd: number) => ({ type: "Trade", side: "buy", mcapUsd, block: BigInt(block), logIndex, usd: 10, impactPct: 0, txHash: `0x${block}${logIndex}`, token: "0x", trader: "0x" }) as never;
type Ev = { type: string; mcapUsd?: number; graduated?: boolean; poolId?: string | null; graduatedAt?: number | null };

test("every State / Trade carries graduated, poolId, graduatedAt (defaults before anything is known)", () => {
  const out: Ev[] = [];
  const o = mcapOrderer((e) => out.push(e as never));
  o.state(1000, BigInt(1));
  o.trade(tr(2, 0, 1100));
  for (const e of out) assert.deepEqual([e.graduated, e.poolId, e.graduatedAt], [false, null, null], e.type);
  assert.equal(out[0].type, "State"); assert.equal(out[0].mcapUsd, 1000);
});

test("server grad state is stamped; resend re-sends the State with it; never un-graduates", () => {
  const out: Ev[] = [];
  const o = mcapOrderer((e) => out.push(e as never));
  o.setGrad({ graduated: true });                         // curve read: graduated, pool unknown yet
  o.state(50_000, BigInt(10));
  assert.deepEqual([out[0].graduated, out[0].poolId, out[0].graduatedAt], [true, null, null]);
  o.setGrad({ graduated: true, poolId: POOL, graduatedAt: 1_792_000_000 });   // /api/coin/grad lands
  o.resend();
  assert.deepEqual(out.at(-1), { type: "State", mcapUsd: 50_000, graduated: true, poolId: POOL, graduatedAt: 1_792_000_000 });
  o.setGrad({ graduated: false, poolId: null, graduatedAt: null });            // stale answer can't undo it
  o.trade(tr(11, 0, 51_000));
  assert.deepEqual([out.at(-1)!.type, out.at(-1)!.graduated, out.at(-1)!.poolId, out.at(-1)!.graduatedAt], ["Trade", true, POOL, 1_792_000_000]);
});

test("a live Graduate flips the state for itself and every later update (same field names)", () => {
  const out: Ev[] = [];
  const o = mcapOrderer((e) => out.push(e as never));
  o.trade(tr(5, 0, 68_000));
  o.trade({ type: "Graduate", token: "0x", poolId: POOL, graduatedAt: 1_792_000_123 } as never);
  o.state(69_000, BigInt(6));
  assert.equal(out[0].graduated, false);
  for (const e of out.slice(1)) assert.deepEqual([e.graduated, e.poolId, e.graduatedAt], [true, POOL, 1_792_000_123], e.type);
  const g = o.grad; assert.deepEqual(g, { graduated: true, poolId: POOL, graduatedAt: 1_792_000_123 });
});

test("parseGrad / fetchGrad: shape-checked; non-graduated never carries pool data; errors ⇒ null", async () => {
  assert.deepEqual(parseGrad({ graduated: true, poolId: POOL.toUpperCase().replace("0X", "0x"), graduatedAt: 1_792_000_000.7 }), { graduated: true, poolId: POOL, graduatedAt: 1_792_000_000 });
  assert.deepEqual(parseGrad({ graduated: false, poolId: POOL, graduatedAt: 5 }), { graduated: false, poolId: null, graduatedAt: null });
  assert.deepEqual(parseGrad({ graduated: true, poolId: "0x12", graduatedAt: -1 }), { graduated: true, poolId: null, graduatedAt: null });
  assert.equal(parseGrad({ error: "x" }), null); assert.equal(parseGrad(null), null);
  const ok = (async () => ({ ok: true, json: async () => ({ coin: "0x", graduated: true, poolId: POOL, graduatedAt: 9 }) })) as never;
  assert.deepEqual(await fetchGrad("0x1", ok), { graduated: true, poolId: POOL, graduatedAt: 9 });
  assert.equal(await fetchGrad("0x1", (async () => ({ ok: false, json: async () => ({}) })) as never), null);
  assert.equal(await fetchGrad("0x1", (async () => { throw new Error("down"); }) as never), null);
});

test("blockTs: unix seconds of the GraduatedToV4 block; null on a failed read", async () => {
  assert.equal(await blockTs({ getBlock: async () => ({ timestamp: BigInt(1_792_000_456) }) } as never, BigInt(7)), 1_792_000_456);
  assert.equal(await blockTs({ getBlock: async () => { throw new Error("x"); } } as never, BigInt(7)), null);
  assert.equal(await blockTs({ getBlock: async () => ({ timestamp: BigInt(1) }) } as never, null), null);
});
