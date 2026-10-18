/**
 * Per-chain DISCIPLE deployment config. ONE place to edit after a redeploy:
 *  - pick the chain with NEXT_PUBLIC_CHAIN_ID (46630 testnet default, 4663 mainnet, 31337 anvil)
 *  - every address can be overridden by env (NEXT_PUBLIC_<NET>_<NAME>); defaults below.
 * Zero-address launchpad ⇒ isDeployed() false ⇒ UI stays on mock/replay sources.
 */
import { defineChain, type Address } from "viem";
import { CHAIN, STRATEGY_TOKEN } from "./config";

const Z = "0x0000000000000000000000000000000000000000" as Address;
const addr = (v: string | undefined, fallback: Address = Z) => ((v && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : fallback) as Address);

export const robinhood = defineChain({
  id: CHAIN.id,
  name: CHAIN.name,
  nativeCurrency: CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_RH_RPC_URL || CHAIN.rpcUrl] } },
});

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_RHT_RPC_URL || "https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "RH Testnet Explorer", url: "https://explorer.testnet.chain.robinhood.com" } },
  testnet: true,
});

export const anvil = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_ANVIL_RPC_URL || "http://127.0.0.1:8545"] } },
});

/** Uniswap v4 periphery on Robinhood Chain (same addresses on 4663 and 46630, checked by FLOW 2026-10-15). */
const RH_V4 = {
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address,
  v4Quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94" as Address,
  stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b" as Address,
  universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904" as Address,
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
};

export interface Deployment {
  launchpad: Address;
  hook: Address;
  /** DiscipleRouter (post-grad buyExactIn/sellExactIn/quoteExactIn). Zero ⇒ graduated trading disabled. */
  router: Address;
  feeRouter: Address;
  referralRegistry: Address;
  lockedLP: Address;
  quotePricer: Address;
  quoteProbe: Address;
  migration: Address;
  antiSnipe: Address;
  trampWallManager: Address;
  /** Read-only MarketLens add-on: live v4 mcap/price for graduated coins (curve mcapNow freezes post-grad). */
  marketLens: Address;
  poolManager: Address;
  v4Quoter: Address;
  stateView: Address;
  universalRouter: Address;
  permit2: Address;
  /** Expected factory defaultQuote (display hint; the contract value wins). */
  defaultQuote: Address;
  /** USDG (or mock) — decimals are read on-chain, never assumed. */
  usdg: Address;
  /** First block to scan for events. */
  fromBlock: bigint;
  /** REDEPLOY ONLY (feat/modes-gas): UsdgDepositNotifier (referral-gate escrow). Zero until the redeploy lands. */
  depositNotifier: Address;
}

// NOTE: NEXT_PUBLIC_* must be referenced literally for Next.js to inline them.
export const DEPLOYMENTS: Record<number, Deployment> = {
  [robinhood.id]: {
    launchpad: addr(process.env.NEXT_PUBLIC_RH_LAUNCHPAD),
    hook: addr(process.env.NEXT_PUBLIC_RH_HOOK),
    router: addr(process.env.NEXT_PUBLIC_RH_ROUTER),
    feeRouter: addr(process.env.NEXT_PUBLIC_RH_FEE_ROUTER),
    referralRegistry: addr(process.env.NEXT_PUBLIC_RH_REFERRAL_REGISTRY),
    lockedLP: addr(process.env.NEXT_PUBLIC_RH_LOCKED_LP),
    quotePricer: addr(process.env.NEXT_PUBLIC_RH_QUOTE_PRICER),
    quoteProbe: addr(process.env.NEXT_PUBLIC_RH_QUOTE_PROBE),
    migration: addr(process.env.NEXT_PUBLIC_RH_MIGRATION),
    antiSnipe: addr(process.env.NEXT_PUBLIC_RH_ANTI_SNIPE),
    trampWallManager: addr(process.env.NEXT_PUBLIC_RH_TRAMP_WALL_MANAGER),
    marketLens: addr(process.env.NEXT_PUBLIC_RH_MARKET_LENS),
    ...RH_V4,
    defaultQuote: STRATEGY_TOKEN.address,
    usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    fromBlock: BigInt(process.env.NEXT_PUBLIC_RH_FROM_BLOCK || "0"),
    depositNotifier: addr(process.env.NEXT_PUBLIC_RH_DEPOSIT_NOTIFIER),
  },
  // Testnet — source of truth: contracts/deployments/web-bundle @ 27e92d8 (FLOW combined redeploy v3, startBlock 136187963).
  // After a redeploy, edit these defaults or set NEXT_PUBLIC_RHT_* env. Do NOT send new launches to the old v2 stack (SEC-01).
  [robinhoodTestnet.id]: {
    launchpad: addr(process.env.NEXT_PUBLIC_RHT_LAUNCHPAD, "0xf5c09182091e527f0445ce065f7fc59d4b55cede"),
    hook: addr(process.env.NEXT_PUBLIC_RHT_HOOK, "0xbc13b0bb1b18f479872f52dcddc840b8041300c4"),
    router: addr(process.env.NEXT_PUBLIC_RHT_ROUTER, "0xCfb16275fCbcF124dDe54F3dbc36ddC684111564"),
    feeRouter: addr(process.env.NEXT_PUBLIC_RHT_FEE_ROUTER, "0xf04f7d3b54f86cc5333e7e2302850b023c796e69"),
    referralRegistry: addr(process.env.NEXT_PUBLIC_RHT_REFERRAL_REGISTRY, "0x633be77ee01aafb35297950d88168ca052e1f9ac"),
    lockedLP: addr(process.env.NEXT_PUBLIC_RHT_LOCKED_LP, "0x09cdfa29e3a25c91c7807ef779b0e376d5f1fd11"),
    quotePricer: addr(process.env.NEXT_PUBLIC_RHT_QUOTE_PRICER, "0x37427357b6d0db92137872d6b7d17c9cede72c40"),
    quoteProbe: addr(process.env.NEXT_PUBLIC_RHT_QUOTE_PROBE, "0xeec226531767a8da505af01f11399ebb3dc9ca36"),
    migration: addr(process.env.NEXT_PUBLIC_RHT_MIGRATION, "0x67830dba366f2ae12cb7285d50cb22a721549285"),
    antiSnipe: addr(process.env.NEXT_PUBLIC_RHT_ANTI_SNIPE, "0x44afe78fc0ef4578d1d1d461b2eb23585615209a"),
    trampWallManager: addr(process.env.NEXT_PUBLIC_RHT_TRAMP_WALL_MANAGER, "0xCCD9c94D7d4877fb487b01960C77917f6Df2F3fE"),
    marketLens: addr(process.env.NEXT_PUBLIC_RHT_MARKET_LENS, "0x4683F586aD2F70443f74f40751D202494EC9d0Ed"),
    ...RH_V4,
    defaultQuote: addr(process.env.NEXT_PUBLIC_RHT_DEFAULT_QUOTE, "0xd4d0eB01960AACE441bFcb323Bfaf7c3d8b555a3"), // test STRATEGY (18 dec; reused from v1)
    usdg: addr(process.env.NEXT_PUBLIC_RHT_USDG, "0x25030Bff74764aD72b912276a603717DB1C00644"), // mUSDG (18 dec on testnet)
    fromBlock: BigInt(process.env.NEXT_PUBLIC_RHT_FROM_BLOCK || "136187963"),
    depositNotifier: addr(process.env.NEXT_PUBLIC_RHT_DEPOSIT_NOTIFIER),
  },
  [anvil.id]: {
    launchpad: addr(process.env.NEXT_PUBLIC_ANVIL_LAUNCHPAD),
    hook: addr(process.env.NEXT_PUBLIC_ANVIL_HOOK),
    router: addr(process.env.NEXT_PUBLIC_ANVIL_ROUTER),
    feeRouter: addr(process.env.NEXT_PUBLIC_ANVIL_FEE_ROUTER),
    referralRegistry: addr(process.env.NEXT_PUBLIC_ANVIL_REFERRAL_REGISTRY),
    lockedLP: addr(process.env.NEXT_PUBLIC_ANVIL_LOCKED_LP),
    quotePricer: addr(process.env.NEXT_PUBLIC_ANVIL_QUOTE_PRICER),
    quoteProbe: addr(process.env.NEXT_PUBLIC_ANVIL_QUOTE_PROBE),
    migration: addr(process.env.NEXT_PUBLIC_ANVIL_MIGRATION),
    antiSnipe: addr(process.env.NEXT_PUBLIC_ANVIL_ANTI_SNIPE),
    trampWallManager: addr(process.env.NEXT_PUBLIC_ANVIL_TRAMP_WALL_MANAGER),
    marketLens: addr(process.env.NEXT_PUBLIC_ANVIL_MARKET_LENS),
    poolManager: addr(process.env.NEXT_PUBLIC_ANVIL_POOL_MANAGER),
    v4Quoter: Z, stateView: Z, universalRouter: Z, permit2: RH_V4.permit2,
    defaultQuote: addr(process.env.NEXT_PUBLIC_ANVIL_DEFAULT_QUOTE),
    usdg: addr(process.env.NEXT_PUBLIC_ANVIL_USDG),
    fromBlock: BigInt(0),
    depositNotifier: addr(process.env.NEXT_PUBLIC_ANVIL_DEPOSIT_NOTIFIER),
  },
};

/** Smoke-test coins on the current testnet deploy (web-bundle @ 27e92d8 → smoke). */
export const TESTNET_COINS = {
  /**
   * v3 smoke coin (graduated to v4). Old v2 graduated coin 0xfa86…6628 is stale —
   * do not send new launches to the v2 stack (SEC-01).
   */
  graduated: "0xcac8A9654dE3aE01470fC9E93e58fb97d5B86bb3" as Address,
};

const CHAINS = { [robinhood.id]: robinhood, [robinhoodTestnet.id]: robinhoodTestnet, [anvil.id]: anvil } as const;
const WANT = Number(process.env.NEXT_PUBLIC_CHAIN_ID || robinhoodTestnet.id);
export const ACTIVE_CHAIN = CHAINS[WANT as keyof typeof CHAINS] ?? robinhoodTestnet;
export const deployment = () => DEPLOYMENTS[ACTIVE_CHAIN.id];
export const isDeployed = () => deployment().launchpad !== Z;
export const hasRouter = () => deployment().router !== Z;
export const hasLens = () => deployment().marketLens !== Z;
export const ZERO = Z;
/** Testnet gas faucet (ETH). */
export const GAS_FAUCET = "https://faucet.testnet.chain.robinhood.com/";
/** Test quote tokens with a public mint(address,uint256) — testnet only. */
export const MINTABLE_TEST_TOKENS = ACTIVE_CHAIN.id === 46630
  ? [
      { symbol: "STRATEGY", address: deployment().defaultQuote, amount: "1000000" },
      { symbol: "mUSDG", address: deployment().usdg, amount: "1000" },
    ]
  : [];
