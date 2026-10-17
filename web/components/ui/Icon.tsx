import type { CSSProperties } from "react";
import BaseIcon from "@/components/icons/Icon";
import type { IconName as SpriteIconName } from "@/components/icons/sprite";

/**
 * GAME-facing alias of the single DISCIPLE <Icon> (components/icons/Icon, inline v1 + v1.1 sprite
 * mounted once via <IconSprite /> in the root layout). Keeps GAME's API: `title`, `width`, default size 16,
 * BOMB_ICON and <BombTierIcons>. stroke/fill = currentColor.
 */
export type IconName = SpriteIconName | (string & {});

export const BOMB_ICON = ["bomb-puff", "bomb-grenade", "bomb-bunker", "bomb-cruise", "bomb-nuke", "bomb-atom"] as const;

export default function Icon({ name, size = 16, width, title, style, className }: { name: IconName; size?: number; width?: number; title?: string; style?: CSSProperties; className?: string }) {
  const w = width ?? (name.startsWith("meter-orbs-") ? (size * 40) / 16 : size);
  return <BaseIcon name={name as SpriteIconName} size={size} label={title} className={className}
    style={{ verticalAlign: "-0.15em", flex: "none", ...(w !== size && !name.startsWith("meter-orbs-") ? { width: w } : {}), ...style }} />;
}

/** bomb tier (0 puff … 5 atom): tier icon + 6-orb meter */
export function BombTierIcons({ tier, size = 16 }: { tier: number; size?: number }) {
  const t = Math.max(0, Math.min(5, tier | 0));
  return <span data-bomb-tier={t} style={{ display: "inline-flex", alignItems: "center", gap: 3, verticalAlign: "-0.15em" }}>
    <Icon name={BOMB_ICON[t]} size={size} /><Icon name={`meter-orbs-${(t + 1) as 1 | 2 | 3 | 4 | 5 | 6}`} size={size} />
  </span>;
}
