/**
 * TURBO entry point. Screens import from "@/lib/turbo" only.
 *
 * SEAM (issue #309 / PR #190): getTurboAdapter() is the only place that decides which adapter answers.
 *  - kind "practice"  → the stand-in (mockAdapter.ts): live Hyperliquid mid prices + stand-in fills. Today's default.
 *  - kind "nova-api"  → TODO when Nova hands over their API: add novaApiAdapter.ts implementing TurboAdapter.
 *  - kind "nova-sdk"  → TODO when Nova hands over their SDK: add novaSdkAdapter.ts implementing TurboAdapter.
 * Swap the adapter here; never rebuild the screens. No env var or Vercel flag picks the adapter today.
 */
import type { TurboAdapter } from "./types";
import { createMockAdapter } from "./mockAdapter";
import { createHyperliquidPriceFeed, createHyperliquidStream, createHyperliquidTradeFeed } from "./priceFeed";

export * from "./types";
export { isTurboEnabled, syncTurboFlagFromUrl, TURBO_FLAG_KEY } from "./flag";

let adapter: TurboAdapter | null = null;

export function getTurboAdapter(): TurboAdapter {
  if (!adapter) {
    // TODO(SITE, after Nova hands over access): adapter = createNovaApiAdapter({...}) or createNovaSdkAdapter({...}).
    if (typeof window !== "undefined") {
      const stream = createHyperliquidStream();
      adapter = createMockAdapter({
        priceFeed: createHyperliquidPriceFeed({ stream }),
        tradeFeed: createHyperliquidTradeFeed({ stream }),
      });
    } else {
      adapter = createMockAdapter();
    }
    // `next dev` only: lets local screenshot / QA scripts drive the stand-in (setPrice). Never in a production build.
    if (process.env.NODE_ENV === "development" && typeof window !== "undefined") (window as unknown as { __turboDev?: TurboAdapter }).__turboDev = adapter;
  }
  return adapter;
}

/** Tests / hot reload: drop or replace the singleton. */
export function resetTurboAdapter(next?: TurboAdapter): void {
  adapter = next ?? null;
}
