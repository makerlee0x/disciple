/**
 * Which outgoing token transfers are a trade's own leg (pure; tested in scripts/test-xp.mts).
 *
 * The XP transfer scan (lib/server/achievements transfersOut) counts tokens a wallet sends away as leaving its position, so
 * moving tokens to another wallet can't keep a hold mission alive. A sell moves the wallet's tokens to the curve / pool in
 * the same tx as its fill, and that leg must not count twice. But a smart account can batch more than one call into a
 * single tx (buy, then transfer away), so "this tx has a trade" is not enough to ignore a transfer: only the sell legs are
 * skipped, up to the tokens the wallet's own sell fills in that tx moved. A buy moves no tokens out of the wallet, so in a
 * buy-only tx every outgoing transfer counts.
 */
export type OutLog = { tx: string; logIndex: number; tokens: number };

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-12, Math.abs(b) * 1e-6);

/**
 * `logs`: the wallet's outgoing non-zero transfers of one coin. `sells`: per tx (lower-case hash), the token amounts of
 * the wallet's sell fills in that tx. Returns the logs that are NOT a sell's own leg.
 * Exact matches first (one transfer per sell fill), then any split leg greedily up to what is left of the sells' total;
 * everything past that is a transfer away.
 */
export function nonTradeOuts<T extends OutLog>(logs: readonly T[], sells: ReadonlyMap<string, readonly number[]>): T[] {
  const byTx = new Map<string, T[]>();
  for (const l of logs) { const k = l.tx.toLowerCase(); (byTx.get(k) ?? byTx.set(k, []).get(k)!).push(l); }
  const legsOf = new Set<T>();
  for (const [tx, group] of Array.from(byTx.entries())) {
    const legs = (sells.get(tx) ?? []).filter((v) => v > 0);
    if (!legs.length) continue;
    const g = group.slice().sort((a, b) => a.logIndex - b.logIndex), used = new Set<T>();
    let left = 0;
    for (const s of legs) { const m = g.find((l) => !used.has(l) && close(l.tokens, s)); if (m) used.add(m); else left += s; }
    for (const l of g) { if (used.has(l) || left <= 0) continue; if (l.tokens <= left + Math.max(1e-12, left * 1e-6)) { used.add(l); left -= l.tokens; } }
    used.forEach((l) => legsOf.add(l));
  }
  return logs.filter((l) => !legsOf.has(l));
}

/** Coins traded within this window are always scanned (they can still move any mission this or last week). */
export const RECENT_SCAN_MS = 8 * 86_400_000;

/**
 * Coins the transfer scan must cover (pure; tested in scripts/test-xp.mts): every coin traded in the last 8 days, plus
 * every coin the wallet's fills alone still show tokens in, however long ago it last traded. Holding missions (orbit
 * seat, 24h hold, tier ride, bomb) read the position from fills minus transfers away; if a dormant coin were left out of
 * the scan, a wallet that sent its tokens away and waited would still look aboard when the rocket reaches orbit.
 */
export function coinsToScan(fills: readonly { coin: string; ts: number; side: string; tokens: number }[], now: number): string[] {
  const out = new Set<string>(), net = new Map<string, number>();
  for (const f of fills) {
    const c = f.coin.toLowerCase();
    if (now - f.ts <= RECENT_SCAN_MS) out.add(c);
    net.set(c, (net.get(c) ?? 0) + (f.side === "buy" ? f.tokens : -f.tokens));
  }
  for (const [c, t] of Array.from(net.entries())) if (t > 1e-9) out.add(c);
  return Array.from(out);
}
