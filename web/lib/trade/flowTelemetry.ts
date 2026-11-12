/** Log-only, untrusted client measurements. Never serialize caller-supplied objects. */
export const FLOW_FIELDS = ["tapToPaint", "tapToRequestStart", "tapToFirstByte", "tapToPendingFrame", "tapToConfirmedFrame", "tapToApplyOwnStart", "tapToApplyOwnEnd", "tapToDoneRender"] as const;
export function cleanFlowTelemetry(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 3 || typeof v.pressId !== "string" || !/^(?:press-[a-z0-9]{1,16}-[0-9]{1,8}|[a-f0-9]{24})$/.test(v.pressId) || (v.side !== "buy" && v.side !== "sell") || typeof v.ok !== "boolean") return null;
  const row: Record<string, unknown> = { source: "client-untrusted", version: 3, pressId: v.pressId, side: v.side, ok: v.ok };
  for (const field of FLOW_FIELDS) {
    const n = v[field];
    if (n !== null && (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 300_000)) return null;
    row[field] = n;
  }
  if (typeof row.tapToDoneRender !== "number") return null;
  const raw = v.cache as Record<string, { hit?: unknown; miss?: unknown }> | undefined;
  const cache: Record<string, { hit: number; miss: number }> = {};
  for (const kind of ["quote", "balance", "allowance"]) {
    const hit = raw?.[kind]?.hit, miss = raw?.[kind]?.miss;
    if (typeof hit !== "number" || typeof miss !== "number" || !Number.isInteger(hit) || !Number.isInteger(miss) || hit < 0 || miss < 0 || hit > 1024 || miss > 1024) return null;
    cache[kind] = { hit, miss };
  }
  return { ...row, cache, paintBoundary: "terminal-commit-plus-double-raf", firstByteBoundary: "fetch-response-headers" };
}
