import "server-only";
/**
 * Lighter settings, from env. Lighter is the backup venue for Turbo while Nova's SDK is pending (maker 2026-11-17).
 *
 *   LIGHTER_NETWORK          testnet (default) | mainnet | rh-mainnet | rh-testnet (Lighter on Robinhood Chain)
 *   LIGHTER_INTEGRATOR_INDEX Disciple's own Lighter account index; partner fees land there. Unset = no partner fee.
 *   LIGHTER_PARTNER_FEE_BP   Disciple's fee per side in bp (default 0.05, so 1.1 bp round trip on Plus; maker locked 1.1)
 *   LIGHTER_API_KEY_INDEX    the key slot Disciple uses on each player's account (default 7; 0–3 are Lighter's own apps)
 *   LIGHTER_KEY_SECRET       encrypts players' Lighter trading keys at rest (required)
 *   LIGHTER_TIER             account tier the player is moved to (default "plus"; confirm the exact name with Lighter)
 *   LIGHTER_SLIPPAGE         market order price cap as a fraction (default 0.005 = 0.5%)
 *   LIGHTER_ENABLED          "1" turns the /api/lighter route on
 */
import { bpToFeeUnits } from "@/lib/lighter/math";

export type LighterNetwork = "testnet" | "mainnet" | "rh-mainnet" | "rh-testnet";
/** payoutIsCash: a fast withdrawal pays USDG on Robinhood Chain, so Turbo cash can go straight back to Cash.
 *  Lighter on Robinhood Chain is a separate exchange (own accounts, keys, nonces); same API and tx format. */
/** depositChainId: the Robinhood Chain id whose USDG this exchange takes (4663 mainnet, 46630 testnet). */
const NETS: Record<LighterNetwork, { url: string; chainId: number; collateral: string; payoutIsCash: boolean; depositChainId?: number }> = {
  mainnet: { url: "https://mainnet.zklighter.elliot.ai", chainId: 304, collateral: "USDC", payoutIsCash: false },
  "rh-mainnet": { url: "https://api.rh.lighter.xyz", chainId: 466324, collateral: "USDG", payoutIsCash: true, depositChainId: 4663 },
  "rh-testnet": { url: "https://api.rh-testnet.lighter.xyz", chainId: 300, collateral: "USDG", payoutIsCash: true, depositChainId: 46630 },
  // the testnet app (testnet.app.lighter.xyz) talks to api.testnet.lighter.xyz; the docs' testnet.zklighter host doesn't know its accounts (2026-11-17)
  testnet: { url: "https://api.testnet.lighter.xyz", chainId: 300, collateral: "USDC", payoutIsCash: false },
};

export function lighterConfig() {
  const want = process.env.LIGHTER_NETWORK as LighterNetwork | undefined;
  const network: LighterNetwork = want && want in NETS ? want : "testnet";
  const integratorRaw = process.env.LIGHTER_INTEGRATOR_INDEX;
  const integratorIndex = integratorRaw && /^\d+$/.test(integratorRaw) ? Number(integratorRaw) : 0;
  const feeBp = Number(process.env.LIGHTER_PARTNER_FEE_BP ?? "0.05");
  return {
    enabled: process.env.LIGHTER_ENABLED === "1",
    network,
    ...NETS[network],
    ...(process.env.LIGHTER_API_URL ? { url: process.env.LIGHTER_API_URL.replace(/\/$/, "") } : {}),
    integratorIndex,
    /** partner fee per side, Lighter units (100 = 1 bp). 0 when no integrator account is set. */
    partnerFee: integratorIndex && Number.isFinite(feeBp) && feeBp > 0 ? bpToFeeUnits(feeBp) : 0,
    apiKeyIndex: Number(process.env.LIGHTER_API_KEY_INDEX ?? "7"),
    tier: process.env.LIGHTER_TIER || "plus",
    slippage: Number(process.env.LIGHTER_SLIPPAGE ?? "0.005"),
    keySecret: process.env.LIGHTER_KEY_SECRET || "",
  };
}
export type LighterConfig = ReturnType<typeof lighterConfig>;

/** Turbo markets → Lighter symbols, with the leverage the duel uses (Lighter's max per market). */
export const LIGHTER_MARKETS = {
  BTC: { symbol: "BTC", lev: 50 },
  ETH: { symbol: "ETH", lev: 50 },
  SOL: { symbol: "SOL", lev: 25 },
  HYPE: { symbol: "HYPE", lev: 20 },
} as const;
export type LighterMarket = keyof typeof LIGHTER_MARKETS;
export const isLighterMarket = (m: unknown): m is LighterMarket => typeof m === "string" && m in LIGHTER_MARKETS;
