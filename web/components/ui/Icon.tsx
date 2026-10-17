import type { CSSProperties } from "react";
import { withBase } from "@/lib/base-path";

/**
 * DISCIPLE icon set v1 (public/icons/v1, from disciple-brand/icons/v1). Uses the external sprite
 * (`sprite.svg#d-<name>`); stroke/fill = currentColor, so colour comes from CSS `color`.
 * Sizes 16 / 20 / 24 (24 native). `meter-orbs-N` is 40×16: pass width 40, size 16.
 */
export type IconName =
  | "boost" | "dump" | "rocket" | "tramp" | "wall" | "crew" | "pilot" | "base-pair" | "graduation" | "altitude"
  | "bomb" | "nuke" | "bomb-puff" | "bomb-grenade" | "bomb-bunker" | "bomb-cruise" | "bomb-nuke" | "bomb-atom"
  | `meter-orbs-${1 | 2 | 3 | 4 | 5 | 6}` | (string & {});

export const BOMB_ICON = ["bomb-puff", "bomb-grenade", "bomb-bunker", "bomb-cruise", "bomb-nuke", "bomb-atom"] as const;

export default function Icon({ name, size = 16, width, title, style, className }: { name: IconName; size?: number; width?: number; title?: string; style?: CSSProperties; className?: string }) {
  const w = width ?? (name.startsWith("meter-orbs-") ? (size * 40) / 16 : size);
  return (
    <svg width={w} height={size} className={className} role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}
      style={{ display: "inline-block", verticalAlign: "-0.15em", flex: "none", ...style }}>
      {title ? <title>{title}</title> : null}
      <use href={withBase(`/icons/v1/sprite.svg#d-${name}`)} />
    </svg>
  );
}

/** bomb tier (0 puff … 5 atom): tier icon + 6-orb meter */
export function BombTierIcons({ tier, size = 16 }: { tier: number; size?: number }) {
  const t = Math.max(0, Math.min(5, tier | 0));
  return <span data-bomb-tier={t} style={{ display: "inline-flex", alignItems: "center", gap: 3, verticalAlign: "-0.15em" }}>
    <Icon name={BOMB_ICON[t]} size={size} /><Icon name={`meter-orbs-${(t + 1) as 1 | 2 | 3 | 4 | 5 | 6}`} size={size} />
  </span>;
}
