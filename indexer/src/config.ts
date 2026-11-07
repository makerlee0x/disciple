import fs from "node:fs";
import path from "node:path";
import { getAddress, type Address } from "viem";
import { parseQuoteDecimals } from "./decimals.js";

/** DiscipleHook indexing. Off unless DISCIPLE_HOOK is set, the deployment json has discipleHook, or the json is the 4663 catalog (kind "disciple", no Launchpad). */
export interface DiscipleConfig {
  hook: Address;
  poolManager: Address;
  v4Quoter?: Address;
  fromBlock: bigint;
  /** RPC for this hook. Defaults to the deployment json rpc (set DISCIPLE_RPC_URL when the hook is on a different chain than the Launchpad stacks). */
  rpcUrl: string;
  /** lowercase quote → USD WAD per 1e18 raw quote (USDG $1, 6 decimals → 1e30). */
  quoteUsdWad: Record<string, string>;
}

export interface Stack {
  id: string; // "v1" | "v2" | "v3" ...
  fromBlock: bigint;
  launchpad: Address;
  feeRouter: Address;
  hook: Address;
  migration?: Address;
  trampWallManager?: Address;
  anonLauncher?: Address;
  /** AnonLauncher v1 (legacy): still the Launchpad creator of private coins launched before v2. */
  anonLauncherLegacy?: Address;
  rewardsVault?: Address;
  referralRegistry?: Address;
  marketLens?: Address;
  quotePricer?: Address;
  /** LockedLP (LiquidityCompounded events). */
  lockedLP?: Address;
  /** v4: UsdgDepositNotifier (Deposited / Escrowed / Withdrawn / Attested) and LoginGate (PVE). */
  usdgDepositNotifier?: Address;
  loginGate?: Address;
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
  /** Only index up to head - confirmations (reorg safety margin). */
  confirmations: number;
  /** On a detected reorg, rewind this many blocks below the mismatched cursor. */
  reorgDepth: number;
  /** Max RPC requests per second (token bucket) and max chunk size floor for adaptive getLogs. */
  rpcRps: number;
  minChunk: bigint;
  /** QUOTE_DECIMALS="0xUSDG:6,0xSTRAT:18" — known quote decimals (skip the decimals() read); others are read on-chain. */
  quoteDecimals?: Record<string, number>;
  /** DiscipleHook mode. Absent ⇒ AscensionHook indexing only. */
  disciple?: DiscipleConfig;
}

/**
 * Builds stacks from contracts/deployments/rh-testnet-46630.json by walking the `previous` chain:
 *  current (v4, PR #97, startBlock 137540728) -> previous (v3) -> … -> v1 (PR #4).
 * Also accepts contracts/deployments/web-bundle/addresses.json (its `previous` has no `contracts`, so only that stack is used).
 * STACKS=v3 restricts to a subset. All stacks are indexed (old coins keep trading on their own hook/pools). EXTRA_DEPLOYMENT adds one more json.
 */
function stackOf(d: any, id: string, fromBlock: bigint): Stack {
  const c = d.contracts;
  return {
    id, fromBlock,
    // Deploy json still uses DiscipleHook for the Ascension graduation hook; newer catalogs may say AscensionHook.
    launchpad: c.Launchpad, feeRouter: c.FeeRouter, hook: c.AscensionHook ?? c.DiscipleHook, migration: c.Migration,
    trampWallManager: c.TrampWallManager, quotePricer: c.QuotePricer, lockedLP: c.LockedLP,
    anonLauncher: c.AnonLauncher ?? d.addons?.AnonLauncher?.address,
    anonLauncherLegacy: d.addons?.AnonLauncherLegacy?.address,
    rewardsVault: c.RewardsVault,
    referralRegistry: c.ReferralRegistry,
    marketLens: c.MarketLens ?? d.addons?.MarketLens?.address,
    usdgDepositNotifier: c.UsdgDepositNotifier,
    loginGate: c.LoginGate,
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
    const id = (i === chain.length - 1 && env.STACK_ID) || x.id || `v${i + 1}`;
    const fb = env[`${id.toUpperCase()}_FROM_BLOCK`] ?? x.startBlock ?? (id === "v1" ? 136090000 : 0);
    stacks.push(stackOf(x, id, BigInt(fb)));
  });
  // The newest stack's start block can be forced via START_BLOCK (e.g. after a redeploy whose json lacks startBlock).
  if (env.START_BLOCK && stacks.length) stacks[stacks.length - 1].fromBlock = BigInt(env.START_BLOCK);
  if (env.EXTRA_DEPLOYMENT) {
    const x = JSON.parse(fs.readFileSync(env.EXTRA_DEPLOYMENT, "utf8"));
    stacks.push(stackOf(x, env.EXTRA_STACK_ID ?? `v${stacks.length + 1}`, BigInt(x.startBlock ?? 0)));
  }
  const only = env.STACKS?.split(",").map((x) => x.trim()).filter(Boolean);
  const picked = only?.length ? stacks.filter((s) => only.includes(s.id)) : stacks;
  const rpcUrl = env.RPC_URL ?? d.rpc ?? "https://rpc.testnet.chain.robinhood.com";
  return {
    chainId: d.chainId ?? 46630,
    rpcUrl,
    stateView: d.uniswapV4?.StateView ?? "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    stacks: picked,
    dbPath: env.DB_PATH ?? "./disciple-indexer.sqlite",
    port: Number(env.PORT ?? 4200),
    chunk: BigInt(env.LOG_CHUNK ?? 20000),
    pollMs: Number(env.POLL_MS ?? 4000),
    confirmations: Number(env.CONFIRMATIONS ?? 2),
    reorgDepth: Number(env.REORG_DEPTH ?? 64),
    quoteDecimals: parseQuoteDecimals(env.QUOTE_DECIMALS),
    rpcRps: Number(env.RPC_RPS ?? 20),
    minChunk: BigInt(env.MIN_LOG_CHUNK ?? 500),
    disciple: loadDisciple(d, env, rpcUrl),
  };
}

const RH_POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
/** Live same-chain STRATEGY/USDG DiscipleHook on Robinhood 4663 (contracts/deployments/rh-4663-disciple-hook.json). */
const RH_DISCIPLE_HOOK = "0xcEdc3C312C5B3C4310F0fba0323DDeC797E4aA88";
const RH_DISCIPLE_FROM_BLOCK = 106431488n;

/** Catalog json (no Launchpad) or an explicit hook turns the adapter on. The testnet stack json does not. */
function loadDisciple(d: any, env: NodeJS.ProcessEnv, rpcUrl: string): DiscipleConfig | undefined {
  const catalog = d?.kind === "disciple" || (d?.hook && d?.pools && !d?.contracts?.Launchpad) ? d : null;
  const hookRaw = env.DISCIPLE_HOOK ?? d?.discipleHook?.address ?? catalog?.hook;
  if (!hookRaw) return undefined;
  const hook = getAddress(hookRaw);
  const pools: any[] = catalog?.pools ?? d?.discipleHook?.pools ?? [];
  const quoteUsdWad: Record<string, string> = {};
  for (const p of pools) {
    if (p?.quote && p?.quotePriceUsdWad) quoteUsdWad[String(p.quote).toLowerCase()] = String(p.quotePriceUsdWad);
  }
  for (const part of (env.DISCIPLE_QUOTE_USD ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [a, w] = part.split(":");
    if (a && w) quoteUsdWad[a.toLowerCase()] = w;
  }
  const pm = env.DISCIPLE_POOL_MANAGER ?? d?.discipleHook?.poolManager ?? catalog?.poolManager ?? d?.uniswapV4?.PoolManager ?? RH_POOL_MANAGER;
  const quoter = env.DISCIPLE_V4_QUOTER ?? d?.discipleHook?.v4Quoter ?? catalog?.v4Quoter ?? d?.uniswapV4?.V4Quoter;
  const fromRaw = env.DISCIPLE_FROM_BLOCK ?? d?.discipleHook?.fromBlock ?? catalog?.fromBlock;
  // Never default to block 0 beside Launchpad stacks — that would replay the whole chain.
  const fromBlock = fromRaw != null && String(fromRaw) !== ""
    ? BigInt(fromRaw)
    : hook === getAddress(RH_DISCIPLE_HOOK) ? RH_DISCIPLE_FROM_BLOCK : undefined;
  if (fromBlock == null) return undefined;
  return {
    hook,
    poolManager: getAddress(pm),
    v4Quoter: quoter ? getAddress(quoter) : undefined,
    fromBlock,
    rpcUrl: env.DISCIPLE_RPC_URL ?? catalog?.rpc ?? d?.discipleHook?.rpc ?? rpcUrl,
    quoteUsdWad,
  };
}
