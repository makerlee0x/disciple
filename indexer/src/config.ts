import fs from "node:fs";
import path from "node:path";
import type { Address } from "viem";

export interface Stack {
  id: string; // "v1" | "v2" | "v3" ...
  fromBlock: bigint;
  launchpad: Address;
  feeRouter: Address;
  hook: Address;
  migration?: Address;
  trampWallManager?: Address;
  anonLauncher?: Address;
  rewardsVault?: Address;
  marketLens?: Address;
  quotePricer?: Address;
}

export interface Config {
  chainId: number;
  rpcUrl: string;
  stateView: Address;
  stacks: Stack[];
  dbPath: string;
  port: number;
  chunk: bigint;
  pollMs: number;
}

/**
 * Builds stacks from contracts/deployments/rh-testnet-46630.json by walking the `previous` chain:
 *  current (v3, combined redeploy) -> previous (v2, PR #10 + add-ons) -> previous.previous (v1, PR #4).
 * All stacks are indexed (old coins keep trading on their own hook/pools). EXTRA_DEPLOYMENT adds one more json.
 */
function stackOf(d: any, id: string, fromBlock: bigint): Stack {
  const c = d.contracts;
  return {
    id, fromBlock,
    launchpad: c.Launchpad, feeRouter: c.FeeRouter, hook: c.DiscipleHook, migration: c.Migration,
    trampWallManager: c.TrampWallManager, quotePricer: c.QuotePricer,
    anonLauncher: c.AnonLauncher ?? d.addons?.AnonLauncher?.address,
    rewardsVault: c.RewardsVault,
    marketLens: c.MarketLens ?? d.addons?.MarketLens?.address,
  };
}

export function loadConfig(env = process.env): Config {
  const depPath =
    env.DEPLOYMENT_JSON ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../contracts/deployments/rh-testnet-46630.json");
  const d = JSON.parse(fs.readFileSync(depPath, "utf8"));
  const chain: any[] = [];
  for (let x = d; x?.contracts?.Launchpad; x = x.previous) chain.push(x);
  const stacks: Stack[] = [];
  const seen = new Set<string>();
  chain.reverse().forEach((x, i) => {
    const L = String(x.contracts.Launchpad).toLowerCase();
    if (seen.has(L)) return;
    seen.add(L);
    const id = x.id ?? `v${i + 1}`;
    const fb = env[`${id.toUpperCase()}_FROM_BLOCK`] ?? x.startBlock ?? (id === "v1" ? 136090000 : 0);
    stacks.push(stackOf(x, id, BigInt(fb)));
  });
  if (env.EXTRA_DEPLOYMENT) {
    const x = JSON.parse(fs.readFileSync(env.EXTRA_DEPLOYMENT, "utf8"));
    stacks.push(stackOf(x, env.EXTRA_STACK_ID ?? `v${stacks.length + 1}`, BigInt(x.startBlock ?? 0)));
  }
  return {
    chainId: d.chainId,
    rpcUrl: env.RPC_URL ?? d.rpc,
    stateView: d.uniswapV4.StateView,
    stacks,
    dbPath: env.DB_PATH ?? "./disciple-indexer.sqlite",
    port: Number(env.PORT ?? 4200),
    chunk: BigInt(env.LOG_CHUNK ?? 20000),
    pollMs: Number(env.POLL_MS ?? 4000),
  };
}
