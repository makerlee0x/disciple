/**
 * TURBO adapter contract (SITE ↔ GAME). GAME's screens talk ONLY to this interface; SITE swaps the implementation
 * behind `getTurboAdapter()` (lib/turbo/index.ts). Today the only implementation is a practice/mock adapter: no real
 * money, no wallet, no network calls. A real nova adapter (SDK or REST/WebSocket API, TBD) must keep these shapes.
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
  /** The big number: pnlUsd − openFeeUsd − closeFeeUsdEst + fundingUsd ($). */
  pnlAfterFeesUsd: number;
  tpPrice?: number;
  slPrice?: number;
  status: PositionStatus;
  /** SITE extra: last mark price used for the PnL numbers. */
  markPrice?: number;
  /** SITE extra: ms since epoch when the position was opened (filled, or sent if still pending). */
  openedAt?: number;
  /** SITE extra: $ realized so far by partial closes (after their fees and funding). */
  realizedUsd?: number;
}

/**
 * Why a position closed / failed. 'tp' and 'sl' are SITE extras on `closed` events (GAME asked for them).
 * Other strings may appear (e.g. a real venue's error code) — treat unknown reasons as plain text, never show them raw.
 */
export type TurboEventReason =
  | "manual"
  | "tp"
  | "sl"
  | "liquidation"
  | "timeout"
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
  tpPrice?: number;
  slPrice?: number;
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
  practice?: boolean;
}

export type Unsub = () => void;

export interface TurboAdapter {
  /** Live price stream. Calls cb with the latest tick right away when one exists. */
  subscribePrice(m: Market, cb: (p: PriceTick) => void): Unsub;

  /** Turbo fuel ($). Completely separate from game cash. */
  getFuel(): Promise<{ usd: number }>;
  onFuel(cb: (f: { usd: number }) => void): Unsub;

  /** Sends an order. Resolves with the id right away; the position is `pending` until a `filled` (or `failed`) event. */
  open(p: OpenParams): Promise<{ id: string }>;
  /** Close 25 / 50 / 100% of a position. 100 emits `closed`, otherwise `partial-closed`. */
  close(id: string, pct: ClosePct): Promise<void>;
  /** Set or clear (pass undefined) take-profit / stop-loss prices. */
  setTpSl(id: string, p: { tpPrice?: number; slPrice?: number }): Promise<void>;
  /** Pending and open positions. */
  getPositions(): Promise<Position[]>;
  onEvent(cb: (e: TurboEvent) => void): Unsub;
  /** Synchronous preview for the trade bar, from the latest price. */
  quote(p: QuoteParams): Quote;

  // ---- SITE extras (optional so GAME's code compiles against either shape) ----
  /** Practice: adds $ to Turbo fuel. Real adapter: starts a deposit flow. */
  addFuel?(usd: number): Promise<{ usd: number }>;
  /** Practice: removes $ from Turbo fuel. Real adapter: starts a withdraw. */
  withdrawFuel?(usd: number): Promise<{ usd: number }>;
  getMarkets?(): MarketInfo[];
  /** "practice" for the mock; "nova-sdk" / "nova-api" for real adapters later. */
  readonly kind?: "practice" | "nova-sdk" | "nova-api";
}
