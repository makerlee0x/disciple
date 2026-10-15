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
    ...RH_V4,
    defaultQuote: STRATEGY_TOKEN.address,
    usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    fromBlock: BigInt(process.env.NEXT_PUBLIC_RH_FROM_BLOCK || "0"),
  },
  // Testnet — source of truth: contracts/deployments/rh-testnet-46630.json (FLOW redeploy 2026-10-15, flow/contracts-api 44d8525).
  // After a redeploy, edit these defaults or set NEXT_PUBLIC_RHT_* env.
  [robinhoodTestnet.id]: {
    launchpad: addr(process.env.NEXT_PUBLIC_RHT_LAUNCHPAD, "0x71c36E59be17710a15e7E8a6348467330fB93B24"),
    hook: addr(process.env.NEXT_PUBLIC_RHT_HOOK, "0xeB517C9F9171325E43048B25ECf63A42b1A640C4"),
    router: addr(process.env.NEXT_PUBLIC_RHT_ROUTER, "0xC83EEDbA3455F71d053c847e55d5742E549fcf44"),
    feeRouter: addr(process.env.NEXT_PUBLIC_RHT_FEE_ROUTER, "0x8A80e1c181bdddfeA432aB816ac16E65efDA57EF"),
    referralRegistry: addr(process.env.NEXT_PUBLIC_RHT_REFERRAL_REGISTRY, "0xceDA0CB8d7ABB9f3D962746B9148bB6B403F5425"),
    lockedLP: addr(process.env.NEXT_PUBLIC_RHT_LOCKED_LP, "0xDaa97b1F70a97B9656D899341DC24170325f8455"),
    quotePricer: addr(process.env.NEXT_PUBLIC_RHT_QUOTE_PRICER, "0x4297b9f559148b19773DaFb6DD173A793EcaB54F"),
    quoteProbe: addr(process.env.NEXT_PUBLIC_RHT_QUOTE_PROBE, "0xCbc584333C4eC81c00acc81b2Ef09F8394E51015"),
    migration: addr(process.env.NEXT_PUBLIC_RHT_MIGRATION, "0xBc33E74c576b90Ef93526bd45155fC429F79647b"),
    antiSnipe: addr(process.env.NEXT_PUBLIC_RHT_ANTI_SNIPE, "0x0F47b2FB55004ac12ced8e2Caa1fD5829f93321a"),
    ...RH_V4,
    defaultQuote: addr(process.env.NEXT_PUBLIC_RHT_DEFAULT_QUOTE, "0xd4d0eB01960AACE441bFcb323Bfaf7c3d8b555a3"), // test STRATEGY (18 dec)
    usdg: addr(process.env.NEXT_PUBLIC_RHT_USDG, "0x25030Bff74764aD72b912276a603717DB1C00644"), // mUSDG (18 dec on testnet)
    fromBlock: BigInt(process.env.NEXT_PUBLIC_RHT_FROM_BLOCK || "136090192"),
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
    poolManager: addr(process.env.NEXT_PUBLIC_ANVIL_POOL_MANAGER),
    v4Quoter: Z, stateView: Z, universalRouter: Z, permit2: RH_V4.permit2,
    defaultQuote: addr(process.env.NEXT_PUBLIC_ANVIL_DEFAULT_QUOTE),
    usdg: addr(process.env.NEXT_PUBLIC_ANVIL_USDG),
    fromBlock: BigInt(0),
  },
};

/** Smoke-test coins on the current testnet deploy (rh-testnet-46630.json → smoke). */
export const TESTNET_COINS = {
  /** default-quote (test STRATEGY) coin, live on the curve */
  liveCurve: "0x7b154cf513f4c3bbc0f880b6bb92ff864e4b5b57" as Address,
  /** mUSDG coin, graduated to v4 (pool 0x8f2d43d3…5350) */
  graduated: "0x59f3a103f665a5dd3427cc26f8a749bcf3eb38e0" as Address,
};

const CHAINS = { [robinhood.id]: robinhood, [robinhoodTestnet.id]: robinhoodTestnet, [anvil.id]: anvil } as const;
const WANT = Number(process.env.NEXT_PUBLIC_CHAIN_ID || robinhoodTestnet.id);
export const ACTIVE_CHAIN = CHAINS[WANT as keyof typeof CHAINS] ?? robinhoodTestnet;
export const deployment = () => DEPLOYMENTS[ACTIVE_CHAIN.id];
export const isDeployed = () => deployment().launchpad !== Z;
export const hasRouter = () => deployment().router !== Z;
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
