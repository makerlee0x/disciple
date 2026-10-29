/**
 * Tooltip placement (components/ui/Tooltip). Pure, unit-tested by scripts/test-profile-one-page.mts.
 * Prefer `side` (top), flip to the other side when it doesn't fit, shift horizontally to stay `pad` px inside the
 * viewport; `arrow` = arrow x offset inside the tooltip, clamped away from the rounded corners.
 */
export type Rect = { left: number; top: number; width: number; height: number };
export function placeTooltip(t: Rect, tip: { width: number; height: number }, vp: { width: number; height: number }, side: "top" | "bottom" = "top", gap = 8, pad = 8) {
  const above = t.top - gap - tip.height, below = t.top + t.height + gap;
  let s = side;
  if (s === "top" && above < pad && below + tip.height <= vp.height - pad) s = "bottom";
  else if (s === "bottom" && below + tip.height > vp.height - pad && above >= pad) s = "top";
  const y = s === "top" ? above : below;
  const cx = t.left + t.width / 2;
  const x = Math.max(pad, Math.min(cx - tip.width / 2, vp.width - pad - tip.width));
  const arrow = Math.max(12, Math.min(cx - x, tip.width - 12));
  return { x: Math.round(x), y: Math.round(y), arrow: Math.round(arrow), side: s };
}
