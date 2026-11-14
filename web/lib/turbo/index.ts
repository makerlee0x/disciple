/**
 * TURBO entry point. Screens import from "@/lib/turbo" only.
 *
 * SEAM (issue #309 / PR #190): getTurboAdapter() is the only place that decides which adapter answers.
 *  - kind "practice"  → the stand-in (mockAdapter.ts): live Hyperliquid mid prices + stand-in fills. Today's default.
 *  - kind "nova-api"  → TODO when Nova hands over their API: add novaApiAdapter.ts implementing TurboAdapter.
 *  - kind "nova-sdk"  → TODO when Nova hands over their SDK: add novaSdkAdapter.ts implementing TurboAdapter.
 * Swap the adapter here; never rebuild the screens. No env var or Vercel flag picks the adapter today.
 *
 * iPhone app rule (maker 2026-11-14): the App Store build ships Turbo as practice duels with fake money only (App Review
 * 3.1.5(iv): crypto futures need a licensed firm). realTurboAllowed() is false inside the app, so when a Nova adapter
 * lands here it must stay behind that check; the app keeps the practice adapter. Server routes can tell the app by its
 * user agent (lib/native isNativeAppUa) and must not open real-money duels for it either.
 */
import type { TurboAdapter } from "./types";
import { createMockAdapter } from "./mockAdapter";
import { STAND_IN_PARAMS } from "./markets";
import { createHyperliquidPriceFeed, createHyperliquidStream, createHyperliquidTradeFeed } from "./priceFeed";
import { isNativeApp } from "../native";

/** Real-money Turbo (a Nova adapter) is never allowed inside the DISCIPLE iPhone app. */
export function realTurboAllowed(): boolean { return !isNativeApp(); }

export * from "./types";
export { isTurboEnabled, syncTurboFlagFromUrl, TURBO_FLAG_KEY } from "./flag";

let adapter: TurboAdapter | null = null;

export function getTurboAdapter(): TurboAdapter {
  if (!adapter) {
    // TODO(SITE, after Nova hands over access): if (realTurboAllowed()) adapter = createNovaApiAdapter({...}) or createNovaSdkAdapter({...}).
    // Inside the iPhone app it stays the practice adapter below (App Store rule, maker 2026-11-14).
    if (typeof window !== "undefined") {
      const stream = createHyperliquidStream();
      adapter = createMockAdapter({
        params: STAND_IN_PARAMS,
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
