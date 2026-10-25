/**
 * TURBO entry point. GAME imports from "@/lib/turbo" only.
 *
 * SEAM: getTurboAdapter() returns the practice/mock adapter today. When nova ships an SDK or API, add
 * `novaSdkAdapter.ts` or `novaApiAdapter.ts` implementing TurboAdapter (see README.md) and pick it here — e.g. behind
 * a flag — without changing any screen code. Never point this at real money without lee's OK.
 */
import type { TurboAdapter } from "./types";
import { createMockAdapter } from "./mockAdapter";

export * from "./types";
export { isTurboEnabled, syncTurboFlagFromUrl, TURBO_FLAG_KEY } from "./flag";

let adapter: TurboAdapter | null = null;

export function getTurboAdapter(): TurboAdapter {
  if (!adapter) {
    // TODO(SITE): choose the real adapter here once nova's SDK/API is known, e.g.
    //   adapter = useRealNova ? createNovaApiAdapter({ ... }) : createMockAdapter();
    adapter = createMockAdapter();
  }
  return adapter;
}

/** Tests / hot reload: drop the singleton. */
export function resetTurboAdapter(next?: TurboAdapter): void {
  adapter = next ?? null;
}
