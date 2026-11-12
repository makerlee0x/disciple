"use client";

import { useEffect } from "react";
import { isDeployed } from "@/lib/chains";
import { mcapOrderer, readMcapAt, reconcileMcap, toEngine, watchCurve } from "@/lib/events";
import { fetchGrad } from "@/lib/grad";
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
        const gradP = fetchGrad(token); // server graduation state (cached once graduated) — in parallel with the chain reads
        const curve = await curveOf(pc, token as Address);
        // b0 BEFORE the state read: the first State is labelled with a block its data is not older than (was: read the
        // curve, then up to 2.5 s later label it with a newer block ⇒ a stale first mcap could outrank newer Trades)
        const b0 = await pc.getBlockNumber();
        const st = await readCurveState(pc, token as Address);
        const m0 = await readMcapAt(pc, token as Address, b0, { tries: 2 }).catch(() => null);   // pinned at b0 (null ⇒ unlabelled)
        // One orderer for live + reconcile: the engine's mcap only ever moves forward in chain order.
        const order = mcapOrderer(toEngine);
        // GAME contract (SITE job 7): every engine update — this first State included — carries { graduated, poolId,
        // graduatedAt } next to mcapUsd (lib/protocol GradState; stamped by the orderer). Curve read first, the server's
        // poolId / graduatedAt on top (waited for briefly; if it lands later the State is re-sent with them).
        order.setGrad({ graduated: st.graduated });
        const g0 = await Promise.race([gradP, new Promise<undefined>((r) => setTimeout(() => r(undefined), 2500))]);
        order.setGrad(g0);
        // No history replay here: the engine draws past fills from /api/trades (engine.js liveHistory). Replaying every
        // Trade as a "live" event stacked old fills into the current candle and re-fed buys/sells the chart already had.
        if (!(m0 !== null && order.state(m0, b0)) && !(order.mcap > 0)) toEngine({ type: "State", mcapUsd: m0 ?? st.mcapUsd, ...order.grad } as never);
        if (g0 === undefined) void gradP.then((g) => { if (alive && g) { order.setGrad(g); order.resend(); } });
        // stream from the block after the state read: nothing between the read and the first poll is skipped
        const u = await watchCurve(token as Address, curve, toEngine, pc, order, b0 + BigInt(1));
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
