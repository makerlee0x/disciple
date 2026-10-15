/**
 * Typed protocol interface for DISCIPLE FLOW (contracts workstream).
 * Implemented by lib/protocol-viem.ts against PR #4's API (flow/contracts-api); protocolStub for no-chain mode.
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
  creatorBuyPct?: number; // max 0.77% of supply (UI hint)
  /** Optional same-tx creator buy, in quote raw units (decimals per quote token). */
  creatorBuyQuoteIn?: bigint;
  // quotePriceUsd was REMOVED in PR #4: Launchpad prices the quote on-chain via QuotePricer.
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
  /** 0 = derive from an off-chain quote + slippageBps. */
  minAmountOut: bigint;
  /** unix seconds; 0 = now + 120s */
  deadline: number;
  slippageBps?: number;
  /** Who receives the output. Defaults to the signing (Privy embedded) wallet. */
  recipient?: Address;
}

/** Pre-trade preview from on-chain views (curve quoteBuy/quoteSell, or router quoteExactIn post-grad). */
export interface TradeQuote {
  side: "buy" | "sell";
  amountIn: bigint;
  amountOut: bigint;
  /** protocol 1% + creator tax, quote raw (curve only; post-grad it is folded into amountOut). */
  fee: bigint;
  snipeFee: bigint;
  impactBps: number;
  impactPct: number;
  mcapAfterUsd: number;
  graduates: boolean;
  venue: "curve" | "router";
  quoteDecimals: number;
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
  /** % of TOTAL supply sold (graduates at 72). */
  soldPct: number;
  /** 0–100 progress toward the 72% graduation point. */
  curveProgressPct: number;
  nextTier: { name: string; mcapUsd: number } | null;
  tokensSold: bigint;
  creatorTaxBps: number;
  graduated: boolean;
  /** 0–10000 from curve.progressBps() (10000 once graduated). */
  progressBps?: number;
  /** Current anti-snipe fee bps (0 after the window). */
  snipeFeeBps?: number;
  quoteDecimals?: number;
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
  /** Exact preview for the current block (fees, tax, anti-snipe). */
  quote?(token: Address, side: "buy" | "sell", amountIn: bigint): Promise<TradeQuote>;
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
  async quote() {
    throw new Error("No chain configured (mock mode).");
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
/** Launchpad.Launched */
export interface LaunchEvent {
  type: "Launch";
  token: Address;
  curve: Address;
  creator: Address;
  quote: Address;
  creatorTaxBps: number;
  name: string;
  ticker: string;
  block: bigint;
}
/** Launchpad.LaunchTierContext */
export interface LaunchTierContextEvent {
  type: "LaunchTierContext";
  token: Address;
  startMcapUsd: number;
  graduationMcapUsd: number;
  totalSupply: bigint;
  decimals: number;
}
/** Launchpad.CreatorTransferred */
export interface CreatorTransferredEvent {
  type: "CreatorTransferred";
  token: Address;
  previousCreator: Address;
  newCreator: Address;
}
export interface TradeEvent {
  type: "Trade";
  token: Address;
  trader: Address;
  side: "buy" | "sell";
  amountIn: bigint;
  amountOut: bigint;
  /** Raw Trade fields (quote raw units in quote decimals; token raw in 18). */
  quoteAmt?: bigint;
  tokenAmt?: bigint;
  fee?: bigint;
  snipeFee?: bigint;
  /** "curve" pre-grad, "hook" post-grad v4 swap. */
  venue?: "curve" | "hook";
  /** USD notional (quote × quotePriceUsd fixed at launch). */
  usd: number;
  /** On-chain Trade.impactBps (signed by side: +buy, -sell). */
  impactBps?: number;
  /** impactBps / 100, signed. Drives bomb tiers. */
  impactPct: number;
  /** Trade.mcapAfterUsd (USD). Drives the chart. */
  mcapUsd: number;
  txHash: string;
  block: bigint;
}
export interface GraduateEvent {
  type: "Graduate";
  token: Address;
  poolId: `0x${string}`; // BondingCurve.GraduatedToV4 poolId
}
export type ProtocolEvent = LaunchEvent | LaunchTierContextEvent | CreatorTransferredEvent | TradeEvent | GraduateEvent;

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
  note: "No custody: the Privy embedded wallet signs each trade; approve curve/router once (max). Verified tiers are off-chain. Gas not sponsored.",
} as const;
