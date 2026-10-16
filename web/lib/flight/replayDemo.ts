/** Synthetic trade list for the /dev/replay demo and the replay determinism test. */
export type ReplayTrade = { ts: number; tx: string; li: number; side: "buy" | "sell"; usd: number; mcapUsd: number; impactBps: number; trader: string; mine: boolean };
/** Synthetic launch: $7K → past graduation with a few whale sells, 2 of the trades are "mine". Deterministic per seed. */
export function demoTrades(seed = 7): { trades: ReplayTrade[]; t0: number; t1: number; startMcap: number } {
  let a = seed >>> 0 || 1; const rnd = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const t0 = 1_760_000_000_000, n = 70, trades: ReplayTrade[] = []; let m = 7000;
  for (let i = 0; i < n; i++) {
    const sell = rnd() < (i > 40 ? 0.38 : 0.22), whale = rnd() < 0.08, usd = +(sell ? (whale ? 900 : 40 + rnd() * 220) : (whale ? 1400 : 30 + rnd() * 400)).toFixed(2);
    const depth = m * 0.25, f = usd / depth, pre = m; m = Math.max(6000, sell ? m / Math.pow(1 + f, 2) : m * Math.pow(1 + f * 0.99, 2));
    trades.push({ ts: t0 + i * 9000 + Math.floor(rnd() * 4000), tx: "0x" + (i + 1).toString(16).padStart(8, "0"), li: 0, side: sell ? "sell" : "buy", usd, mcapUsd: +m.toFixed(2),
      impactBps: Math.round(Math.abs(m / pre - 1) * 10_000), trader: "0x" + Math.floor(rnd() * 0xffffff).toString(16).padStart(6, "0") + "…", mine: i === 12 || i === 55 });
  }
  return { trades, t0, t1: trades[n - 1].ts + 2000, startMcap: 7000 };
}

