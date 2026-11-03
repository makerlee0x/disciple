"use client";

import { useEffect, useState } from "react";
import { parseAbi, type Address } from "viem";
import { deployment, isDeployed } from "@/lib/chains";
import { publicClient } from "@/lib/protocol-viem";
import { IS_STATIC_PREVIEW, withBase } from "@/lib/base-path";
import { playerUsd, type Fill } from "@/lib/trades";
import type { ActivityItem } from "@/lib/stats";

const erc20 = parseAbi(["function symbol() view returns (string)"]);
const isAddr = (a: string | null | undefined): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);
/** Coins read per profile (most players trade a handful); fills per coin (newest first). */
const MAX_COINS = 40, PER_COIN = 100;

/**
 * The profile's activity feed from REAL trades only (lee, Oct 30: the old feed was lib/mock sample trades seeded by the
 * username). Source: the KV trade index (/api/trades: the coins the wallet traded, then that wallet's fills per coin),
 * filtered to the current contracts (fills at/after deployment().fromBlock; older stacks' fills stay in KV under the same
 * wallet keys). Newest first. `null` while loading; `[]` when there are none or the read failed (empty state, no sample).
 */
export function useRealActivity(wallet: string | null): ActivityItem[] | null {
  const [rows, setRows] = useState<ActivityItem[] | null>(null);
  useEffect(() => {
    setRows(null);
    if (!isAddr(wallet) || IS_STATIC_PREVIEW || !isDeployed()) { setRows(wallet ? [] : null); return; }
    let alive = true;
    const w = wallet.toLowerCase();
    const from = Number(deployment().fromBlock);
    (async () => {
      const j = await fetch(withBase(`/api/trades?wallet=${w}`)).then((r) => (r.ok ? r.json() : {})) as { coins?: string[] };
      const coins = (j.coins ?? []).filter(isAddr).slice(0, MAX_COINS);
      const pc = publicClient();
      const per = await Promise.all(coins.map(async (coin) => {
        const r = await fetch(withBase(`/api/trades?coin=${coin}&wallet=${w}&order=desc&limit=${PER_COIN}`)).then((x) => (x.ok ? x.json() : {})).catch(() => ({})) as { fills?: Fill[] };
        const fills = (r.fills ?? []).filter((f) => f.block >= from && String(f.trader).toLowerCase() === w);
        if (!fills.length) return [];
        const sym = String(await pc.readContract({ address: coin as Address, abi: erc20, functionName: "symbol" }).catch(() => "") || coin.slice(2, 6).toUpperCase()).slice(0, 12);
        return fills.map((f): ActivityItem => ({ id: f.id, ts: f.ts, kind: f.side, text: `$${sym}`, usd: playerUsd(f), ticker: sym, coin }));
      }));
      return per.flat().sort((a, b) => b.ts - a.ts);
    })().then((out) => { if (alive) setRows(out); }).catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [wallet]);
  return rows;
}
