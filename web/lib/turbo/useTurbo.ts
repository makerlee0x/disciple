"use client";
/**
 * One hook for the Turbo screens: live prices for both markets, fuel, pending + open positions, and the last event.
 * Every number comes from the adapter (quote / fills / events); the screen never computes its own fills.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getTurboAdapter } from "./index";
import type { Market, Position, TurboEvent } from "./types";

const MARKETS: Market[] = ["BTC", "ETH"];

export function useTurbo() {
  const a = getTurboAdapter();
  const [prices, setPrices] = useState<Partial<Record<Market, number>>>({});
  const [fuel, setFuel] = useState<number | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [lastEvent, setLastEvent] = useState<TurboEvent | null>(null);
  const history = useRef<Record<Market, { t: number; p: number }[]>>({ BTC: [], ETH: [] });

  useEffect(() => {
    const offs = MARKETS.map((m) => a.subscribePrice(m, ({ price, ts }) => {
      const h = history.current[m]; h.push({ t: ts, p: price }); if (h.length > 600) h.splice(0, h.length - 600);
      setPrices((prev) => (prev[m] === price ? prev : { ...prev, [m]: price }));
    }));
    return () => offs.forEach((o) => o());
  }, [a]);

  useEffect(() => {
    let live = true;
    a.getFuel().then((f) => { if (live) setFuel(f.usd); }).catch(() => {});
    const off = a.onFuel((f) => setFuel(f.usd));
    return () => { live = false; off(); };
  }, [a]);

  const refresh = useCallback(() => { a.getPositions().then(setPositions).catch(() => {}); }, [a]);
  useEffect(() => {
    refresh();
    const off = a.onEvent((e) => { setLastEvent(e); refresh(); });
    const id = setInterval(refresh, 500);   // PnL / funding move with every price; positions list re-reads twice a second
    return () => { off(); clearInterval(id); };
  }, [a, refresh]);

  return { adapter: a, prices, fuel, positions, lastEvent, history: history.current, refresh, standIn: a.kind === "practice" };
}
