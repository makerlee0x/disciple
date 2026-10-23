/**
 * Live sell sizing (Fix 4), pure ⇒ unit-tested in scripts/test-live-fixes.mjs. Used by components/TradeBridge.tsx.
 *
 * The balance a sell is sized from = a FRESH balanceOf of the trading account (the smart account), read right before
 * quoting (was the ≤5 s polled hint ⇒ a dump right after other activity sold a stale bag / "NO TOKENS"). Within 10 s of our
 * own trade an RPC node can still be a block behind: re-read once, and if it still disagrees with the receipt-bumped cache
 * (exact for our own fills) trust the cache.
 */
export async function freshSellBalance(read: () => Promise<bigint>, hint: () => Promise<bigint>, lastOwnTradeAt: number, now = Date.now(),
  wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<bigint> {
  const h = await hint().catch(() => BigInt(-1));
  let b = await read().catch(() => (h >= BigInt(0) ? h : BigInt(0)));
  if (h >= BigInt(0) && b !== h && now - lastOwnTradeAt < 10_000) {
    await wait(600);
    b = await read().catch(() => b);
    if (b !== h) b = h;
  }
  return b;
}
/** frac of a raw balance (1e-6 precision), same rounding everywhere so warmed sell quotes are cache hits. */
export const sellAmount = (bal: bigint, frac: number) => (bal * BigInt(Math.round(Math.min(1, frac) * 1e6))) / BigInt(1e6);
/** amountIn for a % / DUMP-ALL sell: all (or frac ≥ 1) = the whole real balance, no rounding dust left behind. */
export const sellAmountFor = (bal: bigint, o: { frac?: number; all?: boolean }) =>
  o.all || (o.frac !== undefined && o.frac >= 1) ? bal : o.frac && o.frac > 0 ? sellAmount(bal, o.frac) : BigInt(0);
