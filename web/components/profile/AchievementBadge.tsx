import type { AchievementDef } from "@/lib/achievements";
import { achievementDisplay, rarityStyle } from "@/lib/achievements";

/** Small square colored trophy badge (leaderboard rows, profile chips). */
export default function AchievementBadge({ a, size = 22 }: { a: AchievementDef; size?: number }) {
  const r = rarityStyle(a.rarity);
  const d = achievementDisplay(a.id);
  return (
    <span
      className="ach-sq"
      title={`${a.name} · ${r.label} — ${a.description}`}
      style={{
        width: size,
        height: size,
        background: `linear-gradient(150deg, ${d.color}cc, ${d.color}44)`,
        borderColor: r.border,
        boxShadow: `0 0 8px ${r.glow}`,
        fontSize: size * 0.55,
      }}
    >
      {d.icon}
    </span>
  );
}

export function EmptyBadge({ size = 22 }: { size?: number }) {
  return <span className="ach-sq empty" style={{ width: size, height: size }} aria-hidden="true" />;
}
