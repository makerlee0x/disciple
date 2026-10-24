// Relayer key pool (lib/server/relayerPool): OFF by default = the single key; lease logic against a mocked store.
// Dummy key VECTORS only (not real keys, never funded). No network.   pnpm test:relayer-pool
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { RelayerKeyPool, leaseKey, poolKey, poolNames, type LeaseStore } from "../lib/server/relayerPool";

const K = (b: string) => (`0x${b.repeat(32)}`) as Hex;
const SINGLE = K("01"), FAUCET = K("02"), P1 = K("03"), P2 = K("04"), P3 = K("05");
const addr = (k: Hex) => privateKeyToAccount(k).address;

/** In-memory Redis stand-in with TTLs on an injected clock. */
function memStore(clock: { t: number }) {
  const m = new Map<string, { v: string; exp: number }>();
  let down = false;
  const live = (k: string) => { const e = m.get(k); if (e && e.exp <= clock.t) { m.delete(k); return undefined; } return e; };
  const store: LeaseStore = {
    async setNX(k, v, ttl) { if (down) throw new Error("kv down"); if (live(k)) return false; m.set(k, { v, exp: clock.t + ttl * 1000 }); return true; },
    async expireIfEq(k, v, ttl) { if (down) throw new Error("kv down"); const e = live(k); if (!e || e.v !== v) return false; e.exp = clock.t + ttl * 1000; return true; },
  };
  return { store, m, setDown: (d: boolean) => { down = d; } };
}
const ENV = { RELAYER_KEY_POOL: "RELAYER_KEY_1, RELAYER_KEY_2,RELAYER_KEY_3", RELAYER_KEY_1: P1, RELAYER_KEY_2: P2, RELAYER_KEY_3: P3, DRIP_FAUCET_KEY: FAUCET };
const mkPool = (id: string, store: LeaseStore, clock: { t: number }, env: Record<string, string | undefined> = ENV) =>
  new RelayerKeyPool({ names: poolNames(env), store, id, now: () => clock.t, resolve: (n) => poolKey(env, n) });
const flush = () => new Promise((r) => setTimeout(r, 0));

test("config: unset/empty ⇒ disabled; names validated; faucet / malformed keys never used", () => {
  assert.deepEqual(poolNames({}), []); assert.deepEqual(poolNames({ RELAYER_KEY_POOL: " , " }), []);
  assert.deepEqual(poolNames({ RELAYER_KEY_POOL: "A_1,a-bad,A_1,DRIP_FAUCET_KEY,0x" + "11".repeat(32) }), ["A_1"]);
  assert.equal(poolKey({ X: FAUCET, DRIP_FAUCET_KEY: FAUCET }, "X"), undefined);
  assert.equal(poolKey({ X: "0x1234" }, "X"), undefined); assert.equal(poolKey({}, "X"), undefined);
  assert.equal(poolKey({ X: P1.slice(2) }, "X"), P1);
});

test("lease: SETNX+TTL; two instances get different keys; exhausted ⇒ undefined (single key)", async () => {
  const clock = { t: 1_000_000 }, s = memStore(clock);
  const ids = ["i-a", "i-b", "i-c", "i-d"], pools = ids.map((id) => mkPool(id, s.store, clock));
  const got = await Promise.all(pools.map((p) => p.ensure()));
  const names = got.filter(Boolean).map((l) => l!.name);
  assert.equal(names.length, 3); assert.equal(new Set(names).size, 3, "each key leased once");
  assert.equal(got.filter((l) => !l).length, 1); assert.equal(pools[got.findIndex((l) => !l)].stats.exhausted, 1);
  for (const l of got.filter(Boolean)) { assert.equal(l!.address, addr(l!.key)); assert.ok(s.m.has(leaseKey(l!.name))); }
});

test("renew off the hot path keeps the lease; no renewal ⇒ stops using it before the TTL (safety), then re-acquires", async () => {
  const clock = { t: 0 }, s = memStore(clock), p = mkPool("i-a", s.store, clock);
  const l = await p.ensure(); assert.ok(l);
  clock.t += 25_000; p.maybeRenew(); await flush();
  assert.equal(p.stats.renewed, 1); assert.equal(p.current()?.name, l!.name);
  clock.t += 50_000;   // 75 s, last renewal at 25 s + 60 s TTL ⇒ inside the 15 s safety margin: not usable
  assert.equal(p.current(), undefined);
  const again = await p.ensure(); assert.equal(again?.name, l!.name, "re-takes its own key first");
});

test("lost lease (another instance holds it after expiry) ⇒ dropped on renew, next ensure takes a free key", async () => {
  const clock = { t: 0 }, s = memStore(clock), a = mkPool("i-a", s.store, clock);
  const la = await a.ensure();
  s.m.set(leaseKey(la!.name), { v: "i-z", exp: clock.t + 60_000 });   // stolen after an expiry we didn't observe
  clock.t += 21_000; a.maybeRenew(); await flush();
  assert.equal(a.stats.lost, 1); assert.equal(a.current(), undefined);
  const lb = await a.ensure(); assert.ok(lb); assert.notEqual(lb!.name, la!.name);
});

test("KV down: acquire ⇒ undefined (single key, no scan storm); renew error keeps the lease until the safety deadline", async () => {
  const clock = { t: 0 }, s = memStore(clock), p = mkPool("i-a", s.store, clock);
  s.setDown(true); assert.equal(await p.ensure(), undefined); assert.equal(p.stats.errors, 1);
  s.setDown(false); const l = await p.ensure(); assert.ok(l);
  s.setDown(true); clock.t += 21_000; p.maybeRenew(); await flush();
  assert.equal(p.current()?.name, l!.name);
  clock.t += 30_000; assert.equal(p.current(), undefined);
});

test("pool OFF (RELAYER_KEY_POOL unset): fastRelay signs with the single RELAYER_PRIVATE_KEY, no KV touched", async () => {
  Object.assign(process.env, { NODE_ENV: "test", RELAYER_PRIVATE_KEY: SINGLE, DRIP_FAUCET_KEY: FAUCET, KV_LOCAL_FILE: "/tmp/disciple-kv-pooltest-never.json" });
  delete process.env.RELAYER_KEY_POOL; delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.KV_REST_API_URL; delete process.env.VERCEL; delete process.env.VERCEL_ENV; delete process.env.RELAYER_ENV;
  const { standardRelayer } = await import("../lib/server/fastRelay");
  const r1 = await standardRelayer(), r2 = await standardRelayer();
  assert.equal(r1.address, addr(SINGLE)); assert.equal(r2.address, addr(SINGLE));
  const fs = await import("node:fs");
  assert.equal(fs.existsSync("/tmp/disciple-kv-pooltest-never.json"), false);
});
