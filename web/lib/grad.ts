/**
 * Client side of a coin's graduation state (lib/protocol GradState) — GET /api/coin/grad, parsed defensively.
 * Pure parse is unit-tested (scripts/test-grad.mts).
 */
import type { GradState } from "./protocol";

const POOL_ID = /^0x[0-9a-fA-F]{64}$/;

/** API JSON → GradState; null if it isn't one. A non-graduated coin never carries a poolId / graduatedAt. */
export function parseGrad(j: unknown): GradState | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  if (typeof o.graduated !== "boolean") return null;
  if (!o.graduated) return { graduated: false, poolId: null, graduatedAt: null };
  return {
    graduated: true,
    poolId: typeof o.poolId === "string" && POOL_ID.test(o.poolId) ? (o.poolId.toLowerCase() as `0x${string}`) : null,
    graduatedAt: typeof o.graduatedAt === "number" && Number.isFinite(o.graduatedAt) && o.graduatedAt > 0 ? Math.floor(o.graduatedAt) : null,
  };
}

/** GET /api/coin/grad?coin= → GradState, or null when the API is unreachable / errors (caller falls back to the curve read). */
export async function fetchGrad(coin: string, f: typeof fetch = fetch): Promise<GradState | null> {
  try {
    const r = await f(`/api/coin/grad?coin=${coin}`);
    return r.ok ? parseGrad(await r.json()) : null;
  } catch { return null; }
}
