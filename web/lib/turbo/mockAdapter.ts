/**
 * PRACTICE / MOCK TurboAdapter. No real money, no wallet, no network calls — prices are a random walk.
 * Every screen using it must label prices and fuel as practice (MarketInfo.practice === true, adapter.kind === "practice").
 *
 * Mirrors the real venue's shape so swapping adapters is painless:
 *  - open() resolves at once with an id; the position is `pending` until a `filled` event (fillDelayMs later), like
 *    nova's two-step market order. Fuel (collateral) is taken at send and refunded on `failed`.
 *  - Fees are charged on notional per side (feeBps). Funding accrues every tick on notional.
 *  - Liquidation price includes fees and funding; crossing it emits `liquidated` (no fuel back).
 *  - TP / SL auto-close with reason 'tp' / 'sl'.
 *
 * Tests: pass { autoStart: false } and drive it with setPrice() / advance() / flushFills().
 */
import { closeSlice, feeUsd, fundingDeltaUsd, isLiquidated, liquidationPrice, notionalAt, pnlBreakdown, prng, walkStep } from "./math";
import { createFuelStore, type FuelStore } from "./fuel";
import type {
  ClosePct, Market, MarketInfo, OpenParams, Position, PriceTick, Quote, QuoteParams, TurboAdapter, TurboEvent, TurboEventReason, Unsub,
} from "./types";

export interface MockAdapterOptions {
  /** Fee per side in bps of notional. Default 1 (nova's real number is 4–5; lee: "fees aren't that high" — TBD). */
  feeBps?: number;
  /** Share of collateral lost (after fees + funding) at liquidation. Default 0.8 (nova HYPE1000 uses 80%). */
  liqLossFrac?: number;
  /** Funding as a fraction of notional per hour, + = longs pay shorts. Default 0.00001 (0.001%/h). */
  fundingRatePerHour?: number;
  maxLeverage?: number;
  minLeverage?: number;
  /** Delay before a pending order fills. Default 1500 ms. */
  fillDelayMs?: number;
  /** Chance (0..1) a pending order fails, to exercise the UI's "didn't go through" path. Default 0. */
  failRate?: number;
  tickMs?: number;
  /** Random-walk σ per tick. Default 0.00012. */
  volatility?: number;
  seed?: number;
  startPrices?: Partial<Record<Market, number>>;
  /** Fuel store (defaults to localStorage "disciple.turbo.fuel.v1"). */
  fuel?: FuelStore;
  /** Starts the price timer on first subscribe. Default true. */
  autoStart?: boolean;
  now?: () => number;
}

export interface MockTurboAdapter extends TurboAdapter {
  readonly kind: "practice";
  addFuel(usd: number): Promise<{ usd: number }>;
  withdrawFuel(usd: number): Promise<{ usd: number }>;
  getMarkets(): MarketInfo[];
  // ---- test / dev controls (not part of TurboAdapter) ----
  setPrice(m: Market, price: number): void;
  /** Moves the mock clock forward by ms (with a custom `now`, move your clock and pass 0), accrues funding, runs due
   * fills, then re-checks TP/SL/liquidation. */
  advance(ms: number): void;
  /** Fills every pending order now at the current price. */
  flushFills(): void;
  getPrice(m: Market): number;
  dispose(): void;
}

const MARKETS: Market[] = ["BTC", "ETH"];
const r2 = (n: number) => Math.round(n * 100) / 100;

interface Internal extends Position {
  fillAt: number;
  lastFundingAt: number;
}

export function createMockAdapter(o: MockAdapterOptions = {}): MockTurboAdapter {
  const cfg = {
    feeBps: o.feeBps ?? 1,
    liqLossFrac: o.liqLossFrac ?? 0.8,
    fundingRatePerHour: o.fundingRatePerHour ?? 0.00001,
    maxLeverage: o.maxLeverage ?? 1000,
    minLeverage: o.minLeverage ?? 1.1,
    fillDelayMs: o.fillDelayMs ?? 1500,
    failRate: o.failRate ?? 0,
    tickMs: o.tickMs ?? 250,
    volatility: o.volatility ?? 0.00012,
    autoStart: o.autoStart ?? true,
  };
  const rand = prng(o.seed ?? 0xd15c1e);
  let clock = (o.now ?? Date.now)();
  const now = () => (o.now ? o.now() : Math.max(clock, Date.now()));
  const fuel = o.fuel ?? createFuelStore();
  const prices: Record<Market, number> = { BTC: o.startPrices?.BTC ?? 67_000, ETH: o.startPrices?.ETH ?? 2_600 };
  const ticks: Partial<Record<Market, PriceTick>> = {};
  const priceSubs = new Set<{ m: Market; cb: (p: PriceTick) => void }>();
  const eventSubs = new Set<(e: TurboEvent) => void>();
  const positions = new Map<string, Internal>();
  let seq = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const pub = (p: Internal): Position => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { fillAt, lastFundingAt, ...rest } = p;
    return { ...rest };
  };
  const emit = (type: TurboEvent["type"], p: Internal, extra: { reason?: TurboEventReason; returnedUsd?: number; pct?: ClosePct } = {}) => {
    const e: TurboEvent = { type, position: pub(p), ...extra };
    eventSubs.forEach((cb) => { try { cb(e); } catch (err) { console.warn("[disciple] turbo event listener threw", err); } });
  };

  const refresh = (p: Internal) => {
    const price = prices[p.market];
    const b = pnlBreakdown({ side: p.side, sizeUsd: p.sizeUsd, entry: p.entry, price, openFeeUsd: p.openFeeUsd, fundingUsd: p.fundingUsd, feeBps: cfg.feeBps });
    p.markPrice = price;
    p.pnlUsd = b.pnlUsd;
    p.closeFeeUsdEst = b.closeFeeUsdEst;
    p.pnlAfterFeesUsd = b.pnlAfterFeesUsd;
    p.liqPrice = liquidationPrice({ side: p.side, collateralUsd: p.collateralUsd, sizeUsd: p.sizeUsd, entry: p.entry, openFeeUsd: p.openFeeUsd, fundingUsd: p.fundingUsd, feeBps: cfg.feeBps, liqLossFrac: cfg.liqLossFrac });
  };

  const quote = (q: QuoteParams): Quote => {
    const entryEst = prices[q.market];
    const sizeUsd = q.collateralUsd * q.leverage;
    const openFeeUsd = feeUsd(sizeUsd, cfg.feeBps);
    const liqPrice = liquidationPrice({ side: q.side, collateralUsd: q.collateralUsd, sizeUsd, entry: entryEst, openFeeUsd, fundingUsd: 0, feeBps: cfg.feeBps, liqLossFrac: cfg.liqLossFrac });
    return { sizeUsd, entryEst, liqPrice, openFeeUsd, closeFeeUsd: openFeeUsd };
  };

  const finish = (p: Internal, type: "closed" | "liquidated", reason: TurboEventReason) => {
    const returnedUsd = type === "liquidated" ? 0 : closeSlice({ side: p.side, sizeUsd: p.sizeUsd, entry: p.entry, price: prices[p.market], openFeeUsd: p.openFeeUsd, fundingUsd: p.fundingUsd, feeBps: cfg.feeBps, collateralUsd: p.collateralUsd }, 1).returnedUsd;
    p.status = type;
    positions.delete(p.id);
    if (returnedUsd > 0) fuel.set(fuel.get() + returnedUsd);
    p.realizedUsd = r2((p.realizedUsd ?? 0) + returnedUsd);
    emit(type, p, { reason, returnedUsd, pct: type === "closed" ? 100 : undefined });
  };

  const fill = (p: Internal, t: number) => {
    if (cfg.failRate > 0 && rand() < cfg.failRate) {
      p.status = "failed";
      positions.delete(p.id);
      fuel.set(fuel.get() + p.collateralUsd);
      emit("failed", p, { reason: "timeout" });
      return;
    }
    p.entry = prices[p.market];
    p.openFeeUsd = feeUsd(p.sizeUsd, cfg.feeBps);
    p.status = "open";
    p.openedAt = t;
    p.lastFundingAt = t;
    refresh(p);
    emit("filled", p);
    check(p);
  };

  /** TP / SL / liquidation for one open position. Liquidation wins over SL when both are crossed. */
  const check = (p: Internal) => {
    if (p.status !== "open") return;
    const price = prices[p.market];
    if (isLiquidated(p.side, price, p.liqPrice)) return finish(p, "liquidated", "liquidation");
    const up = p.side === "long";
    if (p.tpPrice !== undefined && (up ? price >= p.tpPrice : price <= p.tpPrice)) return finish(p, "closed", "tp");
    if (p.slPrice !== undefined && (up ? price <= p.slPrice : price >= p.slPrice)) return finish(p, "closed", "sl");
  };

  const step = (t: number) => {
    for (const p of Array.from(positions.values())) {
      if (p.status === "pending") { if (t >= p.fillAt) fill(p, t); continue; }
      if (p.status !== "open") continue;
      const dt = t - p.lastFundingAt;
      if (dt > 0) {
        p.fundingUsd += fundingDeltaUsd(p.side, notionalAt(p.sizeUsd, p.entry, prices[p.market]), cfg.fundingRatePerHour, dt);
        p.lastFundingAt = t;
      }
      refresh(p);
      check(p);
    }
  };

  const publish = (m: Market, t: number) => {
    const tick = { price: prices[m], ts: t };
    ticks[m] = tick;
    priceSubs.forEach((s) => { if (s.m === m) s.cb(tick); });
  };

  const startTimer = () => {
    if (timer || !cfg.autoStart || typeof setInterval === "undefined") return;
    timer = setInterval(() => {
      const t = now();
      clock = t;
      for (const m of MARKETS) { prices[m] = walkStep(prices[m], cfg.volatility, rand); publish(m, t); }
      step(t);
    }, cfg.tickMs);
  };
  const stopTimerIfIdle = () => {
    if (timer && priceSubs.size === 0 && positions.size === 0) { clearInterval(timer); timer = null; }
  };

  const get = (id: string): Internal => {
    const p = positions.get(id);
    if (!p) throw new Error("Position not found");
    return p;
  };
  const validPrice = (v: number | undefined) => v === undefined || (Number.isFinite(v) && v > 0);

  const adapter: MockTurboAdapter = {
    kind: "practice",

    subscribePrice(m, cb): Unsub {
      const s = { m, cb };
      priceSubs.add(s);
      cb(ticks[m] ?? { price: prices[m], ts: now() });
      startTimer();
      return () => { priceSubs.delete(s); stopTimerIfIdle(); };
    },

    getFuel: async () => ({ usd: fuel.get() }),
    onFuel(cb) { return fuel.subscribe((usd) => cb({ usd })); },
    async addFuel(usd) {
      if (!(Number.isFinite(usd) && usd > 0)) throw new Error("Enter an amount above $0");
      fuel.set(fuel.get() + usd);
      return { usd: fuel.get() };
    },
    async withdrawFuel(usd) {
      if (!(Number.isFinite(usd) && usd > 0)) throw new Error("Enter an amount above $0");
      if (usd > fuel.get() + 1e-9) throw new Error("That's more than your Turbo fuel");
      fuel.set(fuel.get() - usd);
      return { usd: fuel.get() };
    },

    getMarkets: () => MARKETS.map((market) => ({ market, maxLeverage: cfg.maxLeverage, minLeverage: cfg.minLeverage, feeBps: cfg.feeBps, fundingRatePerHour: cfg.fundingRatePerHour, practice: true })),

    quote,

    async open(p: OpenParams) {
      if (!MARKETS.includes(p.market)) throw new Error("That market isn't available");
      if (!(Number.isFinite(p.collateralUsd) && p.collateralUsd > 0)) throw new Error("Enter an amount above $0");
      if (!(Number.isFinite(p.leverage) && p.leverage >= cfg.minLeverage && p.leverage <= cfg.maxLeverage)) throw new Error(`Pick between ${cfg.minLeverage}× and ${cfg.maxLeverage}×`);
      if (!validPrice(p.tpPrice) || !validPrice(p.slPrice)) throw new Error("Take-profit and stop-loss must be above $0");
      if (p.collateralUsd > fuel.get() + 1e-9) throw new Error("Not enough Turbo fuel");
      const q = quote(p);
      if (isLiquidated(p.side, q.entryEst, q.liqPrice)) {
        console.warn("[disciple] turbo mock: fees exceed the liquidation buffer at this leverage", { feeBps: cfg.feeBps, leverage: p.leverage });
        throw new Error("Fees would wipe this out right away. Try lower leverage.");
      }
      const t = now();
      const id = `mock-${t.toString(36)}-${(++seq).toString(36)}`;
      const pos: Internal = {
        id, market: p.market, side: p.side, collateralUsd: p.collateralUsd, leverage: p.leverage, sizeUsd: q.sizeUsd,
        entry: q.entryEst, liqPrice: q.liqPrice, fundingUsd: 0, openFeeUsd: q.openFeeUsd, closeFeeUsdEst: q.closeFeeUsd,
        pnlUsd: 0, pnlAfterFeesUsd: -q.openFeeUsd - q.closeFeeUsd, tpPrice: p.tpPrice, slPrice: p.slPrice, status: "pending",
        markPrice: q.entryEst, openedAt: t, realizedUsd: 0, fillAt: t + cfg.fillDelayMs, lastFundingAt: t,
      };
      fuel.set(fuel.get() - p.collateralUsd);
      positions.set(id, pos);
      emit("pending", pos);
      startTimer();
      if (cfg.autoStart && cfg.fillDelayMs <= 0) fill(pos, t);
      return { id };
    },

    async close(id, pct) {
      const p = get(id);
      if (p.status !== "open") throw new Error("Still waiting on a price. Try again in a moment.");
      if (pct !== 25 && pct !== 50 && pct !== 100) throw new Error("Close 25, 50 or 100%");
      if (pct === 100) { finish(p, "closed", "manual"); stopTimerIfIdle(); return; }
      const frac = pct / 100;
      const s = closeSlice({ side: p.side, sizeUsd: p.sizeUsd, entry: p.entry, price: prices[p.market], openFeeUsd: p.openFeeUsd, fundingUsd: p.fundingUsd, feeBps: cfg.feeBps, collateralUsd: p.collateralUsd }, frac);
      const keep = 1 - frac;
      p.collateralUsd *= keep;
      p.sizeUsd *= keep;
      p.openFeeUsd *= keep;
      p.fundingUsd *= keep;
      p.realizedUsd = r2((p.realizedUsd ?? 0) + s.returnedUsd);
      fuel.set(fuel.get() + s.returnedUsd);
      refresh(p);
      emit("partial-closed", p, { reason: "manual", returnedUsd: s.returnedUsd, pct });
    },

    async setTpSl(id, v) {
      const p = get(id);
      if (!validPrice(v.tpPrice) || !validPrice(v.slPrice)) throw new Error("Take-profit and stop-loss must be above $0");
      p.tpPrice = v.tpPrice;
      p.slPrice = v.slPrice;
      check(p);
    },

    getPositions: async () => Array.from(positions.values()).map(pub),

    onEvent(cb) { eventSubs.add(cb); return () => { eventSubs.delete(cb); }; },

    // ---- test / dev controls ----
    setPrice(m, price) { prices[m] = price; publish(m, now()); step(now()); },
    getPrice: (m) => prices[m],
    advance(ms) { if (o.now) step(o.now()); else { clock = now() + ms; step(clock); } },
    flushFills() { const t = now(); for (const p of Array.from(positions.values())) if (p.status === "pending") fill(p, t); },
    dispose() { if (timer) clearInterval(timer); timer = null; priceSubs.clear(); eventSubs.clear(); },
  };
  return adapter;
}
