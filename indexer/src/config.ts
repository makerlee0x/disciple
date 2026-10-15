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
 * Builds stacks from contracts/deployments/rh-testnet-46630.json:
 *  - "previous" (v1, PR #4), current (v2, PR #10 + add-ons), and, if present, a v3 file
 *    (EXTRA_DEPLOYMENT=path to the post-redeploy json, i.e. the next rh-testnet-46630.json).
 */
export function loadConfig(env = process.env): Config {
  const depPath =
    env.DEPLOYMENT_JSON ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../contracts/deployments/rh-testnet-46630.json");
  const d = JSON.parse(fs.readFileSync(depPath, "utf8"));
  const stacks: Stack[] = [];
  if (d.previous?.contracts?.Launchpad && d.previous.contracts.Launchpad !== d.contracts.Launchpad && !d.previous.addons) {
    const p = d.previous.contracts;
    stacks.push({
      id: "v1",
      fromBlock: BigInt(env.V1_FROM_BLOCK ?? 136090000),
      launchpad: p.Launchpad, feeRouter: p.FeeRouter, hook: p.DiscipleHook, migration: p.Migration,
      quotePricer: p.QuotePricer,
    });
  }
  const c = d.contracts;
  stacks.push({
    id: env.CURRENT_STACK_ID ?? "v2",
    fromBlock: BigInt(d.startBlock ?? 0),
    launchpad: c.Launchpad, feeRouter: c.FeeRouter, hook: c.DiscipleHook, migration: c.Migration,
    trampWallManager: c.TrampWallManager, quotePricer: c.QuotePricer,
    anonLauncher: c.AnonLauncher ?? d.addons?.AnonLauncher?.address,
    rewardsVault: c.RewardsVault,
    marketLens: c.MarketLens ?? d.addons?.MarketLens?.address,
  });
  if (env.EXTRA_DEPLOYMENT) {
    const x = JSON.parse(fs.readFileSync(env.EXTRA_DEPLOYMENT, "utf8"));
    const e = x.contracts;
    stacks.push({
      id: env.EXTRA_STACK_ID ?? "v3", fromBlock: BigInt(x.startBlock ?? 0),
      launchpad: e.Launchpad, feeRouter: e.FeeRouter, hook: e.DiscipleHook, migration: e.Migration,
      trampWallManager: e.TrampWallManager, quotePricer: e.QuotePricer, anonLauncher: e.AnonLauncher,
      rewardsVault: e.RewardsVault, marketLens: e.MarketLens,
    });
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
