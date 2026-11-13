/**
 * TURBO adapter contract (SITE ↔ GAME). The live Turbo screens talk ONLY to this interface; SITE swaps the implementation
 * behind `getTurboAdapter()` (lib/turbo/index.ts). Until Nova hands over an API or SDK, the only implementation is the
 * stand-in (mockAdapter.ts, kind "practice"), which stands in for prices and fills only. A Nova adapter (kind "nova-api"
 * or "nova-sdk") must keep these shapes so the screens never change.
 *
 * Units: every amount is US dollars (number), prices are $ per coin, `ts` is ms since epoch, leverage is a plain
 * multiplier (500 = 500×). Core members match GAME's spec exactly; members marked "SITE extra" are additive.
 */

export type Market = "BTC" | "ETH";
export type Side = "long" | "short";

/** pending = sent, waiting for a fill (the real venue fills a few seconds later); open = filled and live. */
export type PositionStatus = "pending" | "open" | "closed" | "liquidated" | "failed";

export type PriceTick = { price: number; ts: number };
export type ClosePct = 25 | 50 | 100;

/** A completed market print (buy or sell) for flight boosts / bombs. Not a bid/ask. */
export interface MarketTrade {
  market: Market;
  side: "buy" | "sell";
  /** Notional in dollars. */
  usd: number;
  /** Fill price ($ per coin). */
  price: number;
  /** Optional size in coin units. */
  size?: number;
  ts: number;
  id?: string;
  /** Previous print / mid, when known — the engine uses pre/post for impact %. */
  prePrice?: number;
}

/** Stand-in or Nova trade stream. start() returns stop(). */
export interface TradeFeed {
  start(onTrade: (t: MarketTrade) => void): () => void;
}

/** Stand-in or Nova mid stream. start() returns stop(). */
export interface PriceFeed {
  start(onPrice: (m: Market, price: number) => void): () => void;
}


export interface Position {
  id: string;
  market: Market;
  side: Side;
  /** Fuel still at work in the position ($). Shrinks on a partial close. */
  collateralUsd: number;
  leverage: number;
  /** Notional = collateralUsd × leverage ($). */
  sizeUsd: number;
  /** Fill price. For a pending position this is the estimate from quote(). */
  entry: number;
  /** Price at which the position is liquidated. INCLUDES fees (open fee paid, close fee, funding so far). */
  liqPrice: number;
  /** Funding so far: negative = paid, positive = received ($). */
  fundingUsd: number;
  /** Open fee charged on notional at fill ($), for the size still open. */
  openFeeUsd: number;
  /** Estimated close fee on the current notional at the current price ($). */
  closeFeeUsdEst: number;
  /** PnL from the price move only ($). */
  pnlUsd: number;
  /** The big number (mark-to-market): pnlUsd − openFeeUsd + fundingUsd ($). Paid fees only; does not subtract the estimated closing fee. */
  pnlAfterFeesUsd: number;
  status: PositionStatus;
  /** SITE extra: last mark price used for the PnL numbers. */
  markPrice?: number;
  /** SITE extra: ms since epoch when the position was opened (filled, or sent if still pending). */
  openedAt?: number;
  /** SITE extra: $ realized so far by partial closes (after their fees and funding). */
  realizedUsd?: number;
}

/**
 * Why a position closed / failed. Turbo is market-only (lee, Nov 12 9:42 AM CT): no take-profit, stop-loss or limit orders.
 * Other strings may appear (e.g. a real venue's error code) — treat unknown reasons as plain text, never show them raw.
 */
export type TurboEventReason =
  | "manual"
  | "liquidation"
  | "timeout"
  | "slippage"
  | "market-full"
  | "not-enough-fuel"
  | "invalid"
  | (string & {});

export type TurboEventType = "pending" | "filled" | "partial-closed" | "closed" | "liquidated" | "failed";

export interface TurboEvent {
  type: TurboEventType;
  position: Position;
  reason?: TurboEventReason;
  /** SITE extra: $ returned to fuel by this event (partial-closed / closed). 0 on liquidation. */
  returnedUsd?: number;
  /** SITE extra: % closed for partial-closed / closed events. */
  pct?: ClosePct;
}

export interface OpenParams {
  market: Market;
  side: Side;
  collateralUsd: number;
  leverage: number;
}

export interface QuoteParams {
  market: Market;
  side: Side;
  collateralUsd: number;
  leverage: number;
}

export interface Quote {
  sizeUsd: number;
  entryEst: number;
  /** Includes the open fee and the close fee. */
  liqPrice: number;
  openFeeUsd: number;
  closeFeeUsd: number;
}

/** SITE extra: what getMarkets() returns. */
export interface MarketInfo {
  market: Market;
  maxLeverage: number;
  /** SITE extra fields (optional so a real adapter can omit them). */
  minLeverage?: number;
  /** Fee per side, in basis points of notional. */
  feeBps?: number;
  /** Funding rate per hour as a fraction of notional (+ = longs pay shorts). */
  fundingRatePerHour?: number;
  /** true when prices are practice/mock prices. The UI MUST label them as practice when true. */
  /** True while the stand-in adapter is answering (no Nova connection yet). */
  standIn?: boolean;
  /** Plain reason a leverage above maxLeverage can't open on this market (e.g. "Max 40× on BTC right now"). */
  leverageNote?: string;
  /** Full trading parameters (lib/turbo/markets.ts), when the adapter knows them. */
  params?: import("./markets").MarketParams;
  /** $ notional open on this market right now, against params.oiCapUsd. */
  openInterestUsd?: number;
}

export type Unsub = () => void;

export interface TurboAdapter {
  /** Live price stream. Calls cb with the latest tick right away when one exists. */
  subscribePrice(m: Market, cb: (p: PriceTick) => void): Unsub;
  /** SITE extra: completed market buys/sells for flight boosts and bombs. Stand-in = Hyperliquid public trades; a Nova stream can replace it. */
  subscribeTrades?(m: Market, cb: (t: MarketTrade) => void): Unsub;

  /** Turbo fuel ($). Completely separate from game cash. */
  getFuel(): Promise<{ usd: number }>;
  onFuel(cb: (f: { usd: number }) => void): Unsub;

  /** Sends an order. Resolves with the id right away; the position is `pending` until a `filled` (or `failed`) event. */
  open(p: OpenParams): Promise<{ id: string }>;
  /** Close 25 / 50 / 100% of a position. 100 emits `closed`, otherwise `partial-closed`. */
  close(id: string, pct: ClosePct): Promise<void>;
  /** Pending and open positions. */
  getPositions(): Promise<Position[]>;
  onEvent(cb: (e: TurboEvent) => void): Unsub;
  /** Synchronous preview for the trade bar, from the latest price. */
  quote(p: QuoteParams): Quote;

  // ---- SITE extras (optional so GAME's code compiles against either shape) ----
  /** Stand-in: adds $ to Turbo fuel on this device. Nova adapter: not used (deposits arrive on-chain; see depositInfo). */
  addFuel?(usd: number): Promise<{ usd: number }>;
  /** Stand-in: removes $ from Turbo fuel. Nova adapter: starts a withdraw. */
  withdrawFuel?(usd: number): Promise<{ usd: number }>;
  getMarkets?(): MarketInfo[];
  /** Where Turbo fuel is deposited (Nova's funding sheet: USDC on Arbitrum). address null until Nova provides one. */
  depositInfo?(): DepositInfo;
  /** "practice" = the stand-in (prices and fills only); "nova-sdk" / "nova-api" = Nova's real adapter once handed over. */
  readonly kind?: TurboAdapterKind;
}

export type TurboAdapterKind = "practice" | "nova-sdk" | "nova-api";

/** Funding sheet facts (follows Nova's "Fund your Nova wallet" sheet). Never invent an address. */
export interface DepositInfo {
  token: "USDC";
  network: "Arbitrum";
  /** null until Nova's team hooks up deposits. */
  address: string | null;
}

/** Why an order was refused before it was sent. The screen turns each into a plain line next to the fire buttons. */
export type TurboErrorCode = "no-price" | "stale-price" | "no-fuel" | "min-size" | "market-full" | "leverage" | "bad-amount" | "unknown";
export class TurboError extends Error {
  constructor(public code: TurboErrorCode, message: string) { super(message); this.name = "TurboError"; }
}
