/**
 * Coin page stats strip (maker 2026-11-18, the DEX-site row): price, 24H change, 24H volume, liquidity, holders.
 * Pure helpers shared by the server reader (lib/server/coinStats) and the strip (components/flight/CoinStats). Tested.
 */
export type CoinStats = { coin: string; mcapUsd: number | null; priceUsd: number | null; change24hPct: number | null; vol24hUsd: number; liquidityUsd: number | null; holders: number | null; at: number };

type FillLite = { ts: number; mcapUsd: number; side: "buy" | "sell"; usd: number; usdIn?: number; usdOut?: number };
const fillUsd = (f: FillLite) => { const v = f.side === "sell" ? (f.usdOut ?? f.usd) : (f.usdIn ?? f.usd); return Number.isFinite(v) && v > 0 ? v : 0; };

/**
 * 24H volume (sum of fill $ in the last day) and change (now vs the last fill at or before 24 h ago; a coin younger than a
 * day compares with its first fill). `fills` in any order; `nowMcap` = the live mcap when known.
 */
export function dayWindow(fills: FillLite[], now: number, nowMcap?: number | null): { vol24hUsd: number; change24hPct: number | null } {
  const cut = now - 86_400_000, fs = fills.filter((f) => Number.isFinite(f.ts) && f.mcapUsd > 0).sort((a, b) => a.ts - b.ts);
  let vol = 0, before: number | null = null;
  for (const f of fs) { if (f.ts <= cut) before = f.mcapUsd; else vol += fillUsd(f); }
  const last = nowMcap && nowMcap > 0 ? nowMcap : fs.length ? fs[fs.length - 1].mcapUsd : null;
  const base = before ?? (fs.length ? fs[0].mcapUsd : null);
  const change = last != null && base != null && base > 0 && fs.length ? (last / base - 1) * 100 : null;
  return { vol24hUsd: Math.round(vol * 100) / 100, change24hPct: change };
}

/**
 * Raw token amounts (a0 = currency0, a1 = currency1) of a v4 position at the current price. sqrtP = √(currency1 per
 * currency0, raw units); tick bounds → √price = 1.0001^(tick/2). Floats: display only.
 */
export function positionAmounts(liquidity: number, tickLower: number, tickUpper: number, sqrtP: number): { a0: number; a1: number } {
  if (!(liquidity > 0) || !(sqrtP > 0) || tickUpper <= tickLower) return { a0: 0, a1: 0 };
  const sa = Math.pow(1.0001, tickLower / 2), sb = Math.pow(1.0001, tickUpper / 2), sp = Math.min(Math.max(sqrtP, sa), sb);
  return { a0: liquidity * (1 / sp - 1 / sb), a1: liquidity * (sp - sa) };
}

/** "$0.000816" style: 3 significant digits under $1, cents from $1 up. */
export function fmtPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v <= 0) return "—";
  if (v >= 1) return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const d = Math.min(12, Math.max(2, 2 - Math.floor(Math.log10(v))));
  return "$" + v.toFixed(d).replace(/(\.\d*?[1-9])0+$/, "$1");
}
/** "$813.4K", "$935.2K", "$1.2M", "$73" */
export function fmtUsdShort(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v < 0) return "—";
  const f = (n: number, s: string) => `$${n >= 100 ? n.toFixed(0) : n.toFixed(1).replace(/\.0$/, "")}${s}`;
  return v >= 1e9 ? f(v / 1e9, "B") : v >= 1e6 ? f(v / 1e6, "M") : v >= 1e3 ? f(v / 1e3, "K") : `$${Math.round(v)}`;
}
/** "9K", "1.2K", "312" */
export function fmtCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "—";
  return n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K` : String(Math.round(n));
}
