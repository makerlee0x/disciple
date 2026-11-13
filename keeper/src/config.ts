import { readFileSync } from "node:fs";
import { getAddress, parseEther, parseGwei, type Hex } from "viem";

export interface ChainCfg {
  name: string;
  rpc: string;
  chainId: number;
  eid: number;
  endpoint: Hex;
  /** Max block range per eth_getLogs (Alchemy free tier: 10). */
  logChunk: bigint;
  /** Max getLogs calls per chain per tick while catching up. */
  logCallsPerTick: number;
  priorityFee: bigint;
  maxFee: bigint;
}

export interface RouteCfg {
  name: string;
  home: ChainCfg;
  dest: ChainCfg;
  sender: Hex; // DisciplePushSender on the home chain
  receiver: Hex; // DisciplePushReceiver on the destination
  hook?: Hex; // read from receiver.hook() when omitted
  hookFromBlock: bigint; // scan Created events from here (the hook's deploy block)
  senderFromBlock: bigint; // scan Pushed events from here (for takeover of other keepers' packets); 0 = from now
  pools: Hex[]; // pools to serve even if the Created scan has not reached them
  scanPools: boolean;
  scanPushes: boolean;
}

/** Same-chain Disciple pools on one chain: the keeper calls sample() when the hook says a tip is due. */
export interface SameChainCfg {
  name: string;
  chain: ChainCfg;
  hook: Hex;
  fromBlock: bigint; // scan Created events from here (the hook's deploy block); 0 = from now
  pools: Hex[]; // pools to serve even if the Created scan has not reached them
  scanPools: boolean;
  /** Which hook build: "disciple" (default) or "carry" (Carry's follower hook: same sample()/sampleDue() and pool
   *  storage head, but a shorter poolState view with no cross-chain fields). */
  abi: "disciple" | "carry";
  /** Carry only: the CarryStockQueue, where stock waits for lender USDG (unset = no matching). The keeper matches
   *  its lines (matchOrders) whenever a dry run says USDG is free for the stock at their front. */
  stockQueue?: Hex;
}

export interface Sampling {
  /** How often to check same-chain pools, seconds (each check is one sampleDue eth_call per pool). */
  everySec: number;
  /** After this many sample() calls in a row that paid no tip (unvalued pool, or lost the block), rest the pool. */
  missesBeforeRest: number;
  restSec: number;
  /** Least seconds between two samples of one pool. The hook takes one reading per block, and on Arbitrum-stack
   *  chains (Robinhood) block.number is the L1 block, about 12 s, so a second sample sooner does nothing but cost gas. */
  minGapSec: number;
  /** 0 = off. Otherwise also sample, unpaid and at our own gas, when a pool's centre is at least this many bps from
   *  its leader's live price, below the hook's 1% tip line. Keeps a low-fee pool quoting at the market. */
  selfPayBps: number;
  /** selfPayBps for Carry pools (`abi: "carry"`), default 15. The Carry vault takes a deposit (a paired stock + own
   *  USDG deposit goes straight to it) only while the pool's centre is within its fee, at most 0.25%, of the leader,
   *  so its centre has to stay that close for deposits to go through at any time, not only when the 1% tip pays. */
  selfPayBpsCarry: number;
  /** Most unpaid (selfPayBps) samples per pool per hour, a cost ceiling. */
  selfPayMaxPerHour: number;
  /** Carry pools only: how often to check each pool's Morpho tail, seconds (0 = never sweep). Swaps pull USDG out of
   *  Morpho when a sell needs it, but never rebalance: this keeper does, with the hook's sweep(), both ways. */
  sweepEverySec: number;
  /** Sweep once a pool's hot quote is above this multiple of its hot target or below the target divided by it, in
   *  bps (20000 = 2x: at the default 20% target, sweep when hot passes 40% or drops under 10%, back to 20%). */
  sweepBandBps: number;
  /** Carry stock queue: how often to check each market's line, seconds (0 = never match). Each check is a dry run
   *  of matchOrders per market with stock waiting; a transaction is sent only when it would match something. */
  matchEverySec: number;
  /** Orders one matchOrders call works through at most. */
  matchSteps: number;
  /** Carry stock queue: most unpaid samples per pool per hour taken to unblock waiting stock (0 = never). The vault
   *  takes a deposit only while the pool's centre is within its fee (at most 0.25%) of the leader, both live and at
   *  the last block's reading, and the hook's paid tip line is 1%. So in a quiet market waiting stock can sit there
   *  with lender USDG free. When a match dry run finds nothing while USDG is free and the centre is off the leader,
   *  the keeper samples the pool, at its own gas, and tries again next round (a second reading in a later block
   *  clears the last-block half of the check). */
  matchSampleMaxPerHour: number;
}

export interface Policy {
  /** Move trigger in bps. The hook pays from 100 bps; a little above avoids pushing a move that drifts back. */
  moveBps: bigint;
  /** Push the opening price of a pool that is not live yet (no refund for it). */
  firstPrice: boolean;
  /** Also send heartbeats for pools that did not trade (the hook does not refund these). */
  unpaidHeartbeats: boolean;
  /** Skip pools whose tip jar is worth less than this, in the pool's quote raw units (0 = serve every pool:
   *  pushes to an empty jar still move the price, and trades refill the jar from the 12% skim). */
  minJar: bigint;
  /** How often to take the jar credits the hook keeps for this keeper (owed -> collect), seconds. */
  collectEverySec: number;
  /** Deliver other keepers' packets that are still undelivered after this many seconds. */
  takeoverAfterSec: number;
  maxPoolsPerPush: number;
  /** Do not send a push whose LayerZero fee + home gas at the current max fee is above this. */
  maxPushCost: bigint;
  /** Give up on a packet (stop retrying) after this long. */
  packetTtlSec: number;
}

export interface Config {
  account: string;
  stateFile: string;
  pollSeconds: number;
  chains: Record<string, ChainCfg>;
  routes: RouteCfg[];
  sameChain: SameChainCfg[];
  sampling: Sampling;
  policy: Policy;
}

const DEFAULT_CHAINS: Record<string, Partial<ChainCfg> & { rpcEnv: string }> = {
  ethereum: {
    rpcEnv: "ETH_RPC",
    chainId: 1,
    eid: 30101,
    endpoint: "0x1a44076050125825900e736c501f859c50fE728c",
  },
  robinhood: {
    rpcEnv: "RH_RPC",
    chainId: 4663,
    eid: 30416,
    endpoint: "0x6F475642a6e85809B1c36Fa62763669b1b48DD5B",
  },
};

const b = (v: unknown, d: bigint): bigint => (v === undefined || v === null ? d : BigInt(v as string | number));

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Config {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const chains: Record<string, ChainCfg> = {};
  const names = new Set([...Object.keys(DEFAULT_CHAINS), ...Object.keys(raw.chains ?? {})]);
  for (const name of names) {
    const c = { ...(DEFAULT_CHAINS[name] ?? {}), ...((raw.chains ?? {})[name] ?? {}) } as Record<string, unknown>;
    const rpcEnv = (c.rpcEnv as string) ?? `${name.toUpperCase()}_RPC`;
    const rpc = (c.rpc as string) ?? env[rpcEnv];
    if (!rpc) continue; // chain not configured: routes using it fail below
    chains[name] = {
      name,
      rpc,
      chainId: Number(c.chainId),
      eid: Number(c.eid),
      endpoint: getAddress(c.endpoint as string),
      logChunk: b(c.logChunk, 10n),
      logCallsPerTick: Number(c.logCallsPerTick ?? 20),
      priorityFee: parseGwei(String(c.priorityFeeGwei ?? (name === "ethereum" ? "0.003" : "0"))),
      maxFee: parseGwei(String(c.maxFeeGwei ?? (name === "ethereum" ? "30" : "1"))),
    };
  }
  const routes: RouteCfg[] = (raw.routes ?? []).map((r: Record<string, unknown>) => {
    const home = chains[r.home as string];
    const dest = chains[r.dest as string];
    if (!home || !dest) throw new Error(`route ${r.name}: set the RPC for ${r.home} and ${r.dest}`);
    return {
      name: (r.name as string) ?? `${r.home}-to-${r.dest}`,
      home,
      dest,
      sender: getAddress(r.sender as string),
      receiver: getAddress(r.receiver as string),
      hook: r.hook ? getAddress(r.hook as string) : undefined,
      hookFromBlock: b(r.hookFromBlock, 0n),
      senderFromBlock: b(r.senderFromBlock, 0n),
      pools: ((r.pools as string[]) ?? []).map((p) => p.toLowerCase() as Hex),
      scanPools: r.scanPools !== false,
      scanPushes: r.scanPushes !== false,
    };
  });
  const sameChain: SameChainCfg[] = (raw.sameChain ?? []).map((r: Record<string, unknown>) => {
    const chain = chains[r.chain as string];
    if (!chain) throw new Error(`sameChain ${r.name ?? r.chain}: set the RPC for ${r.chain}`);
    return {
      name: (r.name as string) ?? `${r.chain}-same`,
      chain,
      hook: getAddress(r.hook as string),
      fromBlock: b(r.fromBlock, 0n),
      pools: ((r.pools as string[]) ?? []).map((p) => p.toLowerCase() as Hex),
      scanPools: r.scanPools !== false,
      abi: r.abi === "carry" ? "carry" : "disciple",
      stockQueue: r.stockQueue ? getAddress(r.stockQueue as string) : undefined,
    };
  });
  const sm = raw.sampling ?? {};
  const p = raw.policy ?? {};
  return {
    account: env.KEEPER_ACCOUNT ?? raw.account ?? "disciple",
    stateFile: env.KEEPER_STATE ?? raw.stateFile ?? "keeper-state.json",
    pollSeconds: Number(raw.pollSeconds ?? 12),
    chains,
    routes,
    sameChain,
    sampling: {
      everySec: Number(sm.everySec ?? 13),
      missesBeforeRest: Number(sm.missesBeforeRest ?? 3),
      restSec: Number(sm.restSec ?? 3600),
      minGapSec: Number(sm.minGapSec ?? 13),
      selfPayBps: Number(sm.selfPayBps ?? 0),
      selfPayBpsCarry: Number(sm.selfPayBpsCarry ?? 15),
      selfPayMaxPerHour: Number(sm.selfPayMaxPerHour ?? 60),
      sweepEverySec: Number(sm.sweepEverySec ?? 60),
      sweepBandBps: Number(sm.sweepBandBps ?? 20_000),
      matchEverySec: Number(sm.matchEverySec ?? 60),
      matchSteps: Number(sm.matchSteps ?? 20),
      matchSampleMaxPerHour: Number(sm.matchSampleMaxPerHour ?? 12),
    },
    policy: {
      moveBps: b(p.moveBps, 102n),
      firstPrice: p.firstPrice !== false,
      unpaidHeartbeats: p.unpaidHeartbeats === true,
      minJar: b(p.minJar, 0n),
      collectEverySec: Number(p.collectEverySec ?? 86_400),
      takeoverAfterSec: Number(p.takeoverAfterSec ?? 900),
      maxPoolsPerPush: Math.min(64, Number(p.maxPoolsPerPush ?? 64)),
      maxPushCost: parseEther(String(p.maxPushCostEth ?? "0.003")),
      packetTtlSec: Number(p.packetTtlSec ?? 6 * 3600),
    },
  };
}
