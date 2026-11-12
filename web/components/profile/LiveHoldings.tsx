"use client";

import { useEffect, useState } from "react";
import { parseAbi, type Address } from "viem";
import { bookedPortfolio, loadPortfolio, type Holding } from "@/lib/portfolio";
import { fillBook, readAtOrAfter } from "@/lib/fillBook";
import { deployment } from "@/lib/chains";
import { publicClient } from "@/lib/protocol-viem";
import { IS_STATIC_PREVIEW } from "@/lib/base-path";

const erc20 = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)"]);
export type LiveHolding = Holding & { symbol: string; name: string; usd: number };
/** Cash (the account's USDG, in dollars) + every coin it holds. */
/** `ok` false = the read failed: show no dollar figures (never a made-up $0). */
export type LivePortfolio = { ok: boolean; cashUsd: number; rows: LiveHolding[] };

/**
 * On-chain portfolio of `wallet` (same read as the header portfolio card, lib/portfolio): cash plus every DISCIPLE coin
 * it holds, valued at the current price, largest first. Read-only. `null` while loading / when there's no wallet;
 * a failed read is an empty portfolio.
 */
export function useLivePortfolio(wallet: string | null): LivePortfolio | null {
  const [pf, setPf] = useState<LivePortfolio | null>(null);
  useEffect(() => {
    setPf(null);
    if (!wallet || IS_STATIC_PREVIEW || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) return;
    let alive = true;
    const pc = publicClient();
    // SITE #137: right after our own fill (coin page → profile) read at/after its receipt block, and show the booked
    // balances (lib/fillBook) over any read that does not include the fill yet
    const extra = fillBook.pendingTokens(wallet).filter((t) => t !== deployment().usdg.toLowerCase()) as Address[];
    readAtOrAfter(pc, fillBook.floor(wallet), (blockNumber) => loadPortfolio(pc, wallet as Address, extra, { blockNumber })).then(async ({ value, block }) => {
      for (const h of value.holdings) fillBook.observe(wallet, h.coin, h.tokens, block);
      const booked = bookedPortfolio(value, wallet, deployment().usdg);
      const out = await Promise.all(booked.holdings.map(async (h) => {
        const [symbol, name] = await Promise.all([
          pc.readContract({ address: h.coin, abi: erc20, functionName: "symbol" }).catch(() => "") as Promise<string>,
          pc.readContract({ address: h.coin, abi: erc20, functionName: "name" }).catch(() => "") as Promise<string>,
        ]);
        return { ...h, symbol: String(symbol).slice(0, 12), name: String(name).slice(0, 32), usd: h.tokens * h.priceNow };
      }));
      if (alive) setPf({ ok: true, cashUsd: booked.cashUsd, rows: out.sort((a, b) => b.usd - a.usd) });
    }).catch(() => { if (alive) setPf({ ok: false, cashUsd: 0, rows: [] }); });
    return () => { alive = false; };
  }, [wallet]);
  return pf;
}

/** Holdings only (kept for callers that don't need cash). */
export function useLiveHoldings(wallet: string | null): LiveHolding[] | null {
  return useLivePortfolio(wallet)?.rows ?? null;
}
