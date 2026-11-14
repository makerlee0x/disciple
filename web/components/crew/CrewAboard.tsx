"use client";
/**
 * "N of your crew aboard" on lobby rocket cards (main mode hook loop, maker 2026-11-13). The lobby wraps its shelves in
 * <CrewAboardProvider>; LiveCard reads the count with useCrewAboard(coin). Counts only (GET /api/crew/aboard), and
 * nothing at all when signed out or without a crew.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { privyAccessToken } from "@/lib/aa/sessionState";

const Ctx = createContext<Record<string, number>>({});
export const useCrewAboard = (coin: string) => useContext(Ctx)[coin.toLowerCase()] ?? 0;

export function CrewAboardProvider({ wallet, coins, children }: { wallet: string | null; coins: string[]; children: ReactNode }) {
  const [m, setM] = useState<Record<string, number>>({});
  const key = coins.slice(0, 30).map((c) => c.toLowerCase()).join(",");
  useEffect(() => {
    if (!wallet || !key) { setM({}); return; }
    let alive = true;
    (async () => {
      const token = await privyAccessToken().catch(() => null);
      if (!token) return;
      const r = await fetch(`/api/crew/aboard?wallet=${wallet.toLowerCase()}&coins=${key}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" }).catch(() => null);
      if (alive && r?.ok) setM(((await r.json()) as { aboard?: Record<string, number> }).aboard ?? {});
    })();
    return () => { alive = false; };
  }, [wallet, key]);
  return <Ctx.Provider value={m}>{children}</Ctx.Provider>;
}
