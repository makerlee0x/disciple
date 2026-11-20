import { CLIMB_HREF, DUEL_HREF, ROYALE_ENABLED } from "@/lib/features";
import { DUEL_RANKED_LIVE } from "@/lib/duel/season";
import type { TurboModeCard } from "./TurboView";

/** The Turbo page's play cards (they replace the Turbo nav menu). Royale only while ROYALE_ENABLED (held for launch). */
export const TURBO_PAGE_MODES: readonly TurboModeCard[] = [
  { id: "duel", title: "Duel", tag: DUEL_RANKED_LIVE ? "Ranked" : "1v1", art: "/art/modes/duel.webp", href: DUEL_HREF, tone: "#FF9CC4" },
  { id: "climb", title: "Climb", tag: "Solo", art: "/art/modes/live.webp", href: CLIMB_HREF, tone: "#5FF0A0" },
  ...(ROYALE_ENABLED ? [{ id: "royale", title: "Royale", tag: "Practice", art: "/art/modes/last-pilot.webp", href: "/turbo/royale", tone: "#8FE3FF" }] : []),
];
