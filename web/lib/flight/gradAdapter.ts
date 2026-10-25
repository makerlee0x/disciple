/**
 * GAME-side adapter over SITE's graduation helpers (#157, lib/trade/gradNeed + lib/protocol-viem). Read-only.
 *   - liveMaxImpactBps: DiscipleRouter.maxImpactBps via readRouterMaxImpactBps (cached 60 s by SITE). This IS the live limit
 *     (the router passes it into the curve; 100000 bps since FLOW raised it at 7:10 PM CT 2026-10-24). 0 / unreadable = no cap.
 *   - graduationNeedUsd: the tier bar's "$X to graduate" = readGradNeedForToken().usdgIn rounded up to the cent. Label only
 *     (no GRADUATE button, lee 7:56 PM CT). null ⇒ graduated / not routable / read failed ⇒ the engine keeps its estimate.
 */
import type { Address } from "viem";
import { hasRouter, deployment } from "@/lib/chains";
import { publicClient, readGradNeedForToken, readRouterMaxImpactBps } from "@/lib/protocol-viem";
import { needUsdFromUsdg } from "./tradeGate";

export async function liveMaxImpactBps(): Promise<number> {
  if (!hasRouter()) return 0;
  try { const v = await readRouterMaxImpactBps(publicClient()); return Number.isFinite(v) && v > 0 ? v : 0; } catch { return 0; }
}

export async function graduationNeedUsd(token: string): Promise<number | null> {
  try {
    const n = await readGradNeedForToken(publicClient(), token as Address);
    if (n.graduated || n.usdgIn == null || n.usdgIn <= BigInt(0)) return null;
    return needUsdFromUsdg(n.usdgIn, deployment().usdgDecimals);
  } catch { return null; }
}
