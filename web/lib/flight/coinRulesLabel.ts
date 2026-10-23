/** Pure label helpers for the TIER line's mode + wallet cap (no imports: unit-tested by scripts/test-fix-batch.mjs). */
/** Player-facing mode names (Easy = PVE, Hard = PVP). */
export const MODE_NAME: Record<number, string> = { 0: "TRENCH", 1: "EASY", 2: "HARD" };   // BondingCurve.mode(): 0 TRENCH, 1 PVE, 2 PVP

/** type(uint256).max = "no cap" from netCapNow() */
export const UINT_MAX = (BigInt(1) << BigInt(256)) - BigInt(1);

/** netCapNow (token wei) + totalSupply (token wei) → cap in bps of supply, or null = no cap. */
export function capBpsOf(netCap: bigint, totalSupply: bigint): number | null {
  if (netCap >= UINT_MAX || totalSupply <= BigInt(0) || netCap >= totalSupply) return null;
  return Number((netCap * BigInt(1_000_000)) / totalSupply) / 100;   // bps with 2 decimals (3.33% = 333 bps, 7.77% = 777)
}

/** "1%", "3.33%", "0.25%" — at most 2 decimals, no trailing zeros. */
export function fmtCapPct(bps: number): string {
  return `${+(bps / 100).toFixed(2)}%`;
}

/** "TRENCH · no cap" / "EASY · cap 1%" / "HARD · cap 3.33%". */
export function rulesLabel(mode: number, capBps: number | null): string {
  const name = MODE_NAME[mode] ?? `MODE ${mode}`;
  return `${name} · ${capBps == null ? "no cap" : `cap ${fmtCapPct(capBps)}`}`;
}
