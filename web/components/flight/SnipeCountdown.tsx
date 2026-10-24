"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import SnipeChip from "./SnipeChip";
import { bondingCurveAbi } from "@/lib/abi";
import { isDeployed } from "@/lib/chains";
import { DEMO_POOL } from "@/lib/config";
import { SHOW_SNIPE_COUNTDOWN, SNIPE_POLL_MS, SNIPE_TICK_MS } from "@/lib/game/snipeCountdown";
import { curveOf, curveParams, publicClient, readCurveState } from "@/lib/protocol-viem";
import { snipeParamsFor, snipeState, type SnipeState } from "@/lib/snipe";

/**
 * Live coin: SNIPER TAX countdown (all math in SITE's lib/snipe.ts).
 * On mount: the coin's curve → launchTime(), curveParams() (totalSupply / tail → snipeParamsFor: old v4 coins keep 77.7%
 * linear over 7 s; steep coins get the per-second table bpsBySec 99 · 25 · 3 · 1 · 0.3 · 0.1 · 0.03 %, 0 from 7s; all from
 * lib/snipe + lib/config, never hardcoded here), the readCurveState() snapshot (graduated, snipeFeeBps) and the latest block
 * time (chain-clock offset). The tax steps every second, so while it is active the local tick runs every 250 ms and the
 * snapshot is re-read every ~250 ms (one read in flight at a time); snapshot.snipeFeeBps is passed as liveFeeBps (wins for
 * the %). The chip hides at 0. Nothing is polled once the tax is over, after graduation, or for non-curve coins.
 */
export default function SnipeCountdown({ token }: { token: string }) {
  const [state, setState] = useState<SnipeState | null>(null);
  useEffect(() => {
    if (!SHOW_SNIPE_COUNTDOWN || !isDeployed() || !/^0x[0-9a-fA-F]{40}$/.test(token) || token.toLowerCase() === DEMO_POOL.address) return;
    let alive = true; let tick = 0; let poll = 0; let inflight = false;
    const stop = () => { window.clearInterval(tick); window.clearInterval(poll); };
    (async () => {
      const pc = publicClient();
      const coin = token as Address;
      const curve = await curveOf(pc, coin);
      const [launch, params, snap, block] = await Promise.all([
        pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "launchTime" }),
        curveParams(pc, curve),
        readCurveState(pc, coin),
        pc.getBlock({ blockTag: "latest" }),
      ]);
      if (!alive || snap.graduated) return;   // the tax applies to curve buys only
      const sched = snipeParamsFor(params);
      const launchTs = Number(launch);
      const offset = Number(block.timestamp) - Date.now() / 1000;   // follow the chain clock, not the device clock
      let liveFeeBps: number | null = snap.snipeFeeBps ?? null;
      const step = () => {
        const s = snipeState({ launchTs, nowSec: Date.now() / 1000 + offset, ...sched, liveFeeBps });
        if (alive) setState(s);
        if (!s.active) stop();
        return s.active;
      };
      if (!step()) return;
      tick = window.setInterval(step, SNIPE_TICK_MS);
      poll = window.setInterval(() => {
        if (inflight || !alive) return;
        inflight = true;
        readCurveState(pc, coin)
          .then((st) => { if (!alive) return; if (st.graduated) liveFeeBps = 0; else liveFeeBps = st.snipeFeeBps ?? liveFeeBps; step(); })
          .catch(() => { /* keep the last value */ })
          .finally(() => { inflight = false; });
      }, SNIPE_POLL_MS);
    })().catch(() => { /* not a DISCIPLE curve / RPC down: no chip */ });
    return () => { alive = false; stop(); };
  }, [token]);
  return <SnipeChip state={state} />;
}
