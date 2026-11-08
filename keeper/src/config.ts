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

export interface Policy {
  /** Move trigger in bps. The hook pays from 100 bps; a little above avoids pushing a move that drifts back. */
  moveBps: bigint;
  /** Push the opening price of a pool that is not live yet (no refund for it). */
  firstPrice: boolean;
  /** Also send heartbeats for pools that did not trade (the hook does not refund these). */
  unpaidHeartbeats: boolean;
  /** Skip pools whose tank holds less than this (a refund is paid only from the tank). */
  minTank: bigint;
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
  const p = raw.policy ?? {};
  return {
    account: env.KEEPER_ACCOUNT ?? raw.account ?? "disciple",
    stateFile: env.KEEPER_STATE ?? raw.stateFile ?? "keeper-state.json",
    pollSeconds: Number(raw.pollSeconds ?? 12),
    chains,
    routes,
    policy: {
      moveBps: b(p.moveBps, 102n),
      firstPrice: p.firstPrice !== false,
      unpaidHeartbeats: p.unpaidHeartbeats === true,
      minTank: b(p.minTankWei, 1n),
      takeoverAfterSec: Number(p.takeoverAfterSec ?? 900),
      maxPoolsPerPush: Math.min(64, Number(p.maxPoolsPerPush ?? 64)),
      maxPushCost: parseEther(String(p.maxPushCostEth ?? "0.003")),
      packetTtlSec: Number(p.packetTtlSec ?? 6 * 3600),
    },
  };
}
