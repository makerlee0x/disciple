// Parallel sends, multicall detection, health file and alerts for an unattended keeper.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { loadConfig } from "../src/config.ts";
import { Health, judgeHealth } from "../src/health.ts";
import { Keeper, limit } from "../src/keeper.ts";

const KEY = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex);
const HOOK = "0xcedc3c312c5b3c4310f0fba0323ddec797e4aa88";
const quiet = { info() {}, warn() {} };

function cfgFile(extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "keeper-h-"));
  const f = join(dir, "c.json");
  writeFileSync(
    f,
    JSON.stringify({
      stateFile: join(dir, "state.json"),
      chains: { robinhood: { rpcEnv: "RH_RPC", chainId: 4663 } },
      sameChain: [{ name: "carry", chain: "robinhood", hook: HOOK, abi: "carry", scanPools: false }],
      ...extra,
    }),
  );
  return { f, dir, cfg: loadConfig(f, { RH_RPC: "http://127.0.0.1:1" }) };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test("limit: never more than n at once, every task runs, one failure does not stop the rest", async () => {
  let running = 0, peak = 0, done = 0;
  const errs: unknown[] = [];
  const tasks = Array.from({ length: 9 }, (_, i) => async () => {
    running++;
    peak = Math.max(peak, running);
    await tick();
    running--;
    if (i === 3) throw new Error("boom");
    done++;
  });
  await limit(3, tasks, (e) => errs.push(e));
  assert.equal(peak, 3);
  assert.equal(done, 8);
  assert.equal(errs.length, 1);
  await limit(4, [], () => {}); // nothing to do: returns
});

test("send: nonces handed out in order, receipts awaited in parallel, a failed broadcast re-reads the nonce", async () => {
  const { cfg } = cfgFile();
  const k = new Keeper(cfg, { routes: {} } as never, KEY, quiet);
  const broadcast: number[] = [];
  let pendingReads = 0, waiting = 0, peakWaiting = 0;
  const release: (() => void)[] = [];
  const pub = {
    getTransactionCount: async () => (pendingReads++, 7),
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      waiting++;
      peakWaiting = Math.max(peakWaiting, waiting);
      await new Promise<void>((r) => release.push(r));
      waiting--;
      return { status: "success", gasUsed: 100n, effectiveGasPrice: 2n, logs: [], hash };
    },
  };
  (k as unknown as { clients: Map<string, unknown> }).clients.set("robinhood", { pub, wal: {}, chain: {} });
  const send = (k as unknown as { send: (c: unknown, kind: string, fn: (n: number) => Promise<Hex>) => Promise<{ hash: Hex }> }).send.bind(k);
  const chain = cfg.chains.robinhood;
  const p = [0, 1, 2].map(() => send(chain, "sample", async (n) => (broadcast.push(n), `0x${n}` as Hex)));
  while (release.length < 3) await tick();
  assert.deepEqual(broadcast, [7, 8, 9], "one nonce each, in order");
  assert.equal(pendingReads, 1, "nonce read once, then tracked");
  assert.equal(peakWaiting, 3, "all three wait for receipts at the same time");
  release.forEach((r) => r());
  assert.deepEqual((await Promise.all(p)).map((x) => x.hash), ["0x7", "0x8", "0x9"]);
  assert.equal(k.health.day().sample.sent, 3);
  assert.equal(k.health.day().sample.gasEth, "0.0000000000000006");
  // a broadcast that fails drops the cached nonce: the next send reads it fresh
  await assert.rejects(send(chain, "sweep", async () => Promise.reject(new Error("rpc down"))));
  const q = send(chain, "sweep", async (n) => (broadcast.push(n), "0xa" as Hex));
  while (release.length < 4) await tick();
  release[3]();
  await q;
  assert.equal(pendingReads, 2);
});

test("send: no receipt in time is reported stuck, and the nonce is read fresh next time", async () => {
  const { cfg } = cfgFile({ alerts: { stuckTxSec: 1 } });
  const warns: string[] = [];
  const k = new Keeper(cfg, { routes: {} } as never, KEY, { info() {}, warn: (m: string) => warns.push(m) });
  let reads = 0;
  const pub = {
    getTransactionCount: async () => (reads++, 3),
    waitForTransactionReceipt: async ({ timeout }: { timeout: number }) => {
      assert.equal(timeout, 1000);
      throw new Error("Timed out while waiting for transaction");
    },
  };
  (k as unknown as { clients: Map<string, unknown> }).clients.set("robinhood", { pub, wal: {}, chain: {} });
  const send = (k as unknown as { send: (c: unknown, kind: string, fn: (n: number) => Promise<Hex>) => Promise<unknown> }).send.bind(k);
  await assert.rejects(send(cfg.chains.robinhood, "settle", async () => "0xdead" as Hex));
  assert.equal(k.health.stuck, 1);
  assert.match(warns[0], /settle tx 0xdead on robinhood has no receipt after 1s/);
  await assert.rejects(send(cfg.chains.robinhood, "settle", async () => "0xbeef" as Hex));
  assert.equal(reads, 2);
});

test("multicall: on only where Multicall3 has code; 'off' in the config never batches", async () => {
  for (const [mc, code, want] of [[undefined, "0x6080", true], [undefined, "0x", false], ["off", "0x6080", false]] as const) {
    const { cfg } = cfgFile({ chains: { robinhood: { rpcEnv: "RH_RPC", chainId: 4663, ...(mc ? { multicall3: mc } : {}) } } });
    const k = new Keeper(cfg, { routes: {} } as never, KEY, quiet);
    const pub = { getChainId: async () => 4663, getBalance: async () => 10n ** 16n, getCode: async () => code };
    const clients = (k as unknown as { clients: Map<string, { pub: unknown; chain: { contracts?: unknown } }> }).clients;
    clients.set("robinhood", { pub, wal: {}, chain: {} } as never);
    await k.checkChains();
    assert.equal(k.health.multicall.robinhood, want);
    const c = clients.get("robinhood")!;
    if (want) {
      assert.notEqual(c.pub, pub, "clients rebuilt with batching");
      assert.deepEqual(c.chain.contracts, { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } });
    } else assert.equal(c.pub, pub);
  }
});

test("health: a stale RPC head fails the round; the health file is written each round", async () => {
  const { cfg } = cfgFile();
  const k = new Keeper(cfg, { routes: { carry: { pools: {} } } } as never, KEY, quiet);
  const t = Math.floor(Date.now() / 1000);
  let headTs = t - 5;
  const pub = { getBlock: async () => ({ number: 100n, timestamp: BigInt(headTs) }), getBalance: async () => 10n ** 16n };
  (k as unknown as { clients: Map<string, unknown> }).clients.set("robinhood", { pub, wal: {}, chain: {} });
  await k.sampleTick();
  assert.equal(k.health.failuresInARow, 0, k.health.lastError);
  assert.ok(existsSync(cfg.healthFile));
  const h = JSON.parse(readFileSync(cfg.healthFile, "utf8"));
  assert.equal(h.chains.robinhood.head, 100);
  assert.equal(h.chains.robinhood.balanceEth, "0.01");
  headTs = t - 3600;
  (k as unknown as { lastHeadCheck: Map<string, number> }).lastHeadCheck.clear();
  await k.sampleTick();
  assert.equal(k.health.failuresInARow, 1);
  assert.match(k.health.lastError, /RPC head 100 is \d+s old/);
});

test("health: a pool off its leader is tracked, and alerts only after offLeaderSec", () => {
  const h = new Health();
  assert.equal(h.gap("0xaa", "carry", 30, 100), 0);
  assert.equal(h.gap("0xaa", "carry", 150, 100), 0, "just went off");
  h.pools["0xaa"].offSince -= 2000;
  assert.ok(h.gap("0xaa", "carry", 160, 100) >= 2000, "still off: the clock keeps running");
  assert.equal(h.gap("0xaa", "carry", 20, 100), 0, "back at the leader: reset");
  assert.equal(h.pools["0xaa"].offSince, 0);
});

test("judgeHealth: healthy, then each problem on its own", () => {
  const t = 1_000_000;
  const o = { stallSec: 900, staleHeadSec: 300, minEth: "0.003", offLeaderSec: 1800 };
  const base = {
    pid: 1,
    wallet: "0x",
    startedAt: t - 7200,
    lastRoundAt: t - 10,
    lastOkAt: t - 10,
    lastError: "",
    failuresInARow: 0,
    multicall: { robinhood: true },
    chains: { robinhood: { head: 1, headAt: t - 12, balanceEth: "0.009", inFlight: 0 } },
    pools: { "0xabcdef0123": { entry: "carry", gapBps: 4, at: t - 30, offSince: 0 } },
    day: {},
    stuck: 0,
    lastStuckAt: 0,
  };
  assert.deepEqual(judgeHealth(base, t, o), { ok: true, problems: [] });
  const bad = (patch: object) => judgeHealth({ ...base, ...patch }, t, o).problems;
  assert.match(bad({ lastOkAt: t - 1000, lastError: "carry: rpc down" })[0], /no good round for 1000s \(last error: carry: rpc down\)/);
  assert.match(bad({ chains: { robinhood: { ...base.chains.robinhood, headAt: t - 900 } } })[0], /RPC head is 890s old/);
  assert.match(bad({ chains: { robinhood: { ...base.chains.robinhood, balanceEth: "0.001" } } })[0], /0.001 ETH, below 0.003/);
  assert.match(bad({ pools: { "0xabcdef0123": { entry: "carry", gapBps: 140, at: t, offSince: t - 2000 } } })[0], /140 bps off its leader for 2000s/);
  assert.match(bad({ stuck: 2, lastStuckAt: t - 60 })[0], /got stuck 60s ago \(2 since start\)/);
  assert.equal(bad({ stuck: 2, lastStuckAt: t - 7200 }).length, 0, "an old stuck tx is history, not a problem");
});

test("summary: transactions by kind, gas, balance and pool gaps in one message", () => {
  const h = new Health();
  h.tx("sample", true, 10n ** 12n);
  h.tx("sample", false, 10n ** 12n);
  h.tx("settle", true, 3n * 10n ** 12n);
  h.chain("robinhood").balanceEth = "0.0094";
  h.gap("0xdf918ec569657b70", "carry", 7, 100);
  const s = h.summary();
  assert.match(s, /2 sample \(1 reverted\), 1 settle, gas 0.000005 ETH/);
  assert.match(s, /0.0094 ETH on robinhood/);
  assert.match(s, /0xdf918ec5 7 bps off its leader/);
});
