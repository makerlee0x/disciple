// The keeper loop: find cross-chain Disciple pools, push their home source price when the hook will pay for it,
// and finish delivery on the destination (DiscipleSelfExecutor: nobody else is paid to deliver).
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  formatEther,
  http,
  pad,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { endpointAbi, hookAbi, receiverAbi, senderAbi, ulnAbi } from "./abi.ts";
import type { ChainCfg, Config, RouteCfg } from "./config.ts";
import { readDyn, readSource, type PoolDyn, type PoolSource } from "./hook.ts";
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
  if (dyn.tank < cfg.minTank) return null;
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

/** Split due pools into messages: at most `maxPools` listings and MAX_MESSAGE_SIZE bytes each. */
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

  async tick(): Promise<void> {
    for (const r of this.cfg.routes) {
      try {
        await this.discover(r);
        await this.scanPushes(r);
        await this.pushDue(r);
        await this.deliver(r);
      } catch (e) {
        this.log.warn(`${r.name}: ${(e as Error).message?.split("\n")[0] ?? e}`);
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
      const price = shift(s.decShift, spotX128(s.kind, ab[0], ab[1], s.coinIs0));
      const d = judge(id, s, dyn, price, blk.timestamp, inflight.get(id.toLowerCase()), this.cfg.policy);
      const age = dyn.live ? `${blk.timestamp - dyn.obsAt}s` : "-";
      report.push(
        `${id}: live=${dyn.live} local=${dyn.local} age=${age} move=${moveBps(dyn.anchorX128, price).toFixed(2)}bps ` +
          `traded=${dyn.traded} tank=${formatEther(dyn.tank)} -> ${d ? d.reason : "nothing"}`,
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
    const hash = await wal.writeContract({
      chain,
      account: this.account,
      address: r.sender,
      abi: senderAbi,
      functionName: "push",
      args: [r.dest.eid, to, reqs, gas],
      value,
      gas: (est * 6n) / 5n,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: tip,
    });
    const rc = await pub.waitForTransactionReceipt({ hash });
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
      const hash = await wal.writeContract({
        chain,
        account: this.account,
        address: lib,
        abi: ulnAbi,
        functionName: "commitVerification",
        args: [p.header, ph],
        ...this.fees(r.dest),
      });
      const rc = await pub.waitForTransactionReceipt({ hash });
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
      const hash = await wal.writeContract({
        chain,
        account: this.account,
        address: r.dest.endpoint,
        abi: endpointAbi,
        functionName: "lzReceive",
        args,
        gas: lzReceiveGas(n, est),
        ...this.fees(r.dest),
      });
      const rc = await pub.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new Error(`lzReceive ${hash} reverted`);
      drop.add(p);
      const spent = BigInt(p.spent ?? "0") + rc.gasUsed * rc.effectiveGasPrice;
      let refund = 0n;
      const notes: string[] = [];
      for (const l of rc.logs) {
        try {
          const ev = decodeEventLog({ abi: [...hookAbi, ...receiverAbi], data: l.data, topics: l.topics });
          if (ev.eventName === "PriceAccepted") {
            refund += ev.args.refund;
            notes.push(`${ev.args.id.slice(0, 10)} accepted, refund ${formatEther(ev.args.refund)}`);
          } else if (ev.eventName === "PriceRejected") notes.push(`${ev.args.id.slice(0, 10)} rejected`);
          else if (ev.eventName === "Undelivered") notes.push(`${ev.args.id.slice(0, 10)} UNDELIVERED`);
        } catch {
          /* other logs */
        }
      }
      this.log.info(
        `${r.name}: delivered nonce ${p.nonce} (${t - p.sentAt}s after push) tx ${hash}; ${notes.join("; ") || "no pool events"}` +
          (p.ours
            ? `; refunds ${formatEther(refund)} ETH, spent ${formatEther(spent)} ETH, net ${refund >= spent ? "+" : "-"}${formatEther(refund >= spent ? refund - spent : spent - refund)} ETH`
            : `; takeover for ${msg.keeper}`),
      );
    }
    this.state.packets = this.state.packets.filter((p) => !drop.has(p));
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
    }
    return out;
  }
}
