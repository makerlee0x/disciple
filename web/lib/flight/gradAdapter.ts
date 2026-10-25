/**
 * GAME-side adapter over SITE's graduation helpers (PR #157, lib/trade/gradNeed + lib/protocol-viem). Read-only; only the
 * GAME UI shapes live here (the pure maths is in lib/flight/tradeGate).
 *   - liveMaxImpactBps: DiscipleRouter.maxImpactBps via readRouterMaxImpactBps (cached 60 s by SITE). This IS the live limit
 *     (the router passes it into the curve; 100000 bps since FLOW raised it at 7:10 PM CT 2026-10-24). 0 / unreadable = no cap.
 *   - graduateBuyUsd: $ for GRADUATE · $X = readGradNeedForToken().usdgIn (USDG through the router, already +0.1% by SITE),
 *     rounded up to the cent, $0.20 floor. NO withGradMargin: that 0.5% is only SITE's "graduates?" classifier tolerance, not
 *     spend (SITE 7:42 PM CT; the relay still classifies an overshooting buy as graduating). null ⇒ graduated / not routable /
 *     read failed ⇒ GRADUATE is hidden.
 */
import type { Address } from "viem";
import { hasRouter, deployment } from "@/lib/chains";
import { publicClient, readGradNeedForToken, readRouterMaxImpactBps } from "@/lib/protocol-viem";
import { graduateUsdFromUsdg } from "./tradeGate";

export async function liveMaxImpactBps(): Promise<number> {
  if (!hasRouter()) return 0;
  try { const v = await readRouterMaxImpactBps(publicClient()); return Number.isFinite(v) && v > 0 ? v : 0; } catch { return 0; }
}

export async function graduateBuyUsd(token: string): Promise<number | null> {
  try {
    const n = await readGradNeedForToken(publicClient(), token as Address);
    if (n.graduated || n.usdgIn == null || n.usdgIn <= BigInt(0)) return null;
    return graduateUsdFromUsdg(n.usdgIn, deployment().usdgDecimals);
  } catch { return null; }
}
