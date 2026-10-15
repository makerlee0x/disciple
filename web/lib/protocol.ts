/**
 * Typed protocol interface for DISCIPLE FLOW (contracts workstream).
 * Stubs only — do not call in production until wired to deployed contracts.
 */

import { CHAIN, CURVE, STRATEGY_TOKEN } from "./config";

export type Address = `0x${string}`;

export interface LaunchCoinParams {
  name: string;
  ticker: string;
  /** Metadata URI. Contracts store only this; the image MUST pass /api/moderate-image first. */
  imageUri: string;
  /**
   * ERC-20 quote. address(0) → factory `defaultQuote` (STRATEGY today; owner-settable
   * on-chain, so never assume). Advanced mode passes a custom ERC-20.
   */
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
  /** Subscribe to Launch / Trade / Graduate events. Returns unsubscribe. */
  onEvent?(cb: (e: ProtocolEvent) => void): () => void;
  /**
   * Player position for a coin (vault/indexer later; paper ledger in lib/pnl.ts now).
   * costBasis includes the 1% fee and gas; realized is net $ on sells (average cost).
   */
  getPosition?(user: Address, coin: Address): Promise<{ size: bigint; costBasisUsd: number; realizedUsd: number }>;
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

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** Passing address(0) lets the factory pick its owner-settable defaultQuote. */
export const DEFAULT_QUOTE: Address = ZERO_ADDRESS;

/** What the factory's defaultQuote is expected to be today (display/indexer hint only). */
export const EXPECTED_DEFAULT_QUOTE: Address = STRATEGY_TOKEN.address;

/** Off-chain coin metadata (indexer / UI). Verified tiers + moderation live here, NOT on-chain. */
export interface CoinMetadata {
  token: Address;
  name: string;
  ticker: string;
  imageUri: string;
  image: {
    sha256: string;
    phash: string;
    moderation: "allow" | "block" | "review";
    provider: string;
    checkedAt: string;
  };
  /** Off-chain verified level (see VERIFIED_TIERS in config.ts). */
  verifiedLevel?: "UNVERIFIED" | "BLESSED" | "ANOINTED" | "GLORIFIED";
  /** Set by indexer if the image is flagged post-launch → UI must hide the coin. */
  hidden?: boolean;
}

/* ---- Contract events (DISCIPLE FLOW) ---- */
export interface LaunchEvent {
  type: "Launch";
  token: Address;
  curve: Address;
  creator: Address;
  quote: Address;
  creatorTaxBps: number;
  metadataUri: string;
}
export interface TradeEvent {
  type: "Trade";
  token: Address;
  trader: Address;
  side: "buy" | "sell";
  amountIn: bigint;
  amountOut: bigint;
  /** Price impact (bps) emitted by the contract — drives bomb tiers. */
  impactBps: number;
}
export interface GraduateEvent {
  type: "Graduate";
  token: Address;
  pool: Address; // Uniswap v4 pool id/address
}
export type ProtocolEvent = LaunchEvent | TradeEvent | GraduateEvent;

/**
 * Fees: the Uniswap v4 pool itself has fee = 0; the 1% trade fee (CURVE.tradeFeeBps)
 * is taken by the DISCIPLE hook only.
 */
export const V4_POOL_FEE = 0;

export const PROTOCOL_META = {
  chainId: CHAIN.id,
  curve: CURVE,
  hookFeeBps: CURVE.tradeFeeBps,
  v4PoolFee: V4_POOL_FEE,
  note: "Stubs only. Verified tiers are off-chain (indexer/UI). Deposit = one USDG approval; no per-trade signing. Gas not sponsored.",
} as const;
