"use client";

import { useEffect } from "react";
import { isDeployed } from "@/lib/chains";
import { mcapOrderer, reconcileMcap, toEngine, watchCurve } from "@/lib/events";
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
        // One orderer for live + reconcile: the engine's mcap only ever moves forward in chain order.
        const order = mcapOrderer(toEngine);
        const b0 = await pc.getBlockNumber();
        // No history replay here: the engine draws past fills from /api/trades (engine.js liveHistory). Replaying every
        // Trade as a "live" event stacked old fills into the current candle and re-fed buys/sells the chart already had.
        if (!order.state(st.mcapUsd, b0) && !(order.mcap > 0)) toEngine({ type: "State", mcapUsd: st.mcapUsd } as never);
        const u = await watchCurve(token as Address, curve, toEngine, pc, order);
        const r = reconcileMcap(token as Address, order, pc);
        const both = () => { u(); r(); };
        if (alive) stop = both; else both();
      } catch {
        /* not a DISCIPLE coin → engine keeps its v3 demo source */
      }
    })();
    return () => { alive = false; stop?.(); };
  }, [token]);
  return null;
}
