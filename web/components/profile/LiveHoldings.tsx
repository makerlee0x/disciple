"use client";

import { useEffect, useState } from "react";
import { parseAbi, type Address } from "viem";
import { bookedPortfolio, cachedPrice24h, loadPortfolio, type Holding } from "@/lib/portfolio";
import { fillBook, readAtOrAfter } from "@/lib/fillBook";
import { deployment } from "@/lib/chains";
import { publicClient } from "@/lib/protocol-viem";
import { IS_STATIC_PREVIEW } from "@/lib/base-path";

const erc20 = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)"]);
export type LiveHolding = Holding & { symbol: string; name: string; usd: number };
/** Cash (the account's USDG, in dollars) + every coin it holds. */
/** price24h is NaN until the second step lands. `ok` false = the read failed: show no dollar figures (never a made-up $0). */
export type LivePortfolio = { ok: boolean; cashUsd: number; rows: LiveHolding[] };

/**
 * On-chain portfolio of `wallet` (same read as the header portfolio card, lib/portfolio): cash plus every DISCIPLE coin
 * it holds, valued at the current price, largest first. Read-only. `null` while loading / when there's no wallet;
 * a failed read is an empty portfolio.
 */
/** last good read per wallet this page: coming back to the Hangar (or the wallet settling after sign-in) paints it at
 *  once, and a failed refresh keeps it, instead of blanking to "—" and back (maker 2026-11-20). */
const lastGood = new Map<string, LivePortfolio>();
export function useLivePortfolio(wallet: string | null): LivePortfolio | null {
  const key = wallet?.toLowerCase() ?? "";
  const [pf, setPfRaw] = useState<LivePortfolio | null>(() => lastGood.get(key) ?? null);
  const setPf = (v: LivePortfolio | null) => { if (v?.ok && key) lastGood.set(key, v); setPfRaw(v); };
  useEffect(() => {
    setPfRaw(lastGood.get(key) ?? null);
    if (!wallet || IS_STATIC_PREVIEW || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) return;
    // dev only (screenshots): window.__portfolioDev = { cashUsd, rows } shows a made-up fleet with no chain read
    const dev = process.env.NODE_ENV !== "production" ? (window as unknown as { __portfolioDev?: LivePortfolio }).__portfolioDev : undefined;
    if (dev) { setPf(dev); return; }
    let alive = true;
    const pc = publicClient();
    // SITE #137: right after our own fill (coin page → profile) read at/after its receipt block, and show the booked
    // balances (lib/fillBook) over any read that does not include the fill yet
    const extra = fillBook.pendingTokens(wallet).filter((t) => t !== deployment().usdg.toLowerCase()) as Address[];
    // Two steps (maker 2026-11-19: "the fleet loads way too slow"): balances and prices first, so the fleet and Hangar
    // value show at once; then each coin's 24 h price (its fills) and its symbol / name, which only the "today" line and
    // rockets the lobby doesn't list need.
    readAtOrAfter(pc, fillBook.floor(wallet), (blockNumber) => loadPortfolio(pc, wallet as Address, extra, { blockNumber, skip24h: true })).then(async ({ value, block }) => {
      for (const h of value.holdings) fillBook.observe(wallet, h.coin, h.tokens, block);
      const booked = bookedPortfolio(value, wallet, deployment().usdg);
      const first = booked.holdings.map((h) => ({ ...h, symbol: "", name: "", usd: h.tokens * h.priceNow }));
      if (!alive) return;
      setPf({ ok: true, cashUsd: booked.cashUsd, rows: [...first].sort((a, b) => b.usd - a.usd) });
      const out = await Promise.all(first.map(async (h) => {
        const [symbol, name, price24h] = await Promise.all([
          pc.readContract({ address: h.coin, abi: erc20, functionName: "symbol" }).catch(() => "") as Promise<string>,
          pc.readContract({ address: h.coin, abi: erc20, functionName: "name" }).catch(() => "") as Promise<string>,
          cachedPrice24h(h.coin).catch(() => h.priceNow),
        ]);
        return { ...h, symbol: String(symbol).slice(0, 12), name: String(name).slice(0, 32), price24h };
      }));
      if (alive) setPf({ ok: true, cashUsd: booked.cashUsd, rows: out.sort((a, b) => b.usd - a.usd) });
    }).catch(() => { if (alive && !lastGood.has(key)) setPf({ ok: false, cashUsd: 0, rows: [] }); });
    return () => { alive = false; };
  }, [wallet]); // eslint-disable-line react-hooks/exhaustive-deps
  return pf;
}

/** Holdings only (kept for callers that don't need cash). */
export function useLiveHoldings(wallet: string | null): LiveHolding[] | null {
  return useLivePortfolio(wallet)?.rows ?? null;
}
