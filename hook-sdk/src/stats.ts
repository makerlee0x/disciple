// Trade decoding and turnover (volume / pool value), the headline number for a pool that separates price from depth.
import { decodeEventLog, type Hex } from "viem";
import { discipleHookAbi } from "./abi.ts";

export interface Swap {
  id: Hex;
  sender: Hex;
  /** pool view: + = into the pool */
  amount0: bigint;
  amount1: bigint;
  fee0: bigint;
  fee1: bigint;
}

/** Decode a HookSwap log, or null for any other event. */
export function decodeSwap(log: { data: Hex; topics: readonly Hex[] }): Swap | null {
  try {
    const ev = decodeEventLog({ abi: discipleHookAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    if (ev.eventName !== "HookSwap") return null;
    const a = ev.args;
    return { id: a.id, sender: a.sender, amount0: a.amount0, amount1: a.amount1, fee0: a.hookLPfeeAmount0, fee1: a.hookLPfeeAmount1 };
  } catch {
    return null;
  }
}

export interface Turnover {
  volume: number;
  days: number;
  poolValue: number;
  /** volume / pool value over the whole window */
  turnover: number;
  /** turnover per day */
  perDay: number;
}

/**
 * Turnover over a window. `volume` and `poolValue` in the same unit (e.g. USD); `poolValue` is the pool's value now
 * (or the window's average if you have it). Fees are not part of it: this is how hard each dollar of depth works.
 */
export function turnover(volume: number, poolValue: number, days: number): Turnover {
  const t = poolValue > 0 ? volume / poolValue : 0;
  return { volume, days, poolValue, turnover: t, perDay: days > 0 ? t / days : 0 };
}
