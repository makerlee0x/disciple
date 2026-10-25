/**
 * PRACTICE / MOCK TurboAdapter — STUB (first commit so GAME can stack). Full mock lands in the next commit.
 * No real money, no wallet, no network.
 */
import type { Market, PriceTick, Quote, QuoteParams, TurboAdapter, Unsub } from "./types";

export function createMockAdapter(): TurboAdapter {
  const prices: Record<Market, number> = { BTC: 67000, ETH: 2600 };
  const subs = new Set<{ m: Market; cb: (p: PriceTick) => void }>();
  let timer: ReturnType<typeof setInterval> | null = null;
  const start = () => {
    if (timer || typeof setInterval === "undefined") return;
    timer = setInterval(() => {
      (Object.keys(prices) as Market[]).forEach((m) => (prices[m] *= 1 + (Math.random() - 0.5) * 0.0004));
      const ts = Date.now();
      subs.forEach((s) => s.cb({ price: prices[s.m], ts }));
    }, 250);
  };
  const notYet = () => Promise.reject(new Error("[disciple] turbo mock stub: not implemented yet"));
  return {
    kind: "practice",
    subscribePrice(m, cb): Unsub {
      const s = { m, cb };
      subs.add(s);
      start();
      cb({ price: prices[m], ts: Date.now() });
      return () => { subs.delete(s); if (!subs.size && timer) { clearInterval(timer); timer = null; } };
    },
    getFuel: async () => ({ usd: 0 }),
    onFuel: () => () => {},
    open: notYet,
    close: notYet,
    setTpSl: notYet,
    getPositions: async () => [],
    onEvent: () => () => {},
    quote(p: QuoteParams): Quote {
      const sizeUsd = p.collateralUsd * p.leverage, entryEst = prices[p.market], fee = (sizeUsd * 5) / 1e4;
      const move = Math.max(0, p.collateralUsd * 0.8 - 2 * fee) / sizeUsd;
      return { sizeUsd, entryEst, liqPrice: entryEst * (p.side === "long" ? 1 - move : 1 + move), openFeeUsd: fee, closeFeeUsd: fee };
    },
    getMarkets: () => [{ market: "BTC", maxLeverage: 1000, practice: true }, { market: "ETH", maxLeverage: 1000, practice: true }],
  };
}
