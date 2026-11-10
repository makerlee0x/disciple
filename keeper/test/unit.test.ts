import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { concat, pad, toHex, type Hex } from "viem";
import { batch, judge, type Due } from "../src/keeper.ts";
import { decodeSource, jarValue, OFF, POOLS_SLOT, type PoolDyn, type PoolSource } from "../src/hook.ts";
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
  assert.deepEqual(c.sampling, { everySec: 2, missesBeforeRest: 3, restSec: 3600 });
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
