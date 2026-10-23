/**
 * Holders of a rocket from its ERC-20 Transfer logs (pure; unit-tested by scripts/test-holders.mts).
 * Balances are a running sum of Transfer deltas from the coin's first Transfer (mint), so they equal balanceOf for a
 * plain ERC-20 (the rocket token has no rebasing / fee-on-transfer).
 */
export type HolderLabel = "pool" | "curve" | "locker" | null;
export type Holder = { address: string; balance: string; pct: number; usd: number | null; label: HolderLabel };
export type TransferDelta = { from: string; to: string; value: bigint };
const ZERO = "0x0000000000000000000000000000000000000000";

/** Apply Transfer logs (in chain order) to a balance map (lowercase address → raw balance string). Mints/burns skip 0x0. */
export function applyTransfers(bal: Record<string, string>, xs: TransferDelta[]): Record<string, string> {
  const add = (a: string, d: bigint) => {
    const k = a.toLowerCase();
    if (k === ZERO) return;
    const n = BigInt(bal[k] ?? "0") + d;
    if (n === BigInt(0)) delete bal[k]; else bal[k] = n.toString();
  };
  for (const x of xs) { if (x.value === BigInt(0)) continue; add(x.from, -x.value); add(x.to, x.value); }
  return bal;
}

/**
 * Top `limit` holders by balance (desc; ties by address). pct = balance / totalSupply × 100. usd = share of the current
 * market cap (balance / totalSupply × mcapUsd), null when the mcap is unknown. labels: lowercase address → label.
 */
export function rankHolders(bal: Record<string, string>, o: { totalSupply: bigint; mcapUsd: number | null; labels: Record<string, Exclude<HolderLabel, null>>; limit: number }): Holder[] {
  const sup = o.totalSupply > BigInt(0) ? o.totalSupply : BigInt(1);
  return Object.entries(bal)
    .map(([a, b]) => [a, BigInt(b)] as const)
    .filter(([, b]) => b > BigInt(0))
    .sort((x, y) => (x[1] === y[1] ? (x[0] < y[0] ? -1 : 1) : x[1] > y[1] ? -1 : 1))
    .slice(0, o.limit)
    .map(([address, b]) => {
      const share = Number((b * BigInt(1_000_000_000)) / sup) / 1e9; // 1e-9 resolution, no float overflow
      return { address, balance: b.toString(), pct: share * 100, usd: o.mcapUsd == null ? null : share * o.mcapUsd, label: o.labels[address] ?? null };
    });
}

export const clampHoldersLimit = (v: string | null) => Math.min(100, Math.max(1, Math.floor(Number(v)) || 50));
export const isAddr = (a: string | null): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);
