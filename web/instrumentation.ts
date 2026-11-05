/**
 * Fail closed at server startup when shared KV is required but missing (audit mainnet-prep).
 * Skips during `next build` via requiresSharedKv()'s NEXT_PHASE check.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") return;
  const { kv, requiresSharedKv } = await import("./lib/server/kv");
  if (!requiresSharedKv()) return;
  kv(); // throws with a clear message if UPSTASH/KV env is absent
}
