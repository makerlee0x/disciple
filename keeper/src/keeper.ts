// The keeper loop. Cross-chain pools: push the home source price when the hook will pay for it, finish delivery on
// the destination (DiscipleSelfExecutor: nobody else is paid to deliver), and collect the jar credits the hook keeps
// for us. Same-chain pools: call sample() when the hook says a tip is due (centre 1%+ from the leader).
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  formatEther,
  formatUnits,
  http,
  pad,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { carryHookAbi, carryQueueAbi, endpointAbi, erc20Abi, hookAbi, receiverAbi, senderAbi, ulnAbi } from "./abi.ts";
import type { ChainCfg, Config, RouteCfg, SameChainCfg } from "./config.ts";
import { jarValue, readDyn, readLeaderSpot, readSource, type PoolDyn, type PoolSource } from "./hook.ts";
import { decodeMessage, messageLength, packetsFromLogs, payloadHash } from "./packet.ts";
import { HEARTBEAT, moveBps, moved, shift, spotX128 } from "./price.ts";
import { routeState, saveState, type Packet, type State } from "./state.ts";

/** DiscipleRoutesV0.MAX_MESSAGE_SIZE */
const MAX_MESSAGE_SIZE = 10_000;
/** lzReceive gas the message asks for (only binding with a paid executor; self-delivery sets its own limit). */
const lzGasOption = (pools: number) => BigInt(150_000 + 230_000 * pools);
/** Gas limit for our own lzReceive. Generous on purpose: the receiver try/catches each pool, so too little gas would
 *  consume the message while a pool's update fails (Undelivered), and estimateGas cannot see that. */
const lzReceiveGas = (pools: number, estimate: bigint) => {
  const floor = BigInt(250_000 + 320_000 * pools);
  const e = (estimate * 3n) / 2n;
  return e > floor ? e : floor;
};

export type Reason = "first" | "move" | "heartbeat" | "heartbeat-unpaid";

export interface Due {
  id: Hex;
  src: PoolSource;
  price: bigint;
  reason: Reason;
  note: string;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

interface Clients {
  pub: PublicClient;
  wal: WalletClient;
  chain: Chain;
}

/** Least gas a matchOrders transaction is sent with (one vault deposit through the queue is ~1.2-1.5M). */
const MATCH_GAS_FLOOR = 3_000_000n;

const now = () => Math.floor(Date.now() / 1000);
const srcKey = (s: PoolSource) => `${s.kind}:${s.target.toLowerCase()}:${s.v4Id.toLowerCase()}`;

/** Decide what one pool needs. Pure, so tests can run it on any state. */
export function judge(
  id: Hex,
  src: PoolSource,
  dyn: PoolDyn,
  price: bigint,
  homeNow: bigint,
  inflight: bigint | undefined,
  cfg: Config["policy"],
): Due | null {
  if (!dyn.exists || price === 0n) return null;
  if (dyn.live && dyn.jar < cfg.minJar) return null;
  if (!dyn.live) {
    if (!cfg.firstPrice || inflight !== undefined) return null;
    return { id, src, price, reason: "first", note: "opening price" };
  }
  const ref = inflight ?? dyn.anchorX128;
  if (moved(ref, price, cfg.moveBps)) {
    return { id, src, price, reason: "move", note: `moved ${moveBps(ref, price).toFixed(2)} bps` };
  }
  if (inflight !== undefined) return null; // the packet on its way refreshes the age
  const age = homeNow - dyn.obsAt;
  if (age >= HEARTBEAT) {
    if (dyn.traded) return { id, src, price, reason: "heartbeat", note: `age ${age}s, traded` };
    if (cfg.unpaidHeartbeats) return { id, src, price, reason: "heartbeat-unpaid", note: `age ${age}s, no trades` };
  }
  return null;
}

/** Whether pool `id` may take another unpaid sample now: fewer than `maxPerHour` in the last hour. Prunes old
 *  entries, otherwise pure, so tests can drive it. */
export function selfPayRoom(log: Map<string, number[]>, id: string, t: number, maxPerHour: number): boolean {
  const recent = (log.get(id) ?? []).filter((x) => x > t - 3600);
  log.set(id, recent);
  return recent.length < maxPerHour;
}

/** Split due pools into messages: at most `maxPools` listings and MAX_MESSAGE_SIZE bytes each. */
/** Carry: whether a pool's tail should be swept now. `y` is the pool's quote reserve and `principal` what its tail
 *  holds in the vault, so `y - principal` is the hot quote; sweep once it is above `bandBps` of the hot target. */
export function sweepNeeded(y: bigint, principal: bigint, hotBps: number, vault: string, bandBps: number): boolean {
  if (/^0x0{40}$/i.test(vault) || hotBps >= 10_000 || y <= principal) return false;
  return (y - principal) * 100_000_000n > y * BigInt(hotBps) * BigInt(bandBps);
}

export function batch(due: Due[], maxPools: number): Due[][] {
  const bySrc = new Map<string, Due[]>();
  for (const d of due) {
    const k = srcKey(d.src);
    if (!bySrc.has(k)) bySrc.set(k, []);
    bySrc.get(k)!.push(d);
  }
  const out: Due[][] = [];
  let cur: Due[] = [];
  const shape = (ds: Due[]) => {
    const m = new Map<string, number>();
    for (const d of ds) m.set(srcKey(d.src), (m.get(srcKey(d.src)) ?? 0) + 1);
    return [...m.values()];
  };
  for (const list of bySrc.values()) {
    for (const d of list) {
      const next = [...cur, d];
      if (cur.length > 0 && (next.length > maxPools || messageLength(shape(next)) > MAX_MESSAGE_SIZE)) {
        out.push(cur);
        cur = [d];
      } else {
        cur = next;
      }
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

export function toReqs(ds: Due[]) {
  const m = new Map<string, { kind: number; target: Hex; v4Id: Hex; pools: Hex[] }>();
  for (const d of ds) {
    const k = srcKey(d.src);
    if (!m.has(k)) m.set(k, { kind: d.src.kind, target: d.src.target, v4Id: d.src.v4Id, pools: [] });
    m.get(k)!.pools.push(d.id);
  }
  return [...m.values()];
}

export class Keeper {
  private clients = new Map<string, Clients>();
  private hooks = new Map<string, Hex>();
  private libs = new Map<string, Hex>();
  private badPools = new Set<string>();
  /** per chain: the last send, so sends from the two loops never race for a nonce */
  private sendLock = new Map<string, Promise<unknown>>();
  /** per chain: the next nonce to send with (see serial), and the lowest one the chain could still accept */
  private nonces = new Map<string, number>();
  private nonceFloor = new Map<string, number>();
  private tokens = new Map<string, { symbol: string; decimals: number }>();
  /** pool id -> [coin, quote] (immutable) */
  private poolTokens = new Map<string, [Hex, Hex]>();
  /** same-chain: consecutive unpaid samples and rest-until, by pool id */
  private misses = new Map<string, number>();
  private restUntil = new Map<string, number>();
  /** same-chain: when we last sampled each pool, and our recent unpaid (selfPayBps) samples, by pool id */
  private lastSample = new Map<string, number>();
  /** Carry: last tail check per pool (unix s) */
  private lastSweepCheck = new Map<string, number>();
  /** Carry: last stock queue check per set (unix s) */
  private lastMatchCheck = new Map<string, number>();
  private selfPaid = new Map<string, number[]>();

  private cfg: Config;
  private state: State;
  private account: Account;
  private log: Logger;

  constructor(cfg: Config, state: State, account: Account, log: Logger) {
    this.cfg = cfg;
    this.state = state;
    this.account = account;
    this.log = log;
    for (const c of Object.values(cfg.chains)) this.clients.set(c.name, this.makeClients(c));
  }

  private makeClients(c: ChainCfg): Clients {
    const chain = defineChain({
      id: c.chainId,
      name: c.name,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [c.rpc] } },
    });
    const transport = http(c.rpc, { retryCount: 3, timeout: 30_000 });
    return {
      chain,
      pub: createPublicClient({ chain, transport }) as PublicClient,
      wal: createWalletClient({ chain, transport, account: this.account }),
    };
  }

  private c(chain: ChainCfg): Clients {
    return this.clients.get(chain.name)!;
  }

  /** Run `fn` (send a tx and wait for it) after any earlier send on the same chain has finished. `fn` gets the
   *  nonce to send with: tracked here, not re-read from the RPC, because a node behind a load balancer can still
   *  report the old pending count just after our last receipt ("nonce too low"). Any failure drops the cached
   *  nonce, so the next send reads it fresh. */
  private serial<T>(chain: ChainCfg, fn: (nonce: number) => Promise<T>): Promise<T> {
    const prev = this.sendLock.get(chain.name) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        let n = this.nonces.get(chain.name);
        if (n === undefined) {
          const pending = await this.c(chain).pub.getTransactionCount({ address: this.account.address, blockTag: "pending" });
          n = Math.max(pending, this.nonceFloor.get(chain.name) ?? 0);
        }
        try {
          const out = await fn(n);
          this.nonces.set(chain.name, n + 1);
          this.nonceFloor.set(chain.name, n + 1);
          return out;
        } catch (e) {
          this.nonces.delete(chain.name);
          if (/nonce too low/i.test((e as Error).message ?? "")) this.nonceFloor.set(chain.name, n + 1);
          throw e;
        }
      });
    this.sendLock.set(chain.name, next.catch(() => undefined));
    return next;
  }

  private async token(pub: PublicClient, t: Hex): Promise<{ symbol: string; decimals: number }> {
    const k = t.toLowerCase();
    const hit = this.tokens.get(k);
    if (hit) return hit;
    const [symbol, decimals] = await Promise.all([
      pub.readContract({ address: t, abi: erc20Abi, functionName: "symbol" }).catch(() => t.slice(0, 8)),
      pub.readContract({ address: t, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
    ]);
    const info = { symbol, decimals: Number(decimals) };
    this.tokens.set(k, info);
    return info;
  }

  /** "1.25 USDG" for `amt` raw units of `t`. */
  private async fmt(pub: PublicClient, t: Hex, amt: bigint): Promise<string> {
    const i = await this.token(pub, t);
    return `${formatUnits(amt, i.decimals)} ${i.symbol}`;
  }

  private async tokensOf(pub: PublicClient, hook: Hex, id: Hex): Promise<[Hex, Hex] | null> {
    const k = id.toLowerCase();
    const hit = this.poolTokens.get(k);
    if (hit) return hit;
    const v = await pub.readContract({ address: hook, abi: hookAbi, functionName: "poolState", args: [id] }).catch(() => null);
    if (!v) return null;
    const pair: [Hex, Hex] = [v.coin, v.quote];
    this.poolTokens.set(k, pair);
    return pair;
  }

  async checkChains(): Promise<void> {
    for (const c of Object.values(this.cfg.chains)) {
      const id = await this.c(c).pub.getChainId();
      if (id !== c.chainId) throw new Error(`${c.name}: RPC is chain ${id}, config says ${c.chainId}`);
      const bal = await this.c(c).pub.getBalance({ address: this.account.address });
      this.log.info(`${c.name}: keeper ${this.account.address} balance ${formatEther(bal)} ETH`);
    }
  }

  async hookOf(r: RouteCfg): Promise<Hex> {
    if (r.hook) return r.hook;
    const h = this.hooks.get(r.name);
    if (h) return h;
    const hook = await this.c(r.dest).pub.readContract({ address: r.receiver, abi: receiverAbi, functionName: "hook" });
    if (/^0x0+$/.test(hook)) throw new Error(`${r.name}: receiver ${r.receiver} is not bound to a hook yet`);
    this.hooks.set(r.name, hook);
    return hook;
  }

  /** One cross-chain round: every route, then the collect sweep. */
  async tick(): Promise<void> {
    for (const r of this.cfg.routes) {
      try {
        await this.discover(r);
        await this.scanPushes(r);
        await this.pushDue(r);
        await this.deliver(r);
        await this.collectDue(r);
      } catch (e) {
        this.log.warn(`${r.name}: ${(e as Error).message?.split("\n")[0] ?? e}`);
      } finally {
        saveState(this.cfg.stateFile, this.state);
      }
    }
  }

  /** One same-chain round: every same-chain set. */
  async sampleTick(): Promise<void> {
    for (const s of this.cfg.sameChain) {
      try {
        await this.discoverSame(s);
        await this.sampleDue(s);
        if (s.abi === "carry") await this.sweepDue(s);
        if (s.abi === "carry" && s.stockQueue) await this.matchDue(s);
      } catch (e) {
        this.log.warn(`${s.name}: ${(e as Error).message?.split("\n")[0] ?? e}`);
      } finally {
        saveState(this.cfg.stateFile, this.state);
      }
    }
  }

  // ------------------------------------------------------------------ discovery

  /** Created events on the destination hook (chunked getLogs), plus pools listed in the config. */
  async discover(r: RouteCfg): Promise<void> {
    const rs = routeState(this.state, r.name);
    const { pub } = this.c(r.dest);
    const hook = await this.hookOf(r);
    const found: Hex[] = [...r.pools];
    if (r.scanPools) {
      const latest = await pub.getBlockNumber();
      let from = rs.poolCursor ?? (r.hookFromBlock > 0n ? r.hookFromBlock : latest);
      if (rs.poolCursor === undefined && r.hookFromBlock === 0n) {
        this.log.warn(`${r.name}: no hookFromBlock set, scanning pools from block ${latest} on`);
      }
      for (let i = 0; i < r.dest.logCallsPerTick && from <= latest; i++) {
        const to = from + r.dest.logChunk - 1n < latest ? from + r.dest.logChunk - 1n : latest;
        const logs = await pub.getContractEvents({ address: hook, abi: hookAbi, eventName: "Created", fromBlock: from, toBlock: to });
        for (const l of logs) if (Number(l.args.remoteEid) === r.home.eid) found.push(l.args.id!.toLowerCase() as Hex);
        from = to + 1n;
        rs.poolCursor = from;
      }
    }
    for (const id of found) {
      if (rs.pools[id] || this.badPools.has(id)) continue;
      const s = await readSource(pub, hook, id);
      if (!s.exists || !s.push || s.remoteEid !== r.home.eid) {
        this.badPools.add(id);
        if (r.pools.includes(id)) this.log.warn(`${r.name}: pool ${id} is not a push pool from ${r.home.name}, skipped`);
        continue;
      }
      const { exists: _e, ...src } = s;
      rs.pools[id] = src;
      this.log.info(`${r.name}: serving pool ${id} (source kind ${src.kind} ${src.target})`);
    }
  }

  // ------------------------------------------------------------------ takeover scan

  /** Pushed events from the sender on the home chain, so other keepers' stuck packets can be delivered too. */
  async scanPushes(r: RouteCfg): Promise<void> {
    if (!r.scanPushes) return;
    const rs = routeState(this.state, r.name);
    const { pub } = this.c(r.home);
    const latest = await pub.getBlockNumber();
    let from = rs.pushCursor ?? (r.senderFromBlock > 0n ? r.senderFromBlock : latest);
    const known = new Set(this.state.packets.map((p) => p.guid.toLowerCase()));
    for (let i = 0; i < r.home.logCallsPerTick && from <= latest; i++) {
      const to = from + r.home.logChunk - 1n < latest ? from + r.home.logChunk - 1n : latest;
      const logs = await pub.getContractEvents({
        address: r.sender,
        abi: senderAbi,
        eventName: "Pushed",
        args: { dstEid: r.dest.eid },
        fromBlock: from,
        toBlock: to,
      });
      for (const l of logs) {
        if (known.has(l.args.guid!.toLowerCase())) continue;
        const rc = await pub.getTransactionReceipt({ hash: l.transactionHash! });
        const blk = await pub.getBlock({ blockNumber: rc.blockNumber });
        for (const pk of packetsFromLogs(rc.logs, r.home.endpoint)) {
          if (pk.guid.toLowerCase() !== l.args.guid!.toLowerCase()) continue;
          if (pk.receiver.toLowerCase() !== r.receiver.toLowerCase()) continue;
          if (await this.isDelivered(r, pk.nonce)) continue;
          this.state.packets.push({
            route: r.name,
            nonce: pk.nonce,
            guid: pk.guid,
            header: pk.header,
            message: pk.message,
            receiver: r.receiver,
            sender: pk.sender,
            srcEid: pk.srcEid,
            sentAt: Number(blk.timestamp),
            homeTx: l.transactionHash!,
            ours: l.args.keeper!.toLowerCase() === this.account.address.toLowerCase(),
            pools: [],
            tries: 0,
          });
          known.add(pk.guid.toLowerCase());
          this.log.info(`${r.name}: saw packet nonce ${pk.nonce} from ${l.args.keeper}`);
        }
      }
      from = to + 1n;
      rs.pushCursor = from;
    }
  }

  // ------------------------------------------------------------------ planning and pushing

  /** What every served pool needs right now. */
  async plan(r: RouteCfg): Promise<{ due: Due[]; homeNow: bigint; report: string[] }> {
    const rs = routeState(this.state, r.name);
    const ids = Object.keys(rs.pools) as Hex[];
    const report: string[] = [];
    if (ids.length === 0) return { due: [], homeNow: 0n, report };
    const hook = await this.hookOf(r);
    const home = this.c(r.home).pub;
    const dest = this.c(r.dest).pub;
    const blk = await home.getBlock({ blockTag: "latest" });
    const reads = new Map<string, Promise<readonly [bigint, bigint] | null>>();
    for (const id of ids) {
      const s = rs.pools[id];
      const k = srcKey(s);
      if (!reads.has(k)) {
        reads.set(
          k,
          home
            .readContract({
              address: r.sender,
              abi: senderAbi,
              functionName: "read",
              args: [s.kind, s.target, s.v4Id],
              blockNumber: blk.number!,
            })
            .catch(() => null),
        );
      }
    }
    const inflight = new Map<string, bigint>();
    for (const p of this.state.packets) {
      if (p.route !== r.name || !p.ours) continue;
      for (const x of p.pools) inflight.set(x.id.toLowerCase(), BigInt(x.price));
    }
    const due: Due[] = [];
    for (const id of ids) {
      const s = rs.pools[id];
      const ab = await reads.get(srcKey(s))!;
      if (!ab) {
        report.push(`${id}: source read failed`);
        continue;
      }
      const dyn = await readDyn(dest, hook, id);
      if (dyn.exists) this.poolTokens.set(id.toLowerCase(), [dyn.coin, dyn.quote]);
      const price = shift(s.decShift, spotX128(s.kind, ab[0], ab[1], s.coinIs0));
      const d = judge(id, s, dyn, price, blk.timestamp, inflight.get(id.toLowerCase()), this.cfg.policy);
      const age = dyn.live ? `${blk.timestamp - dyn.obsAt}s` : "-";
      report.push(
        `${id}: live=${dyn.live} local=${dyn.local} age=${age} move=${moveBps(dyn.anchorX128, price).toFixed(2)}bps ` +
          `traded=${dyn.traded} jar=${dyn.exists ? await this.fmt(dest, dyn.quote, dyn.jar) : "-"} -> ${d ? d.reason : "nothing"}`,
      );
      if (d) due.push(d);
    }
    return { due, homeNow: blk.timestamp, report };
  }

  async pushDue(r: RouteCfg): Promise<void> {
    const { due } = await this.plan(r);
    if (due.length === 0) return;
    for (const b of batch(due, this.cfg.policy.maxPoolsPerPush)) await this.push(r, b);
  }

  async push(r: RouteCfg, ds: Due[]): Promise<Packet | null> {
    const { pub, wal, chain } = this.c(r.home);
    const reqs = toReqs(ds);
    const to = pad(r.receiver, { size: 32 });
    const gas = lzGasOption(ds.length);
    const fee = await pub.readContract({ address: r.sender, abi: senderAbi, functionName: "quote", args: [r.dest.eid, to, reqs, gas] });
    const value = fee + fee / 100n; // the endpoint refunds any excess to the keeper
    const blk = await pub.getBlock({ blockTag: "latest" });
    const base = blk.baseFeePerGas ?? 0n;
    if (base > r.home.maxFee) {
      this.log.warn(`${r.name}: ${r.home.name} basefee ${base} above maxFee, waiting`);
      return null;
    }
    const tip = r.home.priorityFee;
    const maxFee = base * 2n + tip < r.home.maxFee ? base * 2n + tip : r.home.maxFee;
    const est = await pub.estimateContractGas({
      address: r.sender,
      abi: senderAbi,
      functionName: "push",
      args: [r.dest.eid, to, reqs, gas],
      value,
      account: this.account,
    });
    const expected = fee + est * (base + tip);
    if (expected > this.cfg.policy.maxPushCost) {
      this.log.warn(`${r.name}: push of ${ds.length} pools would cost ${formatEther(expected)} ETH, above maxPushCost`);
      return null;
    }
    const { hash, rc } = await this.serial(r.home, async (nonce) => {
      const hash = await wal.writeContract({
        chain,
        account: this.account,
        nonce,
        address: r.sender,
        abi: senderAbi,
        functionName: "push",
        args: [r.dest.eid, to, reqs, gas],
        value,
        gas: (est * 6n) / 5n,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: tip,
      });
      return { hash, rc: await pub.waitForTransactionReceipt({ hash }) };
    });
    if (rc.status !== "success") throw new Error(`push ${hash} reverted`);
    const pk = packetsFromLogs(rc.logs, r.home.endpoint).find((p) => p.receiver.toLowerCase() === r.receiver.toLowerCase());
    if (!pk) throw new Error(`push ${hash}: no PacketSent in receipt`);
    const tb = await pub.getBlock({ blockNumber: rc.blockNumber });
    const packet: Packet = {
      route: r.name,
      nonce: pk.nonce,
      guid: pk.guid,
      header: pk.header,
      message: pk.message,
      receiver: r.receiver,
      sender: pk.sender,
      srcEid: pk.srcEid,
      sentAt: Number(tb.timestamp),
      homeTx: hash,
      ours: true,
      pools: ds.map((d) => ({ id: d.id, price: d.price.toString() })),
      tries: 0,
      spent: (rc.gasUsed * rc.effectiveGasPrice + fee).toString(),
    };
    this.state.packets.push(packet);
    saveState(this.cfg.stateFile, this.state);
    const paid = rc.gasUsed * rc.effectiveGasPrice + fee;
    this.log.info(
      `${r.name}: pushed nonce ${pk.nonce} (${ds.map((d) => `${d.id.slice(0, 10)} ${d.reason}`).join(", ")}) ` +
        `tx ${hash}, paid ${formatEther(paid)} ETH`,
    );
    return packet;
  }

  // ------------------------------------------------------------------ delivery

  private async receiveLib(r: RouteCfg): Promise<Hex> {
    const l = this.libs.get(r.name);
    if (l) return l;
    const [lib] = await this.c(r.dest).pub.readContract({
      address: r.dest.endpoint,
      abi: endpointAbi,
      functionName: "getReceiveLibrary",
      args: [r.receiver, r.home.eid],
    });
    this.libs.set(r.name, lib);
    return lib;
  }

  private async pathState(r: RouteCfg, p: { sender: Hex; nonce: bigint }) {
    const pub = this.c(r.dest).pub;
    const [lazy, hash] = await Promise.all([
      pub.readContract({ address: r.dest.endpoint, abi: endpointAbi, functionName: "lazyInboundNonce", args: [r.receiver, r.home.eid, p.sender] }),
      pub.readContract({ address: r.dest.endpoint, abi: endpointAbi, functionName: "inboundPayloadHash", args: [r.receiver, r.home.eid, p.sender, p.nonce] }),
    ]);
    return { lazy, hash, delivered: p.nonce <= lazy && /^0x0+$/.test(hash), committed: !/^0x0+$/.test(hash) };
  }

  private async isDelivered(r: RouteCfg, nonce: bigint): Promise<boolean> {
    const sender = pad(r.sender, { size: 32 });
    return (await this.pathState(r, { sender, nonce })).delivered;
  }

  async deliver(r: RouteCfg): Promise<void> {
    const mine = this.state.packets.filter((p) => p.route === r.name).sort((a, b) => (a.nonce < b.nonce ? -1 : 1));
    if (mine.length === 0) return;
    const { pub, wal, chain } = this.c(r.dest);
    const lib = await this.receiveLib(r);
    const maxOurs = mine.filter((p) => p.ours).reduce((m, p) => (p.nonce > m ? p.nonce : m), 0n);
    // packet ages use chain time (home and destination clocks agree to within seconds), not this machine's clock
    const t = Number((await pub.getBlock({ blockTag: "latest" })).timestamp);
    const drop = new Set<Packet>();

    // 1. commit everything the DVNs have verified (order does not matter here)
    for (const p of mine) {
      const st = await this.pathState(r, p);
      if (st.delivered) {
        drop.add(p);
        if (p.ours) this.log.info(`${r.name}: nonce ${p.nonce} was delivered by someone else`);
        continue;
      }
      const eligible = p.ours || p.nonce < maxOurs || t - p.sentAt >= this.cfg.policy.takeoverAfterSec;
      if (!eligible) continue;
      if (t - p.sentAt > this.cfg.policy.packetTtlSec) {
        drop.add(p);
        this.log.warn(`${r.name}: giving up on nonce ${p.nonce} after ${t - p.sentAt}s`);
        continue;
      }
      if (st.committed) {
        p.committed = true;
        continue;
      }
      const ph = payloadHash(p.guid, p.message);
      try {
        await pub.simulateContract({ address: lib, abi: ulnAbi, functionName: "commitVerification", args: [p.header, ph], account: this.account });
      } catch {
        continue; // DVNs not done yet (or confirmations not reached)
      }
      const { hash, rc } = await this.serial(r.dest, async (nonce) => {
        const hash = await wal.writeContract({
          chain,
          account: this.account,
          nonce,
          address: lib,
          abi: ulnAbi,
          functionName: "commitVerification",
          args: [p.header, ph],
          ...this.fees(r.dest),
        });
        return { hash, rc: await pub.waitForTransactionReceipt({ hash }) };
      });
      if (rc.status !== "success") throw new Error(`commit ${hash} reverted`);
      p.committed = true;
      p.spent = (BigInt(p.spent ?? "0") + rc.gasUsed * rc.effectiveGasPrice).toString();
      this.log.info(`${r.name}: committed nonce ${p.nonce} (${t - p.sentAt}s after push) tx ${hash}`);
    }

    // 2. execute in nonce order (the endpoint needs every earlier nonce at least committed)
    for (const p of mine) {
      if (drop.has(p) || !p.committed) continue;
      const msg = decodeMessage(p.message);
      const n = msg.obs.reduce((s, o) => s + o.pools.length, 0);
      const args = [{ srcEid: p.srcEid, sender: p.sender, nonce: p.nonce }, r.receiver, p.guid, p.message, "0x"] as const;
      let est: bigint;
      try {
        est = await pub.estimateContractGas({ address: r.dest.endpoint, abi: endpointAbi, functionName: "lzReceive", args, account: this.account });
      } catch (e) {
        p.tries++;
        const m = (e as Error).message ?? "";
        const blocked = /LZ_InvalidNonce\D*(\d+)/.exec(m);
        this.log.warn(`${r.name}: nonce ${p.nonce} cannot execute yet${blocked ? `: waiting for nonce ${blocked[1]}` : `: ${m.split("\n")[0]}`}`);
        break;
      }
      const { hash, rc } = await this.serial(r.dest, async (nonce) => {
        const hash = await wal.writeContract({
          chain,
          account: this.account,
          nonce,
          address: r.dest.endpoint,
          abi: endpointAbi,
          functionName: "lzReceive",
          args,
          gas: lzReceiveGas(n, est),
          ...this.fees(r.dest),
        });
        return { hash, rc: await pub.waitForTransactionReceipt({ hash }) };
      });
      if (rc.status !== "success") throw new Error(`lzReceive ${hash} reverted`);
      drop.add(p);
      const spent = BigInt(p.spent ?? "0") + rc.gasUsed * rc.effectiveGasPrice;
      const hook = await this.hookOf(r);
      const notes: string[] = [];
      for (const l of rc.logs) {
        try {
          const ev = decodeEventLog({ abi: [...hookAbi, ...receiverAbi], data: l.data, topics: l.topics });
          if (ev.eventName === "PriceAccepted") {
            // the refund is credited to the pushing keeper in the pool's quote token (collect() takes it)
            const tk = await this.tokensOf(pub, hook, ev.args.id);
            const credit = tk ? await this.fmt(pub, tk[1], ev.args.refund) : `${ev.args.refund} quote raw`;
            notes.push(`${ev.args.id.slice(0, 10)} accepted, credit ${credit}`);
          } else if (ev.eventName === "PriceRejected") notes.push(`${ev.args.id.slice(0, 10)} rejected`);
          else if (ev.eventName === "Undelivered") notes.push(`${ev.args.id.slice(0, 10)} UNDELIVERED`);
        } catch {
          /* other logs */
        }
      }
      this.log.info(
        `${r.name}: delivered nonce ${p.nonce} (${t - p.sentAt}s after push) tx ${hash}; ${notes.join("; ") || "no pool events"}` +
          (p.ours ? `; spent ${formatEther(spent)} ETH (credits are in each pool's quote token)` : `; takeover for ${msg.keeper}`),
      );
    }
    this.state.packets = this.state.packets.filter((p) => !drop.has(p));
  }

  // ------------------------------------------------------------------ collecting jar credits

  /** Take what the hook owes this keeper (cross-chain tips are credited, not sent), once per collectEverySec. */
  async collectDue(r: RouteCfg, force = false): Promise<void> {
    const hook = await this.hookOf(r);
    const key = `${r.dest.name}:${hook.toLowerCase()}`;
    const at = (this.state.collectedAt ??= {});
    const t = now();
    if (!force && t - (at[key] ?? 0) < this.cfg.policy.collectEverySec) return;
    const { pub, wal, chain } = this.c(r.dest);
    const ids = Object.keys(routeState(this.state, r.name).pools) as Hex[];
    const toks = new Set<Hex>();
    for (const id of ids) {
      const tk = await this.tokensOf(pub, hook, id);
      if (tk) for (const x of tk) toks.add(x.toLowerCase() as Hex);
    }
    for (const tk of toks) {
      const amt = await pub.readContract({ address: hook, abi: hookAbi, functionName: "owed", args: [this.account.address, tk] });
      if (amt === 0n) continue;
      const { hash, rc } = await this.serial(r.dest, async (nonce) => {
        const hash = await wal.writeContract({
          chain,
          account: this.account,
          nonce,
          address: hook,
          abi: hookAbi,
          functionName: "collect",
          args: [tk],
          ...this.fees(r.dest),
        });
        return { hash, rc: await pub.waitForTransactionReceipt({ hash }) };
      });
      if (rc.status !== "success") {
        this.log.warn(`${r.name}: collect ${tk} reverted (tx ${hash}); will retry next sweep`);
        continue;
      }
      this.log.info(
        `${r.name}: collected ${await this.fmt(pub, tk, amt)} tx ${hash}, gas ${formatEther(rc.gasUsed * rc.effectiveGasPrice)} ETH`,
      );
    }
    at[key] = t;
  }

  // ------------------------------------------------------------------ same-chain sampling

  /** Created events with remoteEid 0 on a same-chain hook, plus pools listed in the config. */
  async discoverSame(s: SameChainCfg): Promise<void> {
    const rs = routeState(this.state, s.name);
    const { pub } = this.c(s.chain);
    const found: Hex[] = [...s.pools];
    if (s.scanPools) {
      const latest = await pub.getBlockNumber();
      let from = rs.poolCursor ?? (s.fromBlock > 0n ? s.fromBlock : latest);
      if (rs.poolCursor === undefined && s.fromBlock === 0n) {
        this.log.warn(`${s.name}: no fromBlock set, scanning pools from block ${latest} on`);
      }
      for (let i = 0; i < s.chain.logCallsPerTick && from <= latest; i++) {
        const to = from + s.chain.logChunk - 1n < latest ? from + s.chain.logChunk - 1n : latest;
        const logs = await pub.getContractEvents({ address: s.hook, abi: this.hAbi(s), eventName: "Created", fromBlock: from, toBlock: to });
        for (const l of logs) if (Number(l.args.remoteEid) === 0) found.push(l.args.id!.toLowerCase() as Hex);
        from = to + 1n;
        rs.poolCursor = from;
      }
    }
    for (const id of found) {
      if (rs.pools[id] || this.badPools.has(id)) continue;
      const src = await readSource(pub, s.hook, id);
      if (!src.exists || src.remoteEid !== 0) {
        this.badPools.add(id);
        if (s.pools.includes(id)) this.log.warn(`${s.name}: pool ${id} is not a same-chain pool on this hook, skipped`);
        continue;
      }
      const { exists: _e, ...rest } = src;
      rs.pools[id] = rest;
      this.log.info(`${s.name}: sampling pool ${id}`);
    }
  }

  /** Ask the hook which pools would pay a tip now, and call sample() on those. With `selfPayBps`, also sample
   *  (unpaid) the pools whose centre is that far from the leader but below the hook's 1% tip line. No pool is
   *  sampled twice within `minGapSec` (one reading per L1 block on Robinhood). */
  async sampleDue(s: SameChainCfg): Promise<void> {
    const rs = routeState(this.state, s.name);
    const ids = Object.keys(rs.pools) as Hex[];
    if (ids.length === 0) return;
    const { pub } = this.c(s.chain);
    const t = now();
    const sm = this.cfg.sampling;
    const open = ids.filter((id) => (this.restUntil.get(id) ?? 0) <= t && (this.lastSample.get(id) ?? 0) + sm.minGapSec <= t);
    const due = await Promise.all(
      open.map((id) =>
        pub.readContract({ address: s.hook, abi: this.hAbi(s), functionName: "sampleDue", args: [id] }).catch(() => false),
      ),
    );
    for (let i = 0; i < open.length; i++) {
      const id = open[i];
      if (due[i]) {
        await this.sample(s, id);
        continue;
      }
      if (sm.selfPayBps <= 0 || !selfPayRoom(this.selfPaid, id, t, sm.selfPayMaxPerHour)) continue;
      const gap = await this.leaderGapBps(s, id, rs.pools[id] as PoolSource);
      if (gap >= sm.selfPayBps) {
        if (!this.selfPaid.has(id)) this.selfPaid.set(id, []);
        this.selfPaid.get(id)!.push(t);
        await this.sample(s, id, false);
      }
    }
  }

  /** Carry: put each pool's extra hot USDG back into its Morpho tail. Swaps only ever pull USDG out of Morpho (a sell
   *  that needs more than the hot part holds); this sweeps a pool, at our own gas, once its hot quote is above
   *  `sweepBandBps` of its target, which trims hot back down to the target. Each pool is checked every
   *  `sweepEverySec` (two eth_calls). */
  async sweepDue(s: SameChainCfg): Promise<void> {
    const sm = this.cfg.sampling;
    if (sm.sweepEverySec <= 0) return;
    const rs = routeState(this.state, s.name);
    const { pub } = this.c(s.chain);
    const t = now();
    for (const id of Object.keys(rs.pools) as Hex[]) {
      if ((this.lastSweepCheck.get(id) ?? 0) + sm.sweepEverySec > t) continue;
      this.lastSweepCheck.set(id, t);
      const [v, ts] = await Promise.all([
        pub.readContract({ address: s.hook, abi: carryHookAbi, functionName: "poolState", args: [id] }).catch(() => null),
        pub.readContract({ address: s.hook, abi: carryHookAbi, functionName: "tailState", args: [id] }).catch(() => null),
      ]);
      if (!v || !ts || !v.live) continue;
      const tail = ts[0];
      if (!sweepNeeded(v.quoteReserve, tail.principal, tail.hotBps, tail.vault, sm.sweepBandBps)) continue;
      await this.sweep(s, id, v.quoteReserve, tail.principal);
    }
  }

  async sweep(s: SameChainCfg, id: Hex, y: bigint, principal: bigint): Promise<void> {
    const { pub, wal, chain } = this.c(s.chain);
    const blk = await pub.getBlock({ blockTag: "latest" });
    const base = blk.baseFeePerGas ?? 0n;
    if (base > s.chain.maxFee) {
      this.log.warn(`${s.name}: ${s.chain.name} basefee ${base} above maxFee, sweep waits`);
      this.lastSweepCheck.delete(id);
      return;
    }
    let est: bigint;
    try {
      est = await pub.estimateContractGas({ address: s.hook, abi: carryHookAbi, functionName: "sweep", args: [id], account: this.account });
    } catch (e) {
      this.log.warn(`${s.name}: sweep ${id.slice(0, 10)} would revert: ${(e as Error).message?.split("\n")[0]}`);
      return;
    }
    const tip = s.chain.priorityFee;
    const maxFee = base * 2n + tip < s.chain.maxFee ? base * 2n + tip : s.chain.maxFee;
    const { hash, rc } = await this.serial(s.chain, async (nonce) => {
      const hash = await wal.writeContract({
        chain,
        account: this.account,
        nonce,
        address: s.hook,
        abi: carryHookAbi,
        functionName: "sweep",
        args: [id],
        gas: (est * 13n) / 10n,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: tip,
      });
      return { hash, rc: await pub.waitForTransactionReceipt({ hash }) };
    });
    const spent = rc.gasUsed * rc.effectiveGasPrice;
    if (rc.status !== "success") {
      this.log.warn(`${s.name}: sweep ${id.slice(0, 10)} reverted, tx ${hash}, spent ${formatEther(spent)} ETH`);
      return;
    }
    let moved = "";
    for (const l of rc.logs) {
      try {
        const ev = decodeEventLog({ abi: carryHookAbi, data: l.data, topics: l.topics });
        if (ev.eventName === "TailMoved") moved = `to Morpho ${ev.args.toVault}, to hot ${ev.args.toHot} (raw)`;
      } catch {
        /* other logs */
      }
    }
    this.log.info(
      `${s.name}: swept ${id.slice(0, 10)} (hot ${y - principal} of ${y}) tx ${hash}, ${moved || "nothing moved"}, spent ${formatEther(spent)} ETH (gas ${rc.gasUsed})`,
    );
  }

  /** Carry: match stock waiting in the stock queue with lender USDG. Every `matchEverySec`, for each market with stock
   *  waiting, a dry run of matchOrders says whether lender USDG is free for the front of its line; only then is a
   *  transaction sent, at our own gas. A dry run that matches nothing (no free USDG, market at its cap, vault paused,
   *  pool rebalancing) costs nothing and is tried again next round. */
  async matchDue(s: SameChainCfg): Promise<void> {
    const sm = this.cfg.sampling, q = s.stockQueue;
    if (!q || sm.matchEverySec <= 0) return;
    const t = now();
    if ((this.lastMatchCheck.get(s.name) ?? 0) + sm.matchEverySec > t) return;
    this.lastMatchCheck.set(s.name, t);
    const { pub } = this.c(s.chain);
    const vault = await pub.readContract({ address: q, abi: carryQueueAbi, functionName: "vault" });
    const n = await pub.readContract({ address: vault, abi: carryQueueAbi, functionName: "marketCount" });
    for (let m = 0n; m < n; m++) {
      const waiting = await pub.readContract({ address: q, abi: carryQueueAbi, functionName: "waiting", args: [m] });
      if (waiting === 0n) continue;
      let would = 0n;
      try {
        const r = await pub.simulateContract({ address: q, abi: carryQueueAbi, functionName: "matchOrders", args: [m, BigInt(sm.matchSteps)], account: this.account });
        would = r.result;
      } catch (e) {
        this.log.warn(`${s.name}: matchOrders(${m}) dry run failed: ${(e as Error).message?.split("\n")[0]}`);
        continue;
      }
      if (would === 0n) continue;
      await this.matchOrders(s, q, m, BigInt(sm.matchSteps), would);
    }
  }

  async matchOrders(s: SameChainCfg, q: Hex, market: bigint, steps: bigint, would: bigint): Promise<void> {
    const { pub, wal, chain } = this.c(s.chain);
    const blk = await pub.getBlock({ blockTag: "latest" });
    const base = blk.baseFeePerGas ?? 0n;
    if (base > s.chain.maxFee) {
      this.log.warn(`${s.name}: ${s.chain.name} basefee ${base} above maxFee, matching waits`);
      this.lastMatchCheck.delete(s.name);
      return;
    }
    let est: bigint;
    try {
      est = await pub.estimateContractGas({ address: q, abi: carryQueueAbi, functionName: "matchOrders", args: [market, steps], account: this.account });
    } catch (e) {
      this.log.warn(`${s.name}: matchOrders(${market}) would revert: ${(e as Error).message?.split("\n")[0]}`);
      return;
    }
    const tip = s.chain.priorityFee;
    const maxFee = base * 2n + tip < s.chain.maxFee ? base * 2n + tip : s.chain.maxFee;
    const { hash, rc } = await this.serial(s.chain, async (nonce) => {
      const hash = await wal.writeContract({
        chain,
        account: this.account,
        nonce,
        address: q,
        abi: carryQueueAbi,
        functionName: "matchOrders",
        args: [market, steps],
        // never below MATCH_GAS_FLOOR: a vault deposit is ~1.2-1.5M gas, and a limit that starves it must not
        // be mistaken for an empty match (round-3 audit; the queue also reverts LowGas when a deposit runs dry)
        gas: (est * 13n) / 10n > MATCH_GAS_FLOOR ? (est * 13n) / 10n : MATCH_GAS_FLOOR,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: tip,
      });
      return { hash, rc: await pub.waitForTransactionReceipt({ hash }) };
    });
    const spent = rc.gasUsed * rc.effectiveGasPrice;
    if (rc.status !== "success") {
      this.log.warn(`${s.name}: matchOrders(${market}) reverted, tx ${hash}, spent ${formatEther(spent)} ETH`);
      return;
    }
    let opened = 0;
    for (const l of rc.logs) {
      try {
        const ev = decodeEventLog({ abi: carryQueueAbi, data: l.data, topics: l.topics });
        if (ev.eventName === "Matched") opened++;
      } catch {
        /* other logs */
      }
    }
    this.log.info(`${s.name}: matched market ${market} (dry run ${would} raw stock), ${opened} position(s), tx ${hash}, spent ${formatEther(spent)} ETH (gas ${rc.gasUsed})`);
    // a dry run that said yes but opened nothing: wait the full interval instead of looping (round-3 audit)
    if (opened === 0) {
      this.log.warn(`${s.name}: matchOrders(${market}) opened nothing after a positive dry run; waiting ${this.cfg.sampling.matchEverySec}s`);
      return;
    }
    // more may be matchable (a long line): check again next round
    this.lastMatchCheck.delete(s.name);
  }

  /** How far (bps) a pool's centre is from its leader's live spot; 0 when either cannot be read. */
  private async leaderGapBps(s: SameChainCfg, id: Hex, src: PoolSource): Promise<number> {
    const { pub } = this.c(s.chain);
    const [v, spot] = await Promise.all([
      (pub.readContract({ address: s.hook, abi: this.hAbi(s), functionName: "poolState", args: [id] }) as Promise<{ live: boolean; anchorX128: bigint }>).catch(() => null),
      readLeaderSpot(pub, src),
    ]);
    if (!v || !v.live || v.anchorX128 === 0n || spot === 0n) return 0;
    return moveBps(v.anchorX128, spot);
  }

  private hAbi(s: SameChainCfg) {
    return s.abi === "carry" ? carryHookAbi : hookAbi;
  }

  /** `paid`: the hook said a tip is due (sampleDue). false: a selfPayBps sample at our own gas, expected unpaid. */
  async sample(s: SameChainCfg, id: Hex, paid = true): Promise<void> {
    this.lastSample.set(id, now());
    const { pub, wal, chain } = this.c(s.chain);
    const blk = await pub.getBlock({ blockTag: "latest" });
    const base = blk.baseFeePerGas ?? 0n;
    if (base > s.chain.maxFee) {
      this.log.warn(`${s.name}: ${s.chain.name} basefee ${base} above maxFee, waiting`);
      return;
    }
    let est: bigint;
    try {
      est = await pub.estimateContractGas({ address: s.hook, abi: this.hAbi(s), functionName: "sample", args: [id], account: this.account });
    } catch (e) {
      this.log.warn(`${s.name}: sample ${id.slice(0, 10)} would revert: ${(e as Error).message?.split("\n")[0]}`);
      this.rest(id, now());
      return;
    }
    const tip = s.chain.priorityFee;
    const maxFee = base * 2n + tip < s.chain.maxFee ? base * 2n + tip : s.chain.maxFee;
    const { hash, rc } = await this.serial(s.chain, async (nonce) => {
      const hash = await wal.writeContract({
        chain,
        account: this.account,
        nonce,
        address: s.hook,
        abi: this.hAbi(s),
        functionName: "sample",
        args: [id],
        gas: (est * 13n) / 10n,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: tip,
      });
      return { hash, rc: await pub.waitForTransactionReceipt({ hash }) };
    });
    const spent = rc.gasUsed * rc.effectiveGasPrice;
    if (rc.status !== "success") {
      this.log.warn(`${s.name}: sample ${id.slice(0, 10)} reverted, tx ${hash}, spent ${formatEther(spent)} ETH`);
      this.miss(s, id);
      return;
    }
    let tipped: { x: bigint; y: bigint } | null = null;
    for (const l of rc.logs) {
      try {
        const ev = decodeEventLog({ abi: this.hAbi(s), data: l.data, topics: l.topics });
        if (ev.eventName === "Tipped" && ev.args.id.toLowerCase() === id.toLowerCase()) tipped = { x: ev.args.x, y: ev.args.y };
      } catch {
        /* other logs */
      }
    }
    if (!tipped && !paid) {
      this.log.info(`${s.name}: self-paid sample ${id.slice(0, 10)} tx ${hash} (below the tip line), spent ${formatEther(spent)} ETH (gas ${rc.gasUsed})`);
      return;
    }
    if (!tipped) {
      // someone traded or sampled first in that block, or the hook cannot value this pool's tokens in ETH
      this.log.info(`${s.name}: sampled ${id.slice(0, 10)} tx ${hash}, no tip, spent ${formatEther(spent)} ETH`);
      this.miss(s, id);
      return;
    }
    this.misses.delete(id);
    const tk = await this.tokensOf(pub, s.hook, id);
    const v = await pub.readContract({ address: s.hook, abi: this.hAbi(s), functionName: "poolState", args: [id] }).catch(() => null);
    const worth = tk && v ? await this.fmt(pub, tk[1], jarValue(tipped.x, tipped.y, v.anchorX128)) : "?";
    const parts = tk
      ? [tipped.x > 0n ? await this.fmt(pub, tk[0], tipped.x) : "", tipped.y > 0n ? await this.fmt(pub, tk[1], tipped.y) : ""].filter(Boolean)
      : [`${tipped.x}/${tipped.y} raw`];
    this.log.info(
      `${s.name}: sampled ${id.slice(0, 10)} tx ${hash}, tip ${parts.join(" + ")} (worth ${worth}), spent ${formatEther(spent)} ETH (gas ${rc.gasUsed})`,
    );
  }

  private miss(s: SameChainCfg, id: Hex): void {
    const m = (this.misses.get(id) ?? 0) + 1;
    this.misses.set(id, m);
    if (m >= this.cfg.sampling.missesBeforeRest) {
      this.misses.delete(id);
      this.rest(id, now());
      this.log.warn(`${s.name}: ${m} unpaid samples in a row on ${id.slice(0, 10)}, resting it ${this.cfg.sampling.restSec}s`);
    }
  }

  private rest(id: Hex, t: number): void {
    this.restUntil.set(id, t + this.cfg.sampling.restSec);
  }

  private fees(c: ChainCfg) {
    return { maxPriorityFeePerGas: c.priorityFee, maxFeePerGas: c.maxFee };
  }

  // ------------------------------------------------------------------ status

  async status(): Promise<string[]> {
    const out: string[] = [];
    for (const r of this.cfg.routes) {
      await this.discover(r);
      const { report } = await this.plan(r);
      out.push(`== ${r.name} (${r.home.name} -> ${r.dest.name}), ${report.length} pools`);
      out.push(...report.map((x) => `  ${x}`));
      for (const p of this.state.packets.filter((p) => p.route === r.name)) {
        out.push(`  packet nonce ${p.nonce} ${p.ours ? "ours" : "foreign"} sent ${now() - p.sentAt}s ago committed=${!!p.committed}`);
      }
      const hook = await this.hookOf(r);
      const dest = this.c(r.dest).pub;
      for (const tk of new Set([...this.poolTokens.values()].flat())) {
        const amt = await dest.readContract({ address: hook, abi: hookAbi, functionName: "owed", args: [this.account.address, tk] }).catch(() => 0n);
        if (amt > 0n) out.push(`  owed to us: ${await this.fmt(dest, tk, amt)}`);
      }
    }
    for (const s of this.cfg.sameChain) {
      await this.discoverSame(s);
      const pub = this.c(s.chain).pub;
      const ids = Object.keys(routeState(this.state, s.name).pools) as Hex[];
      out.push(`== ${s.name} (same chain on ${s.chain.name}), ${ids.length} pools`);
      for (const id of ids) {
        const [dyn, due] = await Promise.all([
          readDyn(pub, s.hook, id, this.hAbi(s)),
          pub.readContract({ address: s.hook, abi: this.hAbi(s), functionName: "sampleDue", args: [id] }).catch(() => false),
        ]);
        out.push(`  ${id}: live=${dyn.live} jar=${dyn.exists ? await this.fmt(pub, dyn.quote, dyn.jar) : "-"} -> ${due ? "sample (tip due)" : "nothing"}`);
      }
    }
    return out;
  }
}
