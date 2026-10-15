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
  },
  // Testnet — source of truth: contracts/deployments/rh-testnet-46630.json (FLOW redeploy v2 2026-10-15, PR #10 9d9c311).
  // After a redeploy, edit these defaults or set NEXT_PUBLIC_RHT_* env.
  [robinhoodTestnet.id]: {
    launchpad: addr(process.env.NEXT_PUBLIC_RHT_LAUNCHPAD, "0x5A3C7743D365F770710FE15F4bBf1cEc7bc41006"),
    hook: addr(process.env.NEXT_PUBLIC_RHT_HOOK, "0x40Cb2f2a91eD48B013D88dA410Bb7F66Baa280C4"),
    router: addr(process.env.NEXT_PUBLIC_RHT_ROUTER, "0xF70F50F8C89A62E47b9ffa8F47d368B6215168B9"),
    feeRouter: addr(process.env.NEXT_PUBLIC_RHT_FEE_ROUTER, "0x13F813cFb0B14EFd01EB5026A92420b0A84C346C"),
    referralRegistry: addr(process.env.NEXT_PUBLIC_RHT_REFERRAL_REGISTRY, "0x1e124C3654B9880FBB6459ecfabE05E69058fcC2"),
    lockedLP: addr(process.env.NEXT_PUBLIC_RHT_LOCKED_LP, "0xc2D4c8796A8753c61c77bC65AE523DDecd1dF5e3"),
    quotePricer: addr(process.env.NEXT_PUBLIC_RHT_QUOTE_PRICER, "0xf2258181F75d3B7D74FDCeD6D116CC1D5e379778"),
    quoteProbe: addr(process.env.NEXT_PUBLIC_RHT_QUOTE_PROBE, "0xC3C18ebCBE5E66300dA35c6046a0B3c40dB38bbf"),
    migration: addr(process.env.NEXT_PUBLIC_RHT_MIGRATION, "0xFabc75DF0996083FC05fF7D63e8f11eF20421684"),
    antiSnipe: addr(process.env.NEXT_PUBLIC_RHT_ANTI_SNIPE, "0x0af141f678677293ca1B8B0a0ba6078888CeCC7A"),
    trampWallManager: addr(process.env.NEXT_PUBLIC_RHT_TRAMP_WALL_MANAGER, "0x901B5059BEE5aFd94C38069d6B10d5890ED533bd"),
    marketLens: addr(process.env.NEXT_PUBLIC_RHT_MARKET_LENS, "0x1d5fA9343d8049C8592f543fDedbEbD9174D59e9"),
    ...RH_V4,
    defaultQuote: addr(process.env.NEXT_PUBLIC_RHT_DEFAULT_QUOTE, "0xd4d0eB01960AACE441bFcb323Bfaf7c3d8b555a3"), // test STRATEGY (18 dec)
    usdg: addr(process.env.NEXT_PUBLIC_RHT_USDG, "0x25030Bff74764aD72b912276a603717DB1C00644"), // mUSDG (18 dec on testnet)
    fromBlock: BigInt(process.env.NEXT_PUBLIC_RHT_FROM_BLOCK || "136100595"),
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
  },
};

/** Smoke-test coins on the current testnet deploy (rh-testnet-46630.json → smoke). */
export const TESTNET_COINS = {
  /** test-STRATEGY coin, graduated to v4 (has tramp/wall smoke positions) */
  graduated: "0xfa86b94d37cba24910bd68426c5c0ace683d6628" as Address,
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
