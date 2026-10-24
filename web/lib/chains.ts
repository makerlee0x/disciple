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
  /** DisciplePaymaster (USDG token paymaster, EntryPoint v0.7). Zero ⇒ paymaster off, ops self-pay in ETH. */
  paymaster: Address;
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
    paymaster: Z, // mainnet: not deployed (testnet only for now)
    fromBlock: BigInt(process.env.NEXT_PUBLIC_RH_FROM_BLOCK || "0"),
  },
  // Testnet — source of truth: contracts/deployments/rh-testnet-46630.json on main (v5 redeploy, PR #150 / deploy commit 4310665b,
  // startBlock 142064001). Prod sets every NEXT_PUBLIC_RHT_* in Vercel env; these literals are the fallbacks (and are inlined
  // into the bundle), so they must match the live stack too.
  // After a redeploy, edit these defaults or set NEXT_PUBLIC_RHT_* env. Do NOT send new launches to the old v2 stack (SEC-01).
  [robinhoodTestnet.id]: {
    launchpad: addr(process.env.NEXT_PUBLIC_RHT_LAUNCHPAD, "0x8a92e51940909424b3aacefff99b4834588c0988"),
    hook: addr(process.env.NEXT_PUBLIC_RHT_HOOK, "0x2ac264a620edd05ba78381c51539650c40e2e8c4"),
    router: addr(process.env.NEXT_PUBLIC_RHT_ROUTER, "0x688160633b22012717661545df6299d3d3174ad2"),
    feeRouter: addr(process.env.NEXT_PUBLIC_RHT_FEE_ROUTER, "0xa5aaddd75f1bc3b8fb3ecc8845eab0cfa5faed8c"),
    referralRegistry: addr(process.env.NEXT_PUBLIC_RHT_REFERRAL_REGISTRY, "0xfe529086b25c4e0724b88780e5ba9b4ace785aaf"),
    lockedLP: addr(process.env.NEXT_PUBLIC_RHT_LOCKED_LP, "0x61efff9f0dbdd818317858074bcf80e4dcc39646"),
    quotePricer: addr(process.env.NEXT_PUBLIC_RHT_QUOTE_PRICER, "0xbb757b8270a3fff15db2ff7694508a4ea4488078"),
    quoteProbe: addr(process.env.NEXT_PUBLIC_RHT_QUOTE_PROBE, "0xf7a91d5d32cccb053dfbd8a56ddacc6fab7a96c9"),
    migration: addr(process.env.NEXT_PUBLIC_RHT_MIGRATION, "0x32790b0a28871984300f3bc75e1b3a8ea7b8bb1a"),
    antiSnipe: addr(process.env.NEXT_PUBLIC_RHT_ANTI_SNIPE), // v5 has no AntiSnipe contract (snipe escrow lives in the curve) ⇒ zero
    trampWallManager: addr(process.env.NEXT_PUBLIC_RHT_TRAMP_WALL_MANAGER, "0xe9e98e149b43ff20dc7db665eefc387a8926e618"),
    marketLens: addr(process.env.NEXT_PUBLIC_RHT_MARKET_LENS, "0xd89da17e3aee9a7b1cba359666f0feb5382421fa"),
    loginGate: addr(process.env.NEXT_PUBLIC_RHT_LOGIN_GATE, "0xaeb8abd314d2392f0f26b664ae78d889c4a079e2"),
    usdgDepositNotifier: addr(process.env.NEXT_PUBLIC_RHT_USDG_DEPOSIT_NOTIFIER, "0xf7b3c09cae8c914530424c5882a24a4160013e9c"),
    ...RH_V4,
    defaultQuote: addr(process.env.NEXT_PUBLIC_RHT_DEFAULT_QUOTE, "0xF5eB226F7f0890c36A06Cbd0Ff843292b7b1a88C"), // test STRATEGY (18 dec, v5 tokens.STRATEGY)
    usdg: addr(process.env.NEXT_PUBLIC_RHT_USDG, "0x9dC7A988a8707dC4AB7ac08fC2CB4D5bf906158D"), // test USDG (6 dec, v5 tokens.USDG)
    usdgDecimals: decimalsEnv(process.env.NEXT_PUBLIC_RHT_USDG_DECIMALS, 6),
    paymaster: addr(process.env.NEXT_PUBLIC_RHT_PAYMASTER, "0xB3DB53C1E94F146194756FF456479ea0577E7d7E"), // DisciplePaymaster (v5 addons; charges the user's USDG)
    fromBlock: BigInt(process.env.NEXT_PUBLIC_RHT_FROM_BLOCK || "142064001"),
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
    paymaster: addr(process.env.NEXT_PUBLIC_ANVIL_PAYMASTER),
    fromBlock: BigInt(0),
  },
};

/** Smoke-test coins on the testnet (rh-testnet-46630.json → smoke). graduated = v5; trench/pve/pvp are v4-stack coins. */
export const TESTNET_COINS = {
  /** v5 smoke coin (graduated in the v5 deploy smoke, rh-testnet-46630.json smoke.token; tradeable on the v5 router). */
  graduated: "0xc7E64e22c58c16926f99D0c12A31187364B369F5" as Address,
  /** v4 smoke launches on the SUPERSEDED v4 stack (Constants.MODE_*: 0 TRENCH, 1 PVE, 2 PVP); v4-era scripts only. */
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
