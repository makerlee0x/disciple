import { toHex, type Hex } from "viem";
import type { UserOp } from "./core";

/** 15% precautionary headroom, rounded UP. Observed Orbit DA gas was zero, not evidence
 * of a measured 15% swing. Covers byte/fee changes between estimation and inclusion;
 * it is NOT proof that low PVG caused the unmined Production setups. Chain-independent.
 * 61,044 -> 70,201. RPC failure/invalid result -> max(estimate, 60,000) * 1.15 = >=69,000.
 * The floor is a fallback, never a replacement for a larger measured requirement. */
export const PVG_BUFFER_PERCENT = 15n;
export const PVG_FALLBACK_FLOOR = 60_000n;
export function bufferedPvg(estimate?: bigint | Hex | number): bigint {
  let base = PVG_FALLBACK_FLOOR;
  try { const measured = estimate == null ? 0n : BigInt(estimate); if (measured > base) base = measured; } catch { /* invalid RPC result: floor */ }
  return (base * (100n + PVG_BUFFER_PERCENT) + 99n) / 100n;
}
/** All other gas bounds/PM fields stay present. Nonzero PVG is echoed by Rundler, not
 * measured. Use only the supported estimate method; no debug endpoint/key access. */
export async function measurePvg(op: UserOp, estimate: (op: UserOp) => Promise<{ preVerificationGas?: bigint | Hex | number }>): Promise<bigint> {
  try {
    const result = await estimate({ ...op, preVerificationGas: toHex(0n) });
    return bufferedPvg(result.preVerificationGas);
  } catch { return bufferedPvg(); }
}
