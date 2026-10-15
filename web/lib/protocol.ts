/**
 * Typed protocol interface for DISCIPLE FLOW (contracts workstream).
 * Stubs only — do not call in production until wired to deployed contracts.
 */

import { CHAIN, CURVE } from "./config";

export type Address = `0x${string}`;

export interface LaunchCoinParams {
  name: string;
  ticker: string;
  imageUri: string;
  quoteToken: Address;
  creatorTaxPct: number; // 0–7, immutable at launch
  description?: string;
  socials?: { twitter?: string; telegram?: string; website?: string };
  creatorBuyPct?: number; // max 0.77% of supply
}

export interface LaunchCoinResult {
  token: Address;
  curve: Address;
  txHash: string;
}

export interface TradeParams {
  token: Address;
  side: "buy" | "sell";
  amountIn: bigint;
  minAmountOut: bigint;
  deadline: number;
}

export interface TradeResult {
  ok: boolean;
  txHash: string;
  amountOut?: bigint;
  reason?: string;
}

export interface CurveState {
  token: Address;
  quote: Address;
  mcapUsd: number;
  priceUsd: number;
  soldPct: number;
  graduated: boolean;
  reserveQuote: bigint;
  reserveToken: bigint;
  startMcap: number;
  graduationMcap: number;
}

export interface ProtocolClient {
  /** Permissionless launch (CREATE, no vanity). */
  launchCoin(params: LaunchCoinParams): Promise<LaunchCoinResult>;
  /** Buy on bonding curve or post-grad v4 pool. */
  buy(params: TradeParams): Promise<TradeResult>;
  /** Sell on bonding curve or post-grad v4 pool. */
  sell(params: TradeParams): Promise<TradeResult>;
  /** Read live curve / pool state. */
  getCurveState(token: Address): Promise<CurveState>;
  /** Estimate price impact % for a notional USD trade (nuke tier seam). */
  impactPct(token: Address, side: "buy" | "sell", usd: number): Promise<number>;
}

/** Stub client — throws until DISCIPLE FLOW wires real implementations. */
export const protocolStub: ProtocolClient = {
  async launchCoin() {
    throw new Error("TODO: wire launchCoin to contracts (DISCIPLE FLOW)");
  },
  async buy() {
    throw new Error("TODO: wire buy to contracts (DISCIPLE FLOW)");
  },
  async sell() {
    throw new Error("TODO: wire sell to contracts (DISCIPLE FLOW)");
  },
  async getCurveState() {
    throw new Error("TODO: wire getCurveState to contracts (DISCIPLE FLOW)");
  },
  async impactPct() {
    throw new Error("TODO: wire impactPct to contracts (DISCIPLE FLOW)");
  },
};

export const PROTOCOL_META = {
  chainId: CHAIN.id,
  curve: CURVE,
  note: "Stubs only. Deposit = one USDG approval; no per-trade signing. Gas not sponsored.",
} as const;
