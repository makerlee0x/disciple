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
/** ERC-20 decimals from env (integer 0..36), else the per-chain default. */
export const decimalsEnv = (v: string | undefined, fallback: number) => (v && /^\d{1,2}$/.test(v.trim()) && Number(v) <= 36 ? Number(v) : fallback);

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
  /** v4: PVE login gate (EIP-712 'DisciplePVE' v1 attestations, lib/pve.ts). Zero ⇒ PVE buys unavailable. */
  loginGate: Address;
  /** v4: USDG referral-gate escrow (ReferralRegistry.depositHook). */
  usdgDepositNotifier: Address;
  poolManager: Address;
  v4Quoter: Address;
  stateView: Address;
  universalRouter: Address;
  permit2: Address;
  /** Expected factory defaultQuote (display hint; the contract value wins). */
  defaultQuote: Address;
  /** USDG (or mock). */
  usdg: Address;
  /**
   * USDG decimals — the single source of truth for every $ ⇄ USDG raw conversion (lib/usdg.ts). Mainnet USDG = 6;
   * today's testnet mUSDG = 18; the testnet redeploy (~Nov 2) switches to a 6-dec USDG via NEXT_PUBLIC_RHT_USDG_DECIMALS=6
   * (+ NEXT_PUBLIC_RHT_USDG). scripts/check-usdg-decimals.mts asserts it against the token's decimals().
   */
  usdgDecimals: number;
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
    loginGate: addr(process.env.NEXT_PUBLIC_RH_LOGIN_GATE),
    usdgDepositNotifier: addr(process.env.NEXT_PUBLIC_RH_USDG_DEPOSIT_NOTIFIER),
    ...RH_V4,
    defaultQuote: STRATEGY_TOKEN.address,
    usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    usdgDecimals: decimalsEnv(process.env.NEXT_PUBLIC_RH_USDG_DECIMALS, 6),
    fromBlock: BigInt(process.env.NEXT_PUBLIC_RH_FROM_BLOCK || "0"),
  },
  // Testnet — source of truth: contracts/deployments/rh-testnet-46630.json on main (PR #97, v4 from main@fdd436b5, startBlock 137540728).
  // After a redeploy, edit these defaults or set NEXT_PUBLIC_RHT_* env. Do NOT send new launches to the old v2 stack (SEC-01).
  [robinhoodTestnet.id]: {
    launchpad: addr(process.env.NEXT_PUBLIC_RHT_LAUNCHPAD, "0x4f540bc1585ca36c8a49662dc642f6e28ae534da"),
    hook: addr(process.env.NEXT_PUBLIC_RHT_HOOK, "0x16b6a7912324b67e562769bf7ed7e048ef6128c4"),
    router: addr(process.env.NEXT_PUBLIC_RHT_ROUTER, "0xb53c37baa373c22b85fd3bb27fa71b8091abd316"),
    feeRouter: addr(process.env.NEXT_PUBLIC_RHT_FEE_ROUTER, "0xe7ab694edcf1c91c34be23baf493d45e83f752d9"),
    referralRegistry: addr(process.env.NEXT_PUBLIC_RHT_REFERRAL_REGISTRY, "0x0aa4dfb57deb37ada6de375da06aba5dc2099a9c"),
    lockedLP: addr(process.env.NEXT_PUBLIC_RHT_LOCKED_LP, "0x6edb30bce65f87aeb750822de0de36b1cabd3d9a"),
    quotePricer: addr(process.env.NEXT_PUBLIC_RHT_QUOTE_PRICER, "0xe173a0f0b8d44a7686fbd32958d65375ff77314f"),
    quoteProbe: addr(process.env.NEXT_PUBLIC_RHT_QUOTE_PROBE, "0x4d6e5131d197318da7aeb502659486eb00bf4c1f"),
    migration: addr(process.env.NEXT_PUBLIC_RHT_MIGRATION, "0x37f20243c2cb78613fcfbd58607ce9905cf423b0"),
    antiSnipe: addr(process.env.NEXT_PUBLIC_RHT_ANTI_SNIPE, "0xe21904fc33220a81e23a5f0cd3fdeba6a644f45e"),
    trampWallManager: addr(process.env.NEXT_PUBLIC_RHT_TRAMP_WALL_MANAGER, "0x9c9693c44b5c09d318c95ba351ca4f70965c6cde"),
    marketLens: addr(process.env.NEXT_PUBLIC_RHT_MARKET_LENS, "0x3afe8b96fba7c47790d6d195f0070edd560165ae"),
    loginGate: addr(process.env.NEXT_PUBLIC_RHT_LOGIN_GATE, "0xe900b7060895f130e866eeddec2b3efd3ff0b69f"),
    usdgDepositNotifier: addr(process.env.NEXT_PUBLIC_RHT_USDG_DEPOSIT_NOTIFIER, "0xaf5d4a15ee996140e83179952f0a0cf46c93f6d9"),
    ...RH_V4,
    defaultQuote: addr(process.env.NEXT_PUBLIC_RHT_DEFAULT_QUOTE, "0xd4d0eB01960AACE441bFcb323Bfaf7c3d8b555a3"), // test STRATEGY (18 dec; reused from v1)
    usdg: addr(process.env.NEXT_PUBLIC_RHT_USDG, "0x25030Bff74764aD72b912276a603717DB1C00644"), // mUSDG (18 dec on testnet)
    usdgDecimals: decimalsEnv(process.env.NEXT_PUBLIC_RHT_USDG_DECIMALS, 18),
    fromBlock: BigInt(process.env.NEXT_PUBLIC_RHT_FROM_BLOCK || "137540728"),
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
    loginGate: addr(process.env.NEXT_PUBLIC_ANVIL_LOGIN_GATE),
    usdgDepositNotifier: addr(process.env.NEXT_PUBLIC_ANVIL_USDG_DEPOSIT_NOTIFIER),
    poolManager: addr(process.env.NEXT_PUBLIC_ANVIL_POOL_MANAGER),
    v4Quoter: Z, stateView: Z, universalRouter: Z, permit2: RH_V4.permit2,
    defaultQuote: addr(process.env.NEXT_PUBLIC_ANVIL_DEFAULT_QUOTE),
    usdg: addr(process.env.NEXT_PUBLIC_ANVIL_USDG),
    usdgDecimals: decimalsEnv(process.env.NEXT_PUBLIC_ANVIL_USDG_DECIMALS, 18),
    fromBlock: BigInt(0),
  },
};

/** Smoke-test coins on the current testnet deploy (rh-testnet-46630.json → smoke, v4). */
export const TESTNET_COINS = {
  /**
   * v3 smoke coin (graduated, but on the SUPERSEDED v3 hook/router — v4 has no graduated coin yet; the v4 router can't
   * trade it). Kept only for the v3-era e2e scripts. Do not send new launches to old stacks (SEC-01).
   */
  graduated: "0xcac8A9654dE3aE01470fC9E93e58fb97d5B86bb3" as Address,
  /** v4 smoke launches (Constants.MODE_*: 0 TRENCH, 1 PVE, 2 PVP). */
  trench: "0xf3499d126dd959080f6acd7ada17d39d256de996" as Address,
  pve: "0x5c37d290f4c05de9b5081a5f25ba434eba1c6375" as Address,
  pvp: "0x49eef46b243dee5a6345299cbfc7a223d6c0b781" as Address,
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
