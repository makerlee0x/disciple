"use client";

import { useEffect } from "react";
import { isDeployed } from "@/lib/chains";
import { mcapOrderer, readMcapAt, reconcileMcap, toEngine, watchCurve } from "@/lib/events";
import { fetchGrad } from "@/lib/grad";
import { curveOf, publicClient, readCurveState } from "@/lib/protocol-viem";
import { NOT_GRADUATED, type Address } from "@/lib/protocol";

/** No State from the chain by then ⇒ the server's mcap (/api/coin/stats) stands in. */
export const FALLBACK_MS = 2500;
/** Waits between chain boot retries after a failed read. */
const RETRY_MS = [2000, 4000, 8000, 15000, 30000, 30000];

/** Streams a DISCIPLE coin's curve events into the flight engine (no-op until contracts deploy). */
export default function DiscipleFeed({ token }: { token: string }) {
  useEffect(() => {
    if (!isDeployed() || !/^0x[0-9a-fA-F]{40}$/.test(token)) return;
    let stop: (() => void) | undefined;
    let alive = true;
    // First State already sent (chain read or the server fallback below): the engine has a price to fly at.
    let sent = false;
    const send = (e: Parameters<typeof toEngine>[0]) => { sent = true; toEngine(e); };
    let marked = false;
    const onMark = () => { marked = true; };
    addEventListener("disciple:mark", onMark);
    // Server fallback (maker 2026-11-20, $SPACE page blank: the browser's chain reads to RH mainnet failed, so no State
    // ever reached the engine and it drew nothing). /api/coin/stats reads the same mcap server side; it only fills the gap
    // until the chain path answers, which keeps retrying below.
    const fallback = window.setTimeout(async () => {
      if (sent || !alive) return;
      const [stats, g] = await Promise.all([
        fetch(`/api/coin/stats?coin=${token}`).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<{ mcapUsd?: number | null } | null>,
        fetchGrad(token),
      ]);
      const m = Number(stats?.mcapUsd);
      if (!(m > 0)) return;
      // The engine may still be booting (its listener isn't up yet): re-send until it shows a price (disciple:mark) or
      // the chain path takes over, at most ~20 s.
      for (let i = 0; i < 10 && alive && !sent && !marked; i++) {
        toEngine({ type: "State", mcapUsd: m, ...(g ?? NOT_GRADUATED) } as never);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }, FALLBACK_MS);
    const boot = async (attempt: number): Promise<void> => {
      try {
        const pc = publicClient();
        const gradP = fetchGrad(token); // server graduation state (cached once graduated) — in parallel with the chain reads
        // speed (maker 2026-11-18: "even when you get to flying the rocket, its still waiting and the rocket isnt there"):
        // the reads run side by side, and the first State goes out the moment the price is known. It used to wait up to
        // 2.5 s for the server's graduation record; that now lands later and re-sends the State (the curve read already
        // says whether the coin graduated).
        // b0 BEFORE the state read: the first State is labelled with a block its data is not older than (was: read the
        // curve, then up to 2.5 s later label it with a newer block ⇒ a stale first mcap could outrank newer Trades)
        const [curve, b0] = await Promise.all([curveOf(pc, token as Address), pc.getBlockNumber()]);
        const [st, m0] = await Promise.all([
          readCurveState(pc, token as Address),
          readMcapAt(pc, token as Address, b0, { tries: 2 }).catch(() => null),   // pinned at b0 (null ⇒ unlabelled)
        ]);
        // One orderer for live + reconcile: the engine's mcap only ever moves forward in chain order.
        const order = mcapOrderer(toEngine);
        // GAME contract (SITE job 7): every engine update — this first State included — carries { graduated, poolId,
        // graduatedAt } next to mcapUsd (lib/protocol GradState; stamped by the orderer).
        order.setGrad({ graduated: st.graduated });
        // No history replay here: the engine draws past fills from /api/trades (engine.js liveHistory). Replaying every
        // Trade as a "live" event stacked old fills into the current candle and re-fed buys/sells the chart already had.
        if (!alive) return;
        if (m0 !== null && order.state(m0, b0)) sent = true;
        else if (!(order.mcap > 0)) send({ type: "State", mcapUsd: m0 ?? st.mcapUsd, ...order.grad } as never);
        void gradP.then((g) => { if (alive && g) { order.setGrad(g); order.resend(); } });
        // stream from the block after the state read: nothing between the read and the first poll is skipped
        const u = await watchCurve(token as Address, curve, toEngine, pc, order, b0 + BigInt(1));
        const r = reconcileMcap(token as Address, order, pc);
        const both = () => { u(); r(); };
        if (alive) stop = both; else both();
      } catch {
        // A failed read (RPC down / rate limited) used to end here for good: no rocket until a reload. Retry with backoff.
        // A real non-DISCIPLE address keeps failing quietly, and the engine keeps its demo source.
        if (alive && attempt < RETRY_MS.length) { await new Promise((r) => setTimeout(r, RETRY_MS[attempt])); if (alive) return boot(attempt + 1); }
      }
    };
    void boot(0);
    return () => { alive = false; clearTimeout(fallback); removeEventListener("disciple:mark", onMark); stop?.(); };
  }, [token]);
  return null;
}
