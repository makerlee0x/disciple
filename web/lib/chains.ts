/**
 * Per-chain DISCIPLE deployment addresses. Values come from env (NEXT_PUBLIC_*) with
 * zero-address placeholders until DISCIPLE FLOW deploys. Local anvil = 31337.
 */
import { defineChain, type Address } from "viem";
import { CHAIN, STRATEGY_TOKEN } from "./config";

const Z = "0x0000000000000000000000000000000000000000" as Address;
const env = (v: string | undefined) => ((v && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : Z) as Address);

export const robinhood = defineChain({
  id: CHAIN.id,
  name: CHAIN.name,
  nativeCurrency: CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_RH_RPC_URL || CHAIN.rpcUrl] } },
});

export const anvil = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_ANVIL_RPC_URL || "http://127.0.0.1:8545"] } },
});

export interface Deployment {
  launchpad: Address;
  hook: Address;
  poolManager: Address;
  feeRouter: Address;
  /** Expected factory defaultQuote (display hint; the contract value wins). */
  defaultQuote: Address;
  /** First block to scan for events. */
  fromBlock: bigint;
}

// NOTE: NEXT_PUBLIC_* must be referenced literally for Next.js to inline them.
export const DEPLOYMENTS: Record<number, Deployment> = {
  [robinhood.id]: {
    launchpad: env(process.env.NEXT_PUBLIC_RH_LAUNCHPAD),
    hook: env(process.env.NEXT_PUBLIC_RH_HOOK),
    poolManager: env(process.env.NEXT_PUBLIC_RH_POOL_MANAGER),
    feeRouter: env(process.env.NEXT_PUBLIC_RH_FEE_ROUTER),
    defaultQuote: STRATEGY_TOKEN.address,
    fromBlock: BigInt(process.env.NEXT_PUBLIC_RH_FROM_BLOCK || "0"),
  },
  [anvil.id]: {
    launchpad: env(process.env.NEXT_PUBLIC_ANVIL_LAUNCHPAD),
    hook: env(process.env.NEXT_PUBLIC_ANVIL_HOOK),
    poolManager: env(process.env.NEXT_PUBLIC_ANVIL_POOL_MANAGER),
    feeRouter: env(process.env.NEXT_PUBLIC_ANVIL_FEE_ROUTER),
    defaultQuote: env(process.env.NEXT_PUBLIC_ANVIL_DEFAULT_QUOTE),
    fromBlock: BigInt(0),
  },
};

export const ACTIVE_CHAIN = Number(process.env.NEXT_PUBLIC_CHAIN_ID || robinhood.id) === anvil.id ? anvil : robinhood;
export const deployment = () => DEPLOYMENTS[ACTIVE_CHAIN.id];
export const isDeployed = () => deployment().launchpad !== Z;

/**
 * Custody model (DISCIPLE FLOW): user approves once at deposit; the platform executor
 * submits trades (no per-trade signing). NEXT_PUBLIC_DIRECT_WALLET=1 = dev-only path
 * where the connected wallet signs each tx itself.
 */
export const DIRECT_WALLET = process.env.NEXT_PUBLIC_DIRECT_WALLET === "1";
