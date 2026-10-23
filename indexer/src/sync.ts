import { createPublicClient, http, type Address, type PublicClient } from "viem";
import type { Config, Stack } from "./config.js";
import { wipeStack, type DB } from "./db.js";
import { decodeEventLog } from "viem";
import { EVENTS } from "./abi.js";
import { applyLogs, type RawLog } from "./ingest.js";

/** Coins launched by this stack's Launchpad within a batch of core logs. */
export function launchedIn(core: RawLog[], stack: Stack): { token: Address; curve: Address }[] {
  const out: { token: Address; curve: Address }[] = [];
  for (const l of core) {
    if (l.address.toLowerCase() !== stack.launchpad.toLowerCase()) continue;
    try {
      const ev: any = decodeEventLog({ abi: EVENTS, data: l.data, topics: l.topics as any, strict: true });
      if (ev.eventName === "Launched") out.push({ token: ev.args.token, curve: ev.args.curve });
    } catch {}
  }
  return out;
}
import { RateLimiter, getLogsAdaptive, isRangeError, withRetry } from "./rpc.js";

export function makeClient(cfg: Config): PublicClient {
  // viem-level retries off: our withRetry owns backoff so the rate limiter sees every attempt.
  return createPublicClient({ transport: http(cfg.rpcUrl, { retryCount: 0, timeout: 30_000 }) }) as PublicClient;
}

export const coreAddrs = (s: Stack) =>
  [s.launchpad, s.feeRouter, s.hook, s.migration, s.trampWallManager, s.anonLauncher, s.anonLauncherLegacy, s.rewardsVault, s.referralRegistry, s.lockedLP, s.usdgDepositNotifier].filter(Boolean) as Address[];

export class Syncer {
  private limiter: RateLimiter;
  private tsCache = new Map<bigint, number>();
  constructor(private db: DB, private client: PublicClient, private cfg: Config, private log: (m: string) => void = console.log) {
    this.limiter = new RateLimiter(cfg.rpcRps);
  }
  private retry = <T>(f: () => Promise<T>) => withRetry(f, { limiter: this.limiter, noRetry: isRangeError });

  private logs(address: Address[], from: bigint, to: bigint) {
    return getLogsAdaptive<RawLog>(
      (a, b) => this.client.getLogs({ address, fromBlock: a, toBlock: b }) as Promise<RawLog[]>, from, to, this.cfg.minChunk, this.retry);
  }

  private async fillTs(logs: RawLog[]) {
    const need = [...new Set(logs.map((l) => l.blockNumber!))].filter((b) => !this.tsCache.has(b));
    for (let i = 0; i < need.length; i += 10) {
      await Promise.all(need.slice(i, i + 10).map(async (b) => {
        const blk = await this.retry(() => this.client.getBlock({ blockNumber: b }));
        this.tsCache.set(b, Number(blk.timestamp));
      }));
    }
    if (this.tsCache.size > 50_000) this.tsCache.clear();
  }

  /**
   * Reorg check: compare the stored hash of the stack's cursor block with the chain. On mismatch, walk back over stored hashes to the
   * last block that still matches; if none of the retained hashes matches (deep reorg) rebuild the stack from fromBlock. Because
   * balances/orders are mutable aggregates, recovery = wipe the stack's derived rows and replay from the fork point's stack start
   * (cheap on testnet scale; see README for the Postgres upgrade path with per-block undo).
   */
  async checkReorg(stack: Stack): Promise<boolean> {
    const rows = this.db.prepare("SELECT block, hash FROM block_hashes WHERE stack=? ORDER BY block DESC").all(stack.id) as { block: number; hash: string }[];
    if (!rows.length) return false;
    const blk = await this.retry(() => this.client.getBlock({ blockNumber: BigInt(rows[0].block) }));
    if (blk.hash === rows[0].hash) return false;
    this.log(`[${stack.id}] REORG detected at ${rows[0].block} (stored ${rows[0].hash}, chain ${blk.hash}); rebuilding stack`);
    wipeStack(this.db, stack.id);
    return true;
  }

  private saveHash(stack: Stack, block: bigint, hash: string) {
    this.db.prepare("INSERT OR REPLACE INTO block_hashes VALUES (?,?,?)").run(stack.id, Number(block), hash);
    this.db.prepare("DELETE FROM block_hashes WHERE stack=? AND block < ?").run(stack.id, Number(block) - this.cfg.reorgDepth);
  }

  /** Index one stack from its cursor up to `head`. Two passes per chunk: core contracts (discovers coins), then curves+tokens. */
  async syncStack(stack: Stack, head: bigint) {
    await this.checkReorg(stack);
    const row = this.db.prepare("SELECT block FROM cursor WHERE stack=?").get(stack.id) as { block: number } | undefined;
    let from = row ? BigInt(row.block) + 1n : stack.fromBlock;
    while (from <= head) {
      const to = from + this.cfg.chunk - 1n > head ? head : from + this.cfg.chunk - 1n;
      const core = await this.logs(coreAddrs(stack), from, to);
      // Coins known before this chunk + coins launched inside it (decoded without writing), so the whole chunk applies atomically.
      const known = this.db.prepare("SELECT token, curve FROM coins WHERE stack=?").all(stack.id) as { token: Address; curve: Address }[];
      const addrs = [...known.flatMap((c) => [c.curve, c.token]), ...launchedIn(core, stack).flatMap((c) => [c.curve, c.token])];
      const sub: RawLog[] = [];
      for (let i = 0; i < addrs.length; i += 200) sub.push(...(await this.logs(addrs.slice(i, i + 200), from, to)));
      const all = core.concat(sub).sort((x, y) => Number(x.blockNumber! - y.blockNumber!) || Number(x.logIndex! - y.logIndex!));
      await this.fillTs(all);
      const toBlk = await this.retry(() => this.client.getBlock({ blockNumber: to }));
      this.db.transaction(() => {
        applyLogs(this.db, stack, all, (b) => this.tsCache.get(b)!);
        this.db.prepare("INSERT INTO cursor (stack, block) VALUES (?, ?) ON CONFLICT(stack) DO UPDATE SET block = excluded.block").run(stack.id, Number(to));
        this.saveHash(stack, to, toBlk.hash!);
      })();
      const core_n = core.length;
      if (core_n || sub.length || to - from >= 1000n) this.log(`[${stack.id}] ${from}-${to}: core ${core_n}, curve/token ${sub.length}`);
      from = to + 1n;
    }
  }

  async syncAll() {
    const tip = await this.retry(() => this.client.getBlockNumber());
    const head = tip - BigInt(this.cfg.confirmations);
    for (const s of this.cfg.stacks) await this.syncStack(s, head);
    return head;
  }
}

/** Back-compat helper. */
export async function syncAll(db: DB, client: PublicClient, cfg: Config, log = console.log) {
  return new Syncer(db, client, cfg, log).syncAll();
}
