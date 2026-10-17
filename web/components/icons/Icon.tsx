import type { CSSProperties } from "react";
import type { IconName } from "./sprite";

export type { IconName } from "./sprite";
export type IconSize = 16 | 20 | 24 | number;
export type BombTier = 1 | 2 | 3 | 4 | 5 | 6;

type Props = {
  name: IconName;
  /** 16 / 20 / 24 (native). Larger is fine for display use. */
  size?: IconSize;
  /** Accessible name. Omit for decorative icons (rendered aria-hidden). */
  label?: string;
  className?: string;
  style?: CSSProperties;
};

/** DISCIPLE icons v1 (currentColor, 24px grid, 1.5px stroke). Needs <IconSprite /> mounted once. */
export default function Icon({ name, size = 20, label, className, style }: Props) {
  const meter = name.startsWith("meter-orbs-");
  const h = size;
  const w = meter ? (size * 40) / 16 : size;
  return (
    <svg width={w} height={h} className={className ? `d-icon ${className}` : "d-icon"}
      style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0, ...style }}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true, focusable: false })}>
      <use href={`#d-${name}`} />
    </svg>
  );
}

/** Bomb-tier orb meter (tier 1–6 = PUFF…ATOM), 40×16 at 16px height. */
export function OrbMeter({ tier, size = 16, label }: { tier: BombTier; size?: number; label?: string }) {
  return <Icon name={`meter-orbs-${tier}` as IconName} size={size} label={label ?? `bomb tier ${tier} of 6`} />;
}
