import { createPublicClient, http, type Address, type PublicClient } from "viem";
import type { Config, Stack } from "./config.js";
import type { DB } from "./db.js";
import { applyLogs, type RawLog } from "./ingest.js";

export function makeClient(cfg: Config): PublicClient {
  return createPublicClient({ transport: http(cfg.rpcUrl, { retryCount: 3, batch: { batchSize: 50 } }) }) as PublicClient;
}

const coreAddrs = (s: Stack) =>
  [s.launchpad, s.feeRouter, s.hook, s.migration, s.trampWallManager, s.anonLauncher, s.rewardsVault].filter(Boolean) as Address[];

/** Index one stack from its cursor up to `head`. Two passes per chunk: core contracts (discovers coins), then curves+tokens. */
export async function syncStack(db: DB, client: PublicClient, cfg: Config, stack: Stack, head: bigint, log = console.log) {
  const row = db.prepare("SELECT block FROM cursor WHERE stack=?").get(stack.id) as { block: number } | undefined;
  let from = row ? BigInt(row.block) + 1n : stack.fromBlock;
  const tsCache = new Map<bigint, number>();
  while (from <= head) {
    const to = from + cfg.chunk - 1n > head ? head : from + cfg.chunk - 1n;
    const core = (await client.getLogs({ address: coreAddrs(stack), fromBlock: from, toBlock: to })) as RawLog[];
    await fillTs(client, core, tsCache);
    applyLogs(db, stack, core, (b) => tsCache.get(b)!);
    const coins = db.prepare("SELECT token, curve FROM coins WHERE stack=?").all(stack.id) as { token: Address; curve: Address }[];
    const addrs = coins.flatMap((c) => [c.curve, c.token]);
    const sub: RawLog[] = [];
    for (let i = 0; i < addrs.length; i += 200) {
      if (addrs.length) sub.push(...((await client.getLogs({ address: addrs.slice(i, i + 200), fromBlock: from, toBlock: to })) as RawLog[]));
    }
    sub.sort((x, y) => Number(x.blockNumber! - y.blockNumber!) || Number(x.logIndex! - y.logIndex!));
    await fillTs(client, sub, tsCache);
    applyLogs(db, stack, sub, (b) => tsCache.get(b)!);
    db.prepare("INSERT INTO cursor (stack, block) VALUES (?, ?) ON CONFLICT(stack) DO UPDATE SET block = excluded.block").run(stack.id, Number(to));
    log(`[${stack.id}] ${from}-${to}: core ${core.length}, curve/token ${sub.length}`);
    from = to + 1n;
  }
}

async function fillTs(client: PublicClient, logs: RawLog[], cache: Map<bigint, number>) {
  const need = [...new Set(logs.map((l) => l.blockNumber!))].filter((b) => !cache.has(b));
  await Promise.all(
    need.map(async (b) => {
      const blk = await client.getBlock({ blockNumber: b });
      cache.set(b, Number(blk.timestamp));
    }),
  );
}

export async function syncAll(db: DB, client: PublicClient, cfg: Config, log = console.log) {
  const head = await client.getBlockNumber();
  for (const s of cfg.stacks) await syncStack(db, client, cfg, s, head, log);
  return head;
}
