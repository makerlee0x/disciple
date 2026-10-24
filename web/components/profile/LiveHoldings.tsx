"use client";

import { useEffect, useState } from "react";
import { parseAbi, type Address } from "viem";
import { loadPortfolio, type Holding } from "@/lib/portfolio";
import { publicClient } from "@/lib/protocol-viem";
import { IS_STATIC_PREVIEW } from "@/lib/base-path";

const erc20 = parseAbi(["function symbol() view returns (string)"]);
export type LiveHolding = Holding & { symbol: string; usd: number };

/**
 * On-chain holdings of `wallet` (same read as the header portfolio card, lib/portfolio): every DISCIPLE coin it holds,
 * valued at the current price, largest first. Read-only. `null` while loading / when there's no wallet.
 */
export function useLiveHoldings(wallet: string | null): LiveHolding[] | null {
  const [rows, setRows] = useState<LiveHolding[] | null>(null);
  useEffect(() => {
    setRows(null);
    if (!wallet || IS_STATIC_PREVIEW || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) return;
    let alive = true;
    const pc = publicClient();
    loadPortfolio(pc, wallet as Address).then(async (pf) => {
      const out = await Promise.all(pf.holdings.map(async (h) => {
        const symbol = await pc.readContract({ address: h.coin, abi: erc20, functionName: "symbol" }).catch(() => "") as string;
        return { ...h, symbol: String(symbol).slice(0, 12), usd: h.tokens * h.priceNow };
      }));
      if (alive) setRows(out.sort((a, b) => b.usd - a.usd));
    }).catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [wallet]);
  return rows;
}
