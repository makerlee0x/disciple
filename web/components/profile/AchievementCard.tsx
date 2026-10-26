import { achievementIconPath, rarityStyle, rewardPreview, type AchievementView } from "@/lib/achievements";
import { withBase } from "@/lib/base-path";
import Icon from "@/components/icons/Icon";

/** One achievement (loot) card: rarity frame, name, description, progress, reward. Achievements page. */
export default function AchievementCard({ a }: { a: AchievementView }) {
  const rarity = rarityStyle(a.rarity);
  return (
    <article className={`ach-card state-${a.state}`}
      style={{ borderColor: rarity.border, boxShadow: a.state === "unlocked" ? `0 0 24px ${rarity.glow}` : undefined }}>
      <div className="ach-frame" style={{ borderColor: rarity.border }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="ach-svg" src={withBase(achievementIconPath(a.id))} alt="" width={60} height={60} />
        {a.state === "locked" && <span className="ach-lock" aria-label="locked"><Icon name="lock" size={16} /></span>}
      </div>
      <div className="ach-body">
        <div className="ach-rarity" style={{ color: rarity.border }}>{rarity.label}</div>
        <h3>{a.name}</h3>
        <p>{a.description}</p>
        <div className="ach-progress">
          <div className="ach-bar"><div style={{ width: `${a.pct}%`, background: rarity.border }} /></div>
          <span>{a.current}/{a.target}</span>
        </div>
        <div className="ach-reward">Reward: {rewardPreview(a)}</div>
      </div>
    </article>
  );
}
