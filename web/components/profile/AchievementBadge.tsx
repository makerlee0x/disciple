import Tooltip from "@/components/ui/Tooltip";
import { achievementIconPath, rarityStyle, type MilestoneBadge } from "@/lib/achievements";
import { withBase } from "@/lib/base-path";

/** Small square colored trophy badge (leaderboard rows, profile chips). */
export default function AchievementBadge({ a, size = 22 }: { a: MilestoneBadge; size?: number }) {
  const r = rarityStyle(a.rarity);
  return (
    <Tooltip content={<><strong>{a.name} · {r.label}</strong>{a.description}</>}>
    <span
      className="ach-sq"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(150deg, ${r.border}, ${r.glow})`,
        borderColor: r.border,
        boxShadow: `0 0 8px ${r.glow}`,
        fontSize: size * 0.55,
        padding: 0,
        overflow: "hidden",
      }}
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
