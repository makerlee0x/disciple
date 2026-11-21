// Round-8 KEEPER-1/2: a total RPC outage (every call fails) must alert and stop the heartbeat, and must not switch
// settle off for 6 h. Runs the real Keeper.sampleTick with a mock client; nothing is sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../src/config.ts";
import { Keeper } from "../src/keeper.ts";

test("RPC down for 30 minutes: alerts once, heartbeat stops, settle not parked (round-8 KEEPER-1/2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-poc-"));
  const f = join(dir, "c.json");
  const ID = "0xdf918ec569657b705c4973e1312814152e42a4a01e93634b480b3ac26b8819fa";
  // the production config (carry-keeper-v03.json), stateFile moved to a temp dir
  writeFileSync(f, JSON.stringify({
    stateFile: join(dir, "state.json"), pollSeconds: 12,
    chains: { robinhood: { rpcEnv: "RH_RPC", logChunk: 10, logCallsPerTick: 20, priorityFeeGwei: "0", maxFeeGwei: "1" } },
    routes: [],
    sameChain: [{ name: "carry-v03", chain: "robinhood", abi: "carry", hook: "0x5800dd5c9D56C1DC9e6eB05892a6BA8e039B2A88",
      stockQueue: "0x8CdB05e1f08aC273CbE7314834d7864259Fd34c1", fromBlock: 113901224, scanPools: false, pools: [ID] }],
    sampling: { selfPayBps: 15, selfPayMaxPerHour: 12 }, alerts: { minEth: "0.003" },
  }));
  const cfg = loadConfig(f, { RH_RPC: "http://127.0.0.1:1" });
  const state = { routes: { "carry-v03": { pools: { [ID]: { kind: 3, coinIs0: false, remoteEid: 0, target: "0x8366a39cc670b4001a1121b8f6a443a643e40951", v4Id: "0x" + "00".repeat(32), decShift: 0, push: false, kind2: 0 } } } }, packets: [] };
  const k = new Keeper(cfg, state as never, privateKeyToAccount(("0x" + "11".repeat(32)) as `0x${string}`), { info() {}, warn() {} } as never);
  const down = async () => { throw new Error("HTTP request failed."); };
  const pub = new Proxy({}, { get: () => down });
  (k as unknown as { clients: Map<string, unknown> }).clients.set("robinhood", { pub, wal: {}, chain: {} });

  process.env.ALERT_URL = "https://alerts.invalid/topic";
  process.env.HEARTBEAT_URL = "https://hc.invalid/ping";
  const alerts: string[] = [];
  let beats = 0;
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    if (url.includes("hc.invalid")) beats++;
    else alerts.push(String(init?.body));
    return new Response("ok");
  }) as typeof fetch;
  let clock = Date.now();
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    const rounds = (30 * 60) / cfg.sampling.everySec; // 30 minutes of 13 s rounds
    let maxFailures = 0;
    for (let i = 0; i < rounds; i++) {
      await k.sampleTick();
      maxFailures = Math.max(maxFailures, (k as unknown as { failures: Map<string, number> }).failures.get("carry-v03") ?? 0);
      clock += cfg.sampling.everySec * 1000;
    }
    const noSettle = (k as unknown as { noSettleUntil: Map<string, number> }).noSettleUntil.get(ID) ?? 0;
    console.log(`rounds ${Math.floor(rounds)}, max consecutive failures ${maxFailures}, alerts ${alerts.length}, heartbeats ${beats}, settle off for ${noSettle - Math.floor(clock / 1000)} s more`);
    assert.ok(maxFailures >= cfg.alerts.errorsBeforeAlert, "every round fails while the RPC is down");
    assert.equal(alerts.length, 1, "one failure alert");
    assert.equal(beats, 0, "no heartbeat while the RPC is down, so the dead-man check fires");
    assert.ok(noSettle - Math.floor(clock / 1000) < 3600, "an RPC error does not park settle for 6 h");
  } finally {
    Date.now = realNow;
  }
});
