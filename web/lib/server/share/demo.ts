import type { Fill } from "@/lib/trades";
/** Deterministic sample position (sample-mode profiles / previews), scaled so it ends at `endMcap`. Stamped SAMPLE. */
export function demoFills(wallet: string, coin: string, now = Date.now(), endMcap = DEMO_MCAP): Fill[] {
  const t0 = now - 3 * 86400_000, k = endMcap / DEMO_MCAP;
  const mk = (i: number, side: "buy" | "sell", usd: number, mcap: number, dt: number): Fill => {
    const m = Math.max(7000, mcap * k);
    return { id: `demo:${i}`, tx: "0xdemo", logIndex: i, block: i, ts: t0 + dt, coin, trader: wallet, side, venue: "curve",
      tokens: (side === "buy" ? usd * 0.99 : usd) / (m / 7e9), usd, priceUsd: m / 7e9, mcapUsd: m };
  };
  return [mk(1, "buy", 250, 41_000, 0), mk(2, "buy", 400, 88_000, 9 * 3.6e6), mk(3, "sell", 300, 210_000, 30 * 3.6e6), mk(4, "buy", 150, 160_000, 44 * 3.6e6)];
}
export const DEMO_MCAP = 386_000;
