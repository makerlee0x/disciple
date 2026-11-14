"use client";
/** The player's cash (USDG) in dollars, refreshed every 20 s and on CASH_ARRIVED_EVENT. null = signed out or not read yet. */
import { useCallback, useEffect, useState } from "react";
import { formatUnits } from "viem";
import { deployment, isDeployed } from "@/lib/chains";
import { decimalsOf, publicClient, tokenBalance } from "@/lib/protocol-viem";
import { onWallet } from "@/lib/wallet";
import { CASH_ARRIVED_EVENT } from "@/lib/testCash";
import type { Address } from "@/lib/protocol";

export function useCashUsd(): { usd: number | null; addr: Address | null; refresh: () => void } {
  const [addr, setAddr] = useState<Address | null>(null);
  const [usd, setUsd] = useState<number | null>(null);
  useEffect(() => onWallet(setAddr), []);
  const read = useCallback(async (a: Address) => {
    if (!isDeployed()) return;
    try {
      const pc = publicClient(); const usdg = deployment().usdg as Address;
      const [b, d] = await Promise.all([tokenBalance(pc, usdg, a), decimalsOf(pc, usdg)]);
      setUsd(Number(formatUnits(b, d)));
    } catch { /* keep the last read */ }
  }, []);
  useEffect(() => {
    if (!addr) { setUsd(null); return; }
    void read(addr);
    const i = setInterval(() => read(addr), 20000);
    const f = () => { void read(addr); };
    addEventListener(CASH_ARRIVED_EVENT, f);
    return () => { clearInterval(i); removeEventListener(CASH_ARRIVED_EVENT, f); };
  }, [addr, read]);
  return { usd, addr, refresh: () => { if (addr) void read(addr); } };
}
