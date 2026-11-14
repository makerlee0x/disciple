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
  /** Gasless router (DiscipleRouter with buyWithPermit2/sellWithPermit2, flow/gasless-permit2). Zero ⇒ gasless off. */
  gaslessRouter: Address;
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
  /** LoginGate address the Launchpad writes into curves. v6 curves do not read it on buys (login is checked off-chain). */
  loginGate: Address;
  /** v4: USDG referral-gate escrow (ReferralRegistry.depositHook). */
  usdgDepositNotifier: Address;
  /**
   * lp-accrue CurveFeeVault (curve-phase creator / referral / treasury fees; contracts/src/CurveFeeVault.sol). Optional:
   * not deployed yet ⇒ zero (env only, no default). Per-coin reads use BondingCurve.feeVault() (lib/claims/vault.ts);
   * this address only scopes stack-wide reads (referral balances, fee history).
   */
  curveFeeVault: Address;
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
    gaslessRouter: addr(process.env.NEXT_PUBLIC_RH_GASLESS_ROUTER),
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
    curveFeeVault: addr(process.env.NEXT_PUBLIC_RH_CURVE_FEE_VAULT),
    ...RH_V4,
    defaultQuote: STRATEGY_TOKEN.address,
    usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    usdgDecimals: decimalsEnv(process.env.NEXT_PUBLIC_RH_USDG_DECIMALS, 6),
    paymaster: addr(process.env.NEXT_PUBLIC_RH_PAYMASTER), // PREPAY_VERSION=5 + stake checked server-side; no legacy default
    fromBlock: BigInt(process.env.NEXT_PUBLIC_RH_FROM_BLOCK || "0"),
  },
  // Testnet — source of truth: contracts/deployments/rh-testnet-46630.json (v6, deployed Nov 11–12; v6 startBlock
  // 152153375). fromBlock stays at the v5 start (142064001) so older private-launch announcements and claims are still
  // found. Gas is paid by the gasless relayer (no paymaster / session policy). Prod sets every NEXT_PUBLIC_RHT_* in Vercel env; these literals are the
  // fallbacks (and are inlined into the bundle), so they must match the live stack too.
  // After a redeploy, edit these defaults or set NEXT_PUBLIC_RHT_* env. Do NOT send new launches to the old v2 stack (SEC-01).
  [robinhoodTestnet.id]: {
    launchpad: addr(process.env.NEXT_PUBLIC_RHT_LAUNCHPAD, "0x7918167753b8ec0be07fb9e8c3061bc3516bd608"),
    hook: addr(process.env.NEXT_PUBLIC_RHT_HOOK, "0xff68befdf795a2fa574e4a891fa066f59533a8c4"),
    router: addr(process.env.NEXT_PUBLIC_RHT_ROUTER, "0xb8f4356759f7bc1351f2d36037ad69ed82b8d839"),
    gaslessRouter: addr(process.env.NEXT_PUBLIC_RHT_GASLESS_ROUTER, "0xb8f4356759f7bc1351f2d36037ad69ed82b8d839"), // v6 DiscipleRouter (also the Permit2-witness gasless router)
    feeRouter: addr(process.env.NEXT_PUBLIC_RHT_FEE_ROUTER, "0x7db57795ee2611881890b53f15f94fbd598bcf26"),
    referralRegistry: addr(process.env.NEXT_PUBLIC_RHT_REFERRAL_REGISTRY, "0x2c933d015815169900074e202c855276bbc0cc3a"),
    lockedLP: addr(process.env.NEXT_PUBLIC_RHT_LOCKED_LP, "0x9e8106897e96739388c4582adfa92cf31538125e"),
    quotePricer: addr(process.env.NEXT_PUBLIC_RHT_QUOTE_PRICER, "0x5dd0f529c215c610f9498f4dae0d7f36b49fd573"),
    quoteProbe: addr(process.env.NEXT_PUBLIC_RHT_QUOTE_PROBE, "0x551a88430144cd08a8f5fd4d7a2e630ca64b6381"),
    migration: addr(process.env.NEXT_PUBLIC_RHT_MIGRATION, "0x4bf424a07ccfd94825695ee1a82ccba827f2f600"),
    antiSnipe: addr(process.env.NEXT_PUBLIC_RHT_ANTI_SNIPE), // v5/v6 have no AntiSnipe contract (snipe escrow lives in the curve) ⇒ zero
    trampWallManager: addr(process.env.NEXT_PUBLIC_RHT_TRAMP_WALL_MANAGER, "0x3d851837f1835b95b387cba050a6a9dfe6bbbb06"),
    marketLens: addr(process.env.NEXT_PUBLIC_RHT_MARKET_LENS, "0x60f774706e0b275c47cca610d3e9123128baa880"),
    loginGate: addr(process.env.NEXT_PUBLIC_RHT_LOGIN_GATE, "0xd19e138851fb4de489a4de81531f813081a143a7"), // v6 LoginGate (stored in v6 curves; not read on buys)
    usdgDepositNotifier: addr(process.env.NEXT_PUBLIC_RHT_USDG_DEPOSIT_NOTIFIER, "0x8cfc1917699aaa0f87d6bbee3ad459c285fd46bf"),
    curveFeeVault: addr(process.env.NEXT_PUBLIC_RHT_CURVE_FEE_VAULT),
    ...RH_V4,
    defaultQuote: addr(process.env.NEXT_PUBLIC_RHT_DEFAULT_QUOTE, "0xF5eB226F7f0890c36A06Cbd0Ff843292b7b1a88C"), // test STRATEGY (18 dec, tokens.STRATEGY, reused by v6)
    usdg: addr(process.env.NEXT_PUBLIC_RHT_USDG, "0x9dC7A988a8707dC4AB7ac08fC2CB4D5bf906158D"), // test USDG (6 dec, tokens.USDG, reused by v6)
    usdgDecimals: decimalsEnv(process.env.NEXT_PUBLIC_RHT_USDG_DECIMALS, 6),
    paymaster: addr(process.env.NEXT_PUBLIC_RHT_PAYMASTER), // env only, no fallback (gas is paid by the gasless relayer)
    fromBlock: BigInt(process.env.NEXT_PUBLIC_RHT_FROM_BLOCK || "142064001"),
  },
  [anvil.id]: {
    launchpad: addr(process.env.NEXT_PUBLIC_ANVIL_LAUNCHPAD),
    hook: addr(process.env.NEXT_PUBLIC_ANVIL_HOOK),
    router: addr(process.env.NEXT_PUBLIC_ANVIL_ROUTER),
    gaslessRouter: addr(process.env.NEXT_PUBLIC_ANVIL_GASLESS_ROUTER),
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
    curveFeeVault: addr(process.env.NEXT_PUBLIC_ANVIL_CURVE_FEE_VAULT),
    poolManager: addr(process.env.NEXT_PUBLIC_ANVIL_POOL_MANAGER),
    v4Quoter: Z, stateView: Z, universalRouter: Z, permit2: RH_V4.permit2,
    defaultQuote: addr(process.env.NEXT_PUBLIC_ANVIL_DEFAULT_QUOTE),
    usdg: addr(process.env.NEXT_PUBLIC_ANVIL_USDG),
    usdgDecimals: decimalsEnv(process.env.NEXT_PUBLIC_ANVIL_USDG_DECIMALS, 18),
    paymaster: addr(process.env.NEXT_PUBLIC_ANVIL_PAYMASTER), // PREPAY_VERSION=5 + stake checked server-side; no legacy default
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
/**
 * Routers whose UsdgTrade / UsdgRefund the indexer and the live HUD watch. Same
 * address-filtered path historically used for `d.router`, plus `d.gaslessRouter`
 * (Permit2 gasless fills emit there, not on the regular USDG router). Zero / unset
 * addresses are omitted; order is regular router then gasless.
 */
export function usdgRouters(d: { router: string; gaslessRouter?: string } = deployment()): Address[] {
  const out: Address[] = [];
  const seen = new Set<string>();
  for (const a of [d.router, d.gaslessRouter]) {
    if (!a) continue;
    const k = a.toLowerCase();
    if (k === ZERO.toLowerCase() || seen.has(k)) continue;
    seen.add(k);
    out.push(a as Address);
  }
  return out;
}
/** Testnet gas faucet (ETH). */
export const GAS_FAUCET = "https://faucet.testnet.chain.robinhood.com/";
/** Test quote tokens with a public mint(address,uint256) — testnet only. */
export const MINTABLE_TEST_TOKENS = ACTIVE_CHAIN.id === 46630
  ? [
      { symbol: "STRATEGY", address: deployment().defaultQuote, amount: "1000000" },
      { symbol: "mUSDG", address: deployment().usdg, amount: "1000" },
    ]
  : [];
