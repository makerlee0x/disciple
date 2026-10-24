"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import SnipeChip from "./SnipeChip";
import { bondingCurveAbi } from "@/lib/abi";
import { isDeployed } from "@/lib/chains";
import { DEMO_POOL } from "@/lib/config";
import { SHOW_SNIPE_COUNTDOWN } from "@/lib/game/snipeCountdown";
import { curveOf, publicClient } from "@/lib/protocol-viem";
import { snipeParamsFor, snipeState, type SnipeState } from "@/lib/snipe";

/**
 * Live coin: SNIPER TAX countdown. One read on mount: the coin's curve → launchTime(), curveTail() (present ⇒ steep
 * schedule, absent ⇒ old v4 schedule; params from lib/config via snipeParamsFor), graduated(), currentSnipeFeeBps()
 * and the latest block time (chain-clock offset). Then a 1 s local tick; while the tax is active currentSnipeFeeBps()
 * (= readCurveState().snipeFeeBps) is re-read every 2 s and wins for the % shown. Nothing is polled once it is over.
 */
export default function SnipeCountdown({ token }: { token: string }) {
  const [state, setState] = useState<SnipeState | null>(null);
  useEffect(() => {
    if (!SHOW_SNIPE_COUNTDOWN || !isDeployed() || !/^0x[0-9a-fA-F]{40}$/.test(token) || token.toLowerCase() === DEMO_POOL.address) return;
    let alive = true; let tick = 0; let poll = 0;
    const stop = () => { window.clearInterval(tick); window.clearInterval(poll); };
    (async () => {
      const pc = publicClient();
      const curve = await curveOf(pc, token as Address);
      const c = { address: curve, abi: bondingCurveAbi } as const;
      const [launch, tail, graduated, fee, block] = await Promise.all([
        pc.readContract({ ...c, functionName: "launchTime" }),
        pc.readContract({ ...c, functionName: "curveTail" }).catch(() => null),   // pre-steep (v4) curves have no curveTail()
        pc.readContract({ ...c, functionName: "graduated" }),
        pc.readContract({ ...c, functionName: "currentSnipeFeeBps" }).catch(() => null),
        pc.getBlock({ blockTag: "latest" }),
      ]);
      if (!alive || graduated) return;   // the tax applies to curve buys only
      const params = snipeParamsFor({ curveTail: tail == null ? 0 : tail });
      const launchTs = Number(launch);
      const offset = Number(block.timestamp) - Date.now() / 1000;   // follow the chain clock, not the device clock
      let liveFeeBps: number | null = fee == null ? null : Number(fee);
      const now = () => Date.now() / 1000 + offset;
      const step = () => { const s = snipeState({ launchTs, nowSec: now(), ...params, liveFeeBps }); if (alive) setState(s); if (!s.active) stop(); return s.active; };
      if (!step()) return;
      tick = window.setInterval(step, 1000);
      poll = window.setInterval(() => {
        pc.readContract({ ...c, functionName: "currentSnipeFeeBps" }).then((v) => { liveFeeBps = Number(v); step(); }).catch(() => { /* keep the last value */ });
      }, 2000);
    })().catch(() => { /* not a DISCIPLE curve / RPC down: no chip */ });
    return () => { alive = false; stop(); };
  }, [token]);
  return <SnipeChip state={state} />;
}
