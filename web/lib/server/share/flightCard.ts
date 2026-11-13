import "server-only";
/** The flight log parts of the share card (approved mockup "Flight log share card", maker Nov 13): stats + difficulty badge. */
import type { SceneData } from "@/lib/share/scene";
import type { PositionPnl } from "@/lib/sharePnl";
import { flightLogFor, SHARE_LOG_MAX_MS } from "@/lib/server/flightLog";
import { ACH } from "@/lib/server/achKeys";
import { kv } from "@/lib/server/kv";

const BADGE: Record<number, { text: string; color: string }> = { 0: { text: "EXPERT", color: "#F0307F" }, 1: { text: "EASY", color: "#5FF0A0" }, 2: { text: "HARD", color: "#FF7A3D" } };
export const ORBIT_BADGE = { text: "IN ORBIT", color: "#F3DFA8" };
/** dev SAMPLE card only: the mockup's numbers */
export const SAMPLE_LOG: NonNullable<SceneData["log"]> = { peakMcap: null, bombsSurvived: 2, wingmen: 7, slingshots: 3, xp: 130 };

export async function flightCardParts(wallet: string, coin: string, pnl: PositionPnl, at: number): Promise<Pick<SceneData, "log" | "badge">> {
  const s = kv();
  const [log, metaRaw] = await Promise.all([
    pnl.kind === "none" ? null : flightLogFor(wallet, coin, pnl.startTs || at, pnl.endTs || at, s, SHARE_LOG_MAX_MS).catch(() => null),
    s.get(ACH.coin(coin.toLowerCase())).catch(() => null),
  ]);
  let badge: SceneData["badge"] = null;
  try {
    const m = metaRaw ? (JSON.parse(metaRaw) as { mode?: number; grad?: unknown }) : null;
    badge = m?.grad ? ORBIT_BADGE : m && typeof m.mode === "number" ? BADGE[m.mode] ?? null : null;
  } catch { /* no meta */ }
  return { log: log ? { peakMcap: log.peakMcap, bombsSurvived: log.bombsSurvived, wingmen: log.wingmen, slingshots: log.slingshots, xp: log.xp } : null, badge };
}
