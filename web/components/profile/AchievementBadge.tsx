import Tooltip from "@/components/ui/Tooltip";
import type { AchievementDef } from "@/lib/achievements";
import { achievementDisplay, achievementIconPath, rarityStyle } from "@/lib/achievements";
import { withBase } from "@/lib/base-path";

/** Small square colored trophy badge (leaderboard rows, profile chips). */
export default function AchievementBadge({ a, size = 22 }: { a: AchievementDef; size?: number }) {
  const r = rarityStyle(a.rarity);
  const d = achievementDisplay(a.id);
  return (
    <Tooltip content={<><strong>{a.name} · {r.label}</strong>{a.description}</>}>
    <span
      className="ach-sq"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(150deg, ${d.color}cc, ${d.color}44)`,
        borderColor: r.border,
        boxShadow: `0 0 8px ${r.glow}`,
        fontSize: size * 0.55,
        padding: 0,
        overflow: "hidden",
      }}
      data-fallback={d.icon}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={withBase(achievementIconPath(a.id))} alt={a.name} width={size} height={size} style={{ display: "block", width: "100%", height: "100%" }} />
    </span>
    </Tooltip>
  );
}

export function EmptyBadge({ size = 22 }: { size?: number }) {
  return <span className="ach-sq empty" style={{ width: size, height: size }} aria-hidden="true" />;
}
