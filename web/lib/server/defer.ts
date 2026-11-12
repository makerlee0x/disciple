/**
 * Run work AFTER the response is sent, without losing it when the serverless instance freezes.
 * Next 14.2 has no after(); on Vercel we use the platform's request-context waitUntil — the same hook
 * @vercel/functions' waitUntil() reads (globalThis[Symbol.for("@vercel/request-context")].get().waitUntil), without
 * adding the dependency. Fallbacks, safest first:
 *  - on Vercel but no waitUntil in the context ⇒ AWAIT the task (old behaviour: slower, never loses a write);
 *  - elsewhere (next dev / next start / a long-lived Node relayer) ⇒ fire and forget (the process keeps running).
 * Pure (no server-only): unit-tested by scripts/test-trade-latency.mts.
 */
export type DeferMode = "waitUntil" | "await" | "background";
type Ctx = { waitUntil?: (p: Promise<unknown>) => void };
const SYM = Symbol.for("@vercel/request-context");

export function waitUntilFn(g: unknown = globalThis): ((p: Promise<unknown>) => void) | undefined {
  try {
    const c = (g as Record<symbol, { get?: () => Ctx | undefined } | undefined>)[SYM]?.get?.();
    return typeof c?.waitUntil === "function" ? c.waitUntil.bind(c) : undefined;
  } catch { return undefined; }
}

/** Schedule `task`. Resolves immediately unless it had to be awaited (mode "await"). Never throws. */
export async function afterResponse(task: () => Promise<unknown>, opts: { g?: unknown; onVercel?: boolean } = {}): Promise<DeferMode> {
  const run = () => Promise.resolve().then(task).catch(() => undefined);
  const wu = waitUntilFn(opts.g);
  if (wu) { wu(run()); return "waitUntil"; }
  if (opts.onVercel ?? !!process.env.VERCEL) { await run(); return "await"; }
  void run();
  return "background";
}
