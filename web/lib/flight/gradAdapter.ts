/**
 * GAME-side adapter over SITE's graduation helpers (#157, lib/trade/gradNeed + lib/protocol-viem). Read-only.
 *   - liveMaxImpactBps: DiscipleRouter.maxImpactBps via readRouterMaxImpactBps (cached 60 s by SITE). This IS the live limit
 *     (the router passes it into the curve; 100000 bps since FLOW raised it at 7:10 PM CT 2026-10-24). 0 / unreadable = no cap.
 *   - graduationStatus: { graduated, usd } from readGradNeedForToken — usd = the tier bar's "$X to graduate" (usdgIn rounded
 *     up to the cent; label only, no GRADUATE button, lee 7:56 PM CT); graduated drives the HUD's GRADUATED badge.
 *     null ⇒ read failed (the engine keeps its last state).
 */
import type { Address } from "viem";
import { hasRouter, deployment } from "@/lib/chains";
import { publicClient, readGradNeedForToken, readRouterMaxImpactBps } from "@/lib/protocol-viem";
import { needUsdFromUsdg } from "./tradeGate";

export async function liveMaxImpactBps(): Promise<number> {
  if (!hasRouter()) return 0;
  try { const v = await readRouterMaxImpactBps(publicClient()); return Number.isFinite(v) && v > 0 ? v : 0; } catch { return 0; }
}

/** One curve read for the HUD: graduated flag + exact $ left (null when graduated / unroutable). null = read failed (keep last). */
export async function graduationStatus(token: string): Promise<{ graduated: boolean; usd: number | null } | null> {
  try {
    const n = await readGradNeedForToken(publicClient(), token as Address);
    if (n.graduated) return { graduated: true, usd: null };
    return { graduated: false, usd: n.usdgIn == null || n.usdgIn <= BigInt(0) ? null : needUsdFromUsdg(n.usdgIn, deployment().usdgDecimals) };
  } catch { return null; }
}
