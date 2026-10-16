import "server-only";
import type { Address } from "viem";
import { pnlFromFills, type PositionPnl } from "@/lib/sharePnl";
import { tradesOf } from "../trades";
import { serverPc } from "../chat/identity";
import { readCurveState } from "@/lib/protocol-viem";

/** Current $ mcap (MarketLens post-grad, curve pre-grad); null if unreadable. */
export async function currentMcap(coin: string): Promise<number | null> {
  try { return (await readCurveState(serverPc() as never, coin as Address)).mcapUsd; } catch { return null; }
}

/** PnL for one wallet's position in one coin; the end point is "now" for open positions. */
export async function pnlForPosition(wallet: string, coin: string, now = Date.now()): Promise<PositionPnl> {
  const [fills, mcap] = await Promise.all([tradesOf(coin, wallet), currentMcap(coin)]);
  return pnlFromFills(wallet.toLowerCase(), coin.toLowerCase(), fills, mcap, now);
}
