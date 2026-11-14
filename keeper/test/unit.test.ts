import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { concat, pad, toHex, type Hex } from "viem";
import { batch, judge, Keeper, selfPayRoom, sweepNeeded, type Due } from "../src/keeper.ts";
import { decodeSource, jarValue, OFF, poolBase as poolBaseOf, POOLS_SLOT, readLeaderSpot, type PoolDyn, type PoolSource } from "../src/hook.ts";
import { loadConfig } from "../src/config.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptKeystore } from "../src/keystore.ts";
import { messageLength, parsePacket } from "../src/packet.ts";
import { moved, Q128, shift, spotX128 } from "../src/price.ts";

const policy = {
  moveBps: 102n,
  firstPrice: true,
  unpaidHeartbeats: false,
  minJar: 0n,
  collectEverySec: 86_400,
  takeoverAfterSec: 900,
  maxPoolsPerPush: 64,
  maxPushCost: 10n ** 16n,
  packetTtlSec: 3600,
};
const src: PoolSource = {
  kind: 1,
  coinIs0: true,
  remoteEid: 30101,
  target: "0x8f1B19622a888c53C8eE4F7D7B4Dc8F574ff9068",
  v4Id: pad("0x00"),
  decShift: 0,
  push: true,
};
const dyn = (o: Partial<PoolDyn> = {}): PoolDyn => ({
  exists: true,
  live: true,
  local: false,
  anchorX128: 1000n * Q128,
  obsAt: 1_000_000n,
  coin: "0x0000000000000000000000000000000000000001",
  quote: "0x0000000000000000000000000000000000000002",
  jar: 10n ** 15n,
  traded: false,
  ...o,
});
const ID = pad("0x01");

test("v2 spot and shift match the hook", () => {
  assert.equal(spotX128(1, 2n, 2000n, true), 1000n * Q128);
  assert.equal(spotX128(1, 2000n, 2n, false), 1000n * Q128);
  assert.equal(spotX128(1, 0n, 5n, true), 0n);
  assert.equal(shift(-2, 12345n), 123n);
  assert.equal(shift(3, 7n), 7000n);
  assert.equal(shift(1, (1n << 256n) - 1n), 0n);
});

test("concentrated spot: sqrtP = 2^96 is price 1 both ways", () => {
  assert.equal(spotX128(3, 1n << 96n, 5n, true), Q128);
  assert.equal(spotX128(3, 1n << 96n, 5n, false), Q128);
  assert.equal(spotX128(2, 1n << 160n, 5n, true), 0n); // does not fit uint160: refused
  assert.equal(spotX128(2, 2n << 96n, 0n, true), 4n * Q128);
});

test("moved threshold", () => {
  assert.equal(moved(10_000n, 10_100n, 100n), true);
  assert.equal(moved(10_000n, 10_099n, 100n), false);
  assert.equal(moved(10_000n, 9_900n, 100n), true);
  assert.equal(moved(0n, 1n), true);
});

test("judge: first price, move, paid and unpaid heartbeats, jar floor, inflight", () => {
  const p = 1000n * Q128;
  const up = (p * 10_110n) / 10_000n; // +1.10%
  const now = 1_000_000n + 100n;
  assert.equal(judge(ID, src, dyn({ live: false }), p, now, undefined, policy)?.reason, "first");
  assert.equal(judge(ID, src, dyn(), p, now, undefined, policy), null);
  assert.equal(judge(ID, src, dyn(), up, now, undefined, policy)?.reason, "move");
  assert.equal(judge(ID, src, dyn(), (p * 10_101n) / 10_000n, now, undefined, policy), null); // 1.01% < 1.02% trigger
  // an empty jar is still served by default (pushes move the price; trades refill the jar) ...
  assert.equal(judge(ID, src, dyn({ jar: 0n }), up, now, undefined, policy)?.reason, "move");
  // ... unless the operator sets a floor; the opening price ignores the floor (a new pool's jar starts empty)
  assert.equal(judge(ID, src, dyn({ jar: 5n }), up, now, undefined, { ...policy, minJar: 6n }), null);
  assert.equal(judge(ID, src, dyn({ live: false, jar: 0n }), p, now, undefined, { ...policy, minJar: 6n })?.reason, "first");
  const late = 1_000_000n + 3570n;
  assert.equal(judge(ID, src, dyn(), p, late, undefined, policy), null); // untraded: hook would not pay
  assert.equal(judge(ID, src, dyn({ traded: true }), p, late, undefined, policy)?.reason, "heartbeat");
  assert.equal(judge(ID, src, dyn(), p, late, undefined, { ...policy, unpaidHeartbeats: true })?.reason, "heartbeat-unpaid");
  assert.equal(judge(ID, src, dyn({ traded: true }), p, late - 1n, undefined, policy), null);
  // in flight: compare with the price on its way, no heartbeat
  assert.equal(judge(ID, src, dyn({ traded: true }), up, late, up, policy), null);
  assert.equal(judge(ID, src, dyn(), (up * 10_200n) / 10_000n, now, up, policy)?.reason, "move");
});

test("jar value: quote side plus coin side at the centre", () => {
  assert.equal(jarValue(0n, 7n, 1000n * Q128), 7n);
  assert.equal(jarValue(3n, 7n, 1000n * Q128), 3007n);
  assert.equal(jarValue(5n, 0n, Q128 / 2n), 2n); // rounds down
});

test("config: same-chain sets, sampling and jar policy defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-cfg-"));
  const f = join(dir, "c.json");
  writeFileSync(
    f,
    JSON.stringify({
      sameChain: [{ chain: "robinhood", hook: "0xcedc3c312c5b3c4310f0fba0323ddec797e4aa88", pools: ["0xABCD"] }],
    }),
  );
  const c = loadConfig(f, { RH_RPC: "http://x" });
  assert.equal(c.routes.length, 0);
  assert.equal(c.sameChain.length, 1);
  assert.equal(c.sameChain[0].name, "robinhood-same");
  assert.equal(c.sameChain[0].hook, "0xcEdc3C312C5B3C4310F0fba0323DDeC797E4aA88");
  assert.deepEqual(c.sameChain[0].pools, ["0xabcd"]);
  assert.equal(c.sameChain[0].scanPools, true);
  assert.deepEqual(c.sampling, { everySec: 13, missesBeforeRest: 3, restSec: 3600, minGapSec: 13, selfPayBps: 0, selfPayBpsCarry: 15, selfPayMaxPerHour: 60, sweepEverySec: 60, sweepBandBps: 20_000, matchEverySec: 60, matchSteps: 20, matchSampleMaxPerHour: 12, settleEverySec: 3600, settleCheckSec: 300 });
  assert.deepEqual(c.alerts, { minEth: 3_000_000_000_000_000n, balanceEverySec: 600, errorsBeforeAlert: 10 });
  assert.equal(c.sameChain[0].abi, "disciple");
  assert.equal(c.policy.minJar, 0n);
  assert.equal(c.policy.collectEverySec, 86_400);
  writeFileSync(f, JSON.stringify({ sameChain: [{ chain: "ethereum", hook: "0xcedc3c312c5b3c4310f0fba0323ddec797e4aa88" }] }));
  assert.throws(() => loadConfig(f, { RH_RPC: "http://x" }), /set the RPC for ethereum/);
});

test("batch: 64 pools per message and the 10 kB message cap", () => {
  const mk = (i: number, s: number): Due => ({
    id: pad(toHex(i)),
    src: { ...src, target: pad(toHex(s), { size: 20 }) },
    price: 1n,
    reason: "move",
    note: "",
  });
  const one = Array.from({ length: 100 }, (_, i) => mk(i, 1));
  const b1 = batch(one, 64);
  assert.deepEqual(b1.map((b) => b.length), [64, 36]);
  const many = Array.from({ length: 60 }, (_, i) => mk(i, i + 1));
  const b2 = batch(many, 64);
  for (const b of b2) assert.ok(messageLength(b.map(() => 1)) <= 10_000);
  assert.equal(b2.reduce((s, b) => s + b.length, 0), 60);
  assert.ok(b2.length >= 2);
});

test("source decode from packed slots", () => {
  const target = 0x8f1b19622a888c53c8ee4f7d7b4dc8f574ff9068n;
  const w0 = 3n | (1n << 8n) | (30101n << 16n) | (target << 48n);
  const w2 = 0xfen | (0x01n << 8n) | (1n << 16n); // decShift -2, tvlShift 1, push
  const s = decodeSource(w0, 0x1234n, w2);
  assert.equal(s.kind, 3);
  assert.equal(s.coinIs0, true);
  assert.equal(s.remoteEid, 30101);
  assert.equal(s.target, "0x8f1b19622a888c53c8ee4f7d7b4dc8f574ff9068");
  assert.equal(s.decShift, -2);
  assert.equal(s.push, true);
  assert.equal(s.kind2, 0);
  assert.equal(decodeSource(w0, 0x1234n, w2 | (3n << 24n)).kind2, 3);
});

test("packet parse", () => {
  const sender = pad("0xaaaa");
  const receiver = pad("0x00000000000000000000000000000000000000bb");
  const guid = pad("0xcc");
  const enc = concat(["0x01", pad(toHex(7n), { size: 8 }), pad(toHex(30101), { size: 4 }), sender, pad(toHex(30416), { size: 4 }), receiver, guid, "0xdeadbeef"]);
  const p = parsePacket(enc);
  assert.equal(p.nonce, 7n);
  assert.equal(p.srcEid, 30101);
  assert.equal(p.dstEid, 30416);
  assert.equal(p.sender, sender);
  assert.equal(p.receiver, "0x00000000000000000000000000000000000000bb");
  assert.equal(p.guid, guid);
  assert.equal(p.message, "0xdeadbeef");
  assert.equal((p.header.length - 2) / 2, 81);
});

test("keystore: decrypts a cast keystore, refuses a wrong password", () => {
  const json = readFileSync(new URL("./fixtures/keeper-test", import.meta.url), "utf8");
  const pk = decryptKeystore(json, "test-password");
  assert.equal(privateKeyToAccount(pk as Hex).address, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  assert.throws(() => decryptKeystore(json, "nope"), /wrong keystore password/);
});

test("storage layout matches the hook (needs forge; skipped otherwise)", (t) => {
  let out: string;
  try {
    out = execFileSync("forge", ["inspect", "src/hook/DiscipleHook.sol:DiscipleHook", "storageLayout", "--json"], {
      cwd: new URL("../../contracts", import.meta.url).pathname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1 << 26,
    });
  } catch {
    t.skip("forge not available");
    return;
  }
  const l = JSON.parse(out);
  const pools = l.storage.find((s: { label: string }) => s.label === "pools");
  assert.equal(BigInt(pools.slot), POOLS_SLOT);
  const ty = (k: string) => Object.entries(l.types).find(([n]) => n.startsWith(k))![1] as { members: { label: string; slot: string; offset: number }[] };
  const m = (t: ReturnType<typeof ty>, x: string) => t.members.find((y) => y.label === x)!;
  const P = ty("t_struct(Pool)");
  const S = ty("t_struct(Source)");
  const B = ty("t_struct(Book)");
  assert.equal(BigInt(m(P, "src").slot), OFF.src0);
  assert.equal(BigInt(m(P, "src").slot) + BigInt(m(S, "v4Id").slot), OFF.srcV4Id);
  assert.equal(BigInt(m(P, "src").slot) + BigInt(m(S, "decShift").slot), OFF.src2);
  assert.equal(BigInt(m(P, "obsAt").slot), OFF.obsAt);
  assert.equal(m(P, "obsAt").offset, 0);
  assert.equal(BigInt(m(P, "book").slot) + BigInt(m(B, "dx").slot), OFF.bookDx);
  assert.equal(BigInt(m(P, "book").slot) + BigInt(m(B, "dy").slot), OFF.bookDy);
  assert.deepEqual(
    ["kind", "coinIs0", "remoteEid", "target"].map((x) => [m(S, x).slot, m(S, x).offset]),
    [["0", 0], ["0", 1], ["0", 2], ["0", 6]],
  );
  assert.deepEqual([m(S, "decShift").offset, m(S, "push").offset], [0, 2]);
  assert.deepEqual(["exists", "live", "local"].map((x) => m(P, x).offset), [0, 1, 3]);
});

test("selfPayRoom: at most N unpaid samples per pool per rolling hour", () => {
  const log = new Map<string, number[]>();
  for (let i = 0; i < 3; i++) {
    assert.equal(selfPayRoom(log, "p", 1000 + i, 3), true);
    log.get("p")!.push(1000 + i);
  }
  assert.equal(selfPayRoom(log, "p", 1003, 3), false);
  assert.equal(selfPayRoom(log, "q", 1003, 3), true); // per pool
  assert.equal(selfPayRoom(log, "p", 1000 + 3600, 3), true); // the first one aged out
  assert.equal(log.get("p")!.length, 2);
});

test("config: carry hook build and sampling options", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-cfg-"));
  const f = join(dir, "c.json");
  writeFileSync(
    f,
    JSON.stringify({
      sameChain: [{ chain: "robinhood", hook: "0xcedc3c312c5b3c4310f0fba0323ddec797e4aa88", abi: "carry" }],
      sampling: { minGapSec: 20, selfPayBps: 25, selfPayMaxPerHour: 10 },
    }),
  );
  const c = loadConfig(f, { RH_RPC: "http://x" });
  assert.equal(c.sameChain[0].abi, "carry");
  assert.equal(c.sampling.minGapSec, 20);
  assert.equal(c.sampling.selfPayBps, 25);
  assert.equal(c.sampling.selfPayMaxPerHour, 10);
});

test("leader spot: v4 Slot0 from extsload, v3 slot0, v2 reserves", async () => {
  const fake = (out: unknown) => ({ readContract: async () => out }) as never;
  const base = { remoteEid: 0, target: "0x0000000000000000000000000000000000000001" as const, v4Id: pad("0x01"), decShift: 0, push: false };
  // sqrtP = 2^96 is price 1 (X128 = 2^128) in either orientation
  const w = pad(`0x${(1n << 96n).toString(16)}`);
  assert.equal(await readLeaderSpot(fake(w), { ...base, kind: 3, coinIs0: true }), Q128);
  assert.equal(await readLeaderSpot(fake([1n << 96n, 0, 0, 0, 0, 0, true]), { ...base, kind: 2, coinIs0: false }), Q128);
  // v2: 2 coin, 6 quote -> 3 quote per coin
  assert.equal(await readLeaderSpot(fake([2n, 6n, 0]), { ...base, kind: 1, coinIs0: true }), 3n * Q128);
  // two-leg sources and failing reads give 0
  assert.equal(await readLeaderSpot(fake(w), { ...base, kind: 3, coinIs0: true, kind2: 3 }), 0n);
  assert.equal(await readLeaderSpot({ readContract: async () => { throw new Error("x"); } } as never, { ...base, kind: 3, coinIs0: true }), 0n);
});


test("Carry sweep: once hot quote is outside the band either way (2x the 20% target by default)", () => {
  const V = "0xBeEff033F34C046626B8D0A041844C5d1A5409dd";
  const Z = "0x0000000000000000000000000000000000000000";
  const y = 25_000n * 10n ** 6n;
  // 80/20: nothing to do
  assert.equal(sweepNeeded(y, 20_000n * 10n ** 6n, 2000, V, 20_000), false);
  // hot at 40% exactly: still inside the band
  assert.equal(sweepNeeded(y, 15_000n * 10n ** 6n, 2000, V, 20_000), false);
  // hot just above 40%: sweep
  assert.equal(sweepNeeded(y, 14_999n * 10n ** 6n, 2000, V, 20_000), true);
  // a 1.5x band sweeps sooner
  assert.equal(sweepNeeded(y, 17_400n * 10n ** 6n, 2000, V, 15_000), true);
  // hot below target but at 10% or more: inside the band
  assert.equal(sweepNeeded(y, 22_500n * 10n ** 6n, 2000, V, 20_000), false);
  // hot under 10% (after sells): sweep pulls it back to 20%
  assert.equal(sweepNeeded(y, 22_501n * 10n ** 6n, 2000, V, 20_000), true);
  // hot 0, everything in Morpho (mainnet Nov 13 after a $25 sell: 76.40 USDG, all in the tail)
  assert.equal(sweepNeeded(76_403_500n, 76_403_500n, 2000, V, 20_000), true);
  // nothing in Morpho yet: all hot, so it goes in
  assert.equal(sweepNeeded(1_000_000n, 0n, 2000, V, 20_000), true);
  // tail off, closing (hot target 100%), or tail above the book: never
  assert.equal(sweepNeeded(y, 0n, 2000, Z, 20_000), false);
  assert.equal(sweepNeeded(y, 1n, 10_000, V, 20_000), false);
  assert.equal(sweepNeeded(y, y + 1n, 2000, V, 20_000), false);
});

test("Carry stock queue: config, and matchDue sends only for markets a dry run would match", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-q-"));
  const f = join(dir, "c.json");
  const Q = "0x1111111111111111111111111111111111111111";
  const V = "0x2222222222222222222222222222222222222222";
  writeFileSync(
    f,
    JSON.stringify({
      chains: { robinhood: { rpcEnv: "RH_RPC", chainId: 4663 } },
      sameChain: [{ name: "carry", chain: "robinhood", hook: "0xcedc3c312c5b3c4310f0fba0323ddec797e4aa88", abi: "carry", stockQueue: Q }],
    }),
  );
  const cfg = loadConfig(f, { RH_RPC: "http://127.0.0.1:1" });
  assert.equal(cfg.sameChain[0].stockQueue, Q);
  const k = new Keeper(cfg, { routes: {} } as never, privateKeyToAccount(("0x" + "11".repeat(32)) as Hex), { info() {}, warn() {}, error() {} } as never);
  // three markets: 0 has nothing waiting, 1 waits but no USDG is free (dry run matches 0), 2 can match
  const sims: bigint[] = [];
  const pub = {
    readContract: async ({ functionName, args }: { functionName: string; args?: bigint[] }) =>
      functionName === "vault" ? V : functionName === "marketCount" ? 3n : functionName === "waiting" ? [0n, 5n, 7n][Number(args![0])] : 0n,
    simulateContract: async ({ args }: { args: bigint[] }) => {
      sims.push(args[0]);
      return { result: args[0] === 2n ? 7n : 0n };
    },
  };
  (k as unknown as { clients: Map<string, unknown> }).clients.set("robinhood", { pub, wal: {}, chain: {} });
  const sent: bigint[] = [];
  (k as unknown as { matchOrders: (...a: unknown[]) => Promise<void> }).matchOrders = async (_s, _q, m) => {
    sent.push(m as bigint);
  };
  await k.matchDue(cfg.sameChain[0]);
  assert.deepEqual(sims, [1n, 2n], "no dry run where nothing waits");
  assert.deepEqual(sent, [2n], "a transaction only where the dry run matches");
  // checked again only after matchEverySec
  await k.matchDue(cfg.sameChain[0]);
  assert.deepEqual(sent, [2n]);
});

test("Carry stock queue: a blocked match with USDG free samples the pool (unpaid), then once more, within the cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-u-"));
  const f = join(dir, "c.json");
  const P = ("0x" + "ab".repeat(32)) as Hex;
  writeFileSync(
    f,
    JSON.stringify({
      chains: { robinhood: { rpcEnv: "RH_RPC", chainId: 4663 } },
      sameChain: [{ name: "carry", chain: "robinhood", hook: "0xcedc3c312c5b3c4310f0fba0323ddec797e4aa88", abi: "carry", stockQueue: "0x1111111111111111111111111111111111111111" }],
      sampling: { matchSampleMaxPerHour: 2, minGapSec: 0 },
    }),
  );
  const cfg = loadConfig(f, { RH_RPC: "http://127.0.0.1:1" });
  assert.equal(loadConfig(f, { RH_RPC: "x" }).sampling.matchSampleMaxPerHour, 2);
  const state = { routes: { carry: { pools: { [P]: { kind: 4 } } } } };
  const k = new Keeper(cfg, state as never, privateKeyToAccount(("0x" + "11".repeat(32)) as Hex), { info() {}, warn() {}, error() {} } as never);
  let free = 30_000_000n;
  const pub = {
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "freeUsdg" ? free : functionName === "markets" ? { pool: P, active: true } : 0n,
  };
  (k as unknown as { clients: Map<string, unknown> }).clients.set("robinhood", { pub, wal: {}, chain: {} });
  let gap = 20;
  (k as unknown as { leaderGapBps: () => Promise<number> }).leaderGapBps = async () => gap;
  const sampled: boolean[] = [];
  (k as unknown as { sample: (s: unknown, id: Hex, paid: boolean) => Promise<void> }).sample = async (_s, _id, paid) => {
    sampled.push(paid);
  };
  const V = "0x2222222222222222222222222222222222222222" as Hex;
  await k.unblockMatch(cfg.sameChain[0], V, 0n, { pool: P, active: true });
  assert.deepEqual(sampled, [false], "off the leader with USDG free: one unpaid sample");
  gap = 2;
  await k.unblockMatch(cfg.sameChain[0], V, 0n, { pool: P, active: true });
  assert.deepEqual(sampled, [false, false], "right after: one more reading, even though the centre is now close");
  await k.unblockMatch(cfg.sameChain[0], V, 0n, { pool: P, active: true });
  assert.equal(sampled.length, 2, "capped at matchSampleMaxPerHour");
  free = 0n;
  gap = 50;
  (k as unknown as { matchSampled: Map<string, number[]> }).matchSampled.clear();
  await k.unblockMatch(cfg.sameChain[0], V, 0n, { pool: P, active: true });
  assert.equal(sampled.length, 2, "no free USDG: a sample would not help");
});

test("Carry vault markets: per-market-hook layout first, launch layout as fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-u-"));
  const f = join(dir, "c.json");
  const P = ("0x" + "AB".repeat(32)) as Hex;
  const H = "0x3333333333333333333333333333333333333333" as Hex;
  writeFileSync(f, JSON.stringify({ chains: { robinhood: { rpcEnv: "RH_RPC", chainId: 4663 } }, sameChain: [{ name: "carry", chain: "robinhood", hook: "0xcedc3c312c5b3c4310f0fba0323ddec797e4aa88", abi: "carry" }] }));
  const cfg = loadConfig(f, { RH_RPC: "http://127.0.0.1:1" });
  const k = new Keeper(cfg, { routes: {} } as never, privateKeyToAccount(("0x" + "11".repeat(32)) as Hex), { info() {}, warn() {} } as never);
  let newVault = true;
  const pub = {
    readContract: async ({ abi }: { abi: { name?: string; outputs?: { components?: unknown[] }[] }[] }) => {
      const words = abi.find((x) => x.name === "markets")!.outputs![0].components!.length;
      if (newVault && words === 8) return { token: H, hook: H, pool: P, active: true };
      if (!newVault && words === 7) return { token: H, pool: P, active: false };
      throw new Error("decode: data too small");
    },
  };
  (k as unknown as { clients: Map<string, unknown> }).clients.set("robinhood", { pub, wal: {}, chain: {} });
  const V = "0x2222222222222222222222222222222222222222" as Hex;
  assert.deepEqual(await k.market(cfg.sameChain[0], V, 0n), { pool: P.toLowerCase(), active: true, hook: H });
  newVault = false;
  assert.deepEqual(await k.market(cfg.sameChain[0], V, 0n), { pool: P.toLowerCase(), active: false });
});

test("Carry stock queue: two entries on one queue each match only their own pools", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-u-"));
  const f = join(dir, "c.json");
  const A = ("0x" + "aa".repeat(32)) as Hex, B = ("0x" + "bb".repeat(32)) as Hex, C = ("0x" + "cc".repeat(32)) as Hex;
  const Q = "0x1111111111111111111111111111111111111111";
  writeFileSync(
    f,
    JSON.stringify({
      chains: { robinhood: { rpcEnv: "RH_RPC", chainId: 4663 } },
      sameChain: [
        { name: "mstr", chain: "robinhood", hook: "0xcedc3c312c5b3c4310f0fba0323ddec797e4aa88", abi: "carry", stockQueue: Q },
        { name: "nvda", chain: "robinhood", hook: "0x3333333333333333333333333333333333333333", abi: "carry", stockQueue: Q },
      ],
    }),
  );
  const cfg = loadConfig(f, { RH_RPC: "http://127.0.0.1:1" });
  const state = { routes: { mstr: { pools: { [A]: {} } }, nvda: { pools: { [B]: {} } } } };
  const k = new Keeper(cfg, state as never, privateKeyToAccount(("0x" + "11".repeat(32)) as Hex), { info() {}, warn() {} } as never);
  const [m, n] = cfg.sameChain;
  assert.equal(k.ownsPool(m, A), true);
  assert.equal(k.ownsPool(m, B), false);
  assert.equal(k.ownsPool(n, B), true);
  assert.equal(k.ownsPool(n, A), false);
  assert.equal(k.ownsPool(m, C), true, "a pool nobody lists goes to the first entry on the queue");
  assert.equal(k.ownsPool(n, C), false);
});

test("Carry v0.3 settle: hourly, only when the epoch earned something and nobody paid out; launch hooks left alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-u-"));
  const f = join(dir, "c.json");
  const A = ("0x" + "aa".repeat(32)) as Hex, B = ("0x" + "bb".repeat(32)) as Hex;
  const H3 = "0xcedc3c312c5b3c4310f0fba0323ddec797e4aa88", HL = "0x3333333333333333333333333333333333333333";
  writeFileSync(
    f,
    JSON.stringify({
      chains: { robinhood: { rpcEnv: "RH_RPC", chainId: 4663 } },
      sameChain: [
        { name: "v03", chain: "robinhood", hook: H3, abi: "carry" },
        { name: "launch", chain: "robinhood", hook: HL, abi: "carry" },
      ],
    }),
  );
  const cfg = loadConfig(f, { RH_RPC: "http://127.0.0.1:1" });
  assert.equal(cfg.sampling.settleEverySec, 3600);
  assert.equal(cfg.sampling.settleCheckSec, 300);
  const state = { routes: { v03: { pools: { [A]: {} } }, launch: { pools: { [B]: {} } } } };
  const k = new Keeper(cfg, state as never, privateKeyToAccount(("0x" + "11".repeat(32)) as Hex), { info() {}, warn() {} } as never);
  const nowS = BigInt(Math.floor(Date.now() / 1000));
  // pool A's storage: +8 = settledBlock | settledAt | sampleBlock | sampleAt, +13/+14 = book x/y, +15 = dx | dy
  let settledAt = nowS - 4000n, dy = 5n, sampleAt = nowS - 20n;
  const base = poolBaseOf(A);
  const store = (o: bigint): bigint => {
    if (o === 8n) return 777n | (settledAt << 64n) | (778n << 128n) | (sampleAt << 192n);
    if (o === 13n) return 1000n;
    if (o === 14n) return 2000n;
    if (o === 15n) return BigInt.asUintN(128, 3n) | (BigInt.asUintN(128, dy) << 128n);
    return 0n;
  };
  const calls: string[] = [];
  const pub = {
    getBlockNumber: async () => 1n,
    getStorageAt: async ({ slot }: { slot: Hex }) => pad(toHex(store(BigInt(slot) - base)), { size: 32 }),
    readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
      calls.push(`${address.toLowerCase() === HL ? "L" : "3"}:${functionName}`);
      if (address.toLowerCase() === HL) throw new Error("execution reverted"); // launch hook: no settleEvery
      if (functionName === "settleEvery") return 21600;
      return { ageOrBlock: 777n, sampleAt, coinReserve: 1000n, quoteReserve: 2000n };
    },
  };
  (k as unknown as { clients: Map<string, unknown> }).clients.set("robinhood", { pub, wal: {}, chain: {} });
  const settled: Hex[] = [];
  (k as unknown as { settle: (s: unknown, id: Hex) => Promise<void> }).settle = async (_s, id) => {
    settled.push(id);
  };
  const [v03, launch] = cfg.sameChain;
  const again = async () => {
    (k as unknown as { lastSettleCheck: Map<string, number> }).lastSettleCheck.clear();
    await k.settleDue(v03);
  };
  await k.settleDue(v03);
  assert.deepEqual(settled, [A], "fees earned, last payout over an hour ago: settle");
  await k.settleDue(v03);
  assert.equal(settled.length, 1, "not checked again within settleCheckSec");
  settledAt = nowS - 600n; // a deposit / withdraw / claim paid out 10 min ago
  await again();
  assert.equal(settled.length, 1, "paid out within the hour: skip");
  settledAt = nowS - 4000n;
  dy = 0n;
  await again();
  assert.equal(settled.length, 1, "nothing earned: skip");
  dy = -9n; // a sell-heavy epoch still has fees to pay
  await again();
  assert.equal(settled.length, 2);
  sampleAt = nowS - 1n; // storage no longer matches poolState
  const view = pub.readContract;
  pub.readContract = async (a) => (a.functionName === "poolState" ? { ageOrBlock: 777n, sampleAt: nowS - 99n, coinReserve: 1000n, quoteReserve: 2000n } : view(a));
  await again();
  assert.equal(settled.length, 2, "layout check failed: no guess");
  await k.settleDue(launch);
  await k.settleDue(launch);
  assert.deepEqual(calls.filter((c) => c.startsWith("L")), ["L:settleEvery"], "launch hook asked once, then left alone");
});

test("low ETH: warns below alerts.minEth, at most every balanceEverySec", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-u-"));
  const f = join(dir, "c.json");
  writeFileSync(f, JSON.stringify({ chains: { robinhood: { rpcEnv: "RH_RPC", chainId: 4663 } }, sameChain: [{ name: "carry", chain: "robinhood", hook: "0xcedc3c312c5b3c4310f0fba0323ddec797e4aa88", abi: "carry" }], alerts: { minEth: "0.003" } }));
  const cfg = loadConfig(f, { RH_RPC: "http://127.0.0.1:1" });
  assert.equal(cfg.alerts.minEth, 3_000_000_000_000_000n);
  const warns: string[] = [];
  const k = new Keeper(cfg, { routes: {} } as never, privateKeyToAccount(("0x" + "11".repeat(32)) as Hex), { info() {}, warn: (m: string) => warns.push(m) } as never);
  let bal = 2_000_000_000_000_000n;
  let reads = 0;
  const pub = { getBalance: async () => (reads++, bal) };
  (k as unknown as { clients: Map<string, unknown> }).clients.set("robinhood", { pub, wal: {}, chain: {} });
  await k.balanceDue(cfg.sameChain[0].chain);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /0\.002 ETH on robinhood/);
  await k.balanceDue(cfg.sameChain[0].chain);
  assert.equal(reads, 1, "read again only after balanceEverySec");
  (k as unknown as { lastBalanceCheck: Map<string, number> }).lastBalanceCheck.clear();
  bal = 5_000_000_000_000_000n;
  await k.balanceDue(cfg.sameChain[0].chain);
  assert.equal(warns.length, 1, "enough ETH: quiet");
});
