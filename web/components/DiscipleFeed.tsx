"use client";

import { useEffect } from "react";
import { isDeployed } from "@/lib/chains";
import { toEngine, tradeHistory, watchCurve } from "@/lib/events";
import { curveOf, publicClient, readCurveState } from "@/lib/protocol-viem";
import type { Address } from "@/lib/protocol";

/** Streams a DISCIPLE coin's curve events into the flight engine (no-op until contracts deploy). */
export default function DiscipleFeed({ token }: { token: string }) {
  useEffect(() => {
    if (!isDeployed() || !/^0x[0-9a-fA-F]{40}$/.test(token)) return;
    let stop: (() => void) | undefined;
    let alive = true;
    (async () => {
      try {
        const pc = publicClient();
        const curve = await curveOf(pc, token as Address);
        const st = await readCurveState(pc, token as Address);
        // Backfill trades since the deployment start block so the chart has history, then go live.
        try { for (const e of await tradeHistory(token as Address, curve, pc)) toEngine(e); } catch { /* RPC range limits → live only */ }
        toEngine({ type: "State", mcapUsd: st.mcapUsd } as never);
        const u = await watchCurve(token as Address, curve, toEngine, pc);
        if (alive) stop = u; else u();
      } catch {
        /* not a DISCIPLE coin → engine keeps its v3 demo source */
      }
    })();
    return () => { alive = false; stop?.(); };
  }, [token]);
  return null;
}
