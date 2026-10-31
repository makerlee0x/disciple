/* game/hud-sidebar-layout: the closed-chat CHAT pill defaults to right:344 / bottom:20 (left of the right HUD column).
 * When the canvas is narrow (sidebar open) that lands on the bottom trade bar (canvas "controls" card), so slide it just
 * right of the bar; if there is no room there, lift it above the bar. All rects in viewport px. Pure: test-hud-layout. */
export type Box = { x: number; y: number; w: number; h: number };
export function chatPillPlace(vw: number, vh: number, pillW: number, pillH: number, bar: Box | null): { right: number; bottom: number } {
  const def = { right: 344, bottom: 20 };
  if (!bar || !(bar.w > 0)) return def;
  const px = vw - def.right - pillW, py = vh - def.bottom - pillH;
  const hit = px < bar.x + bar.w && bar.x < px + pillW && py < bar.y + bar.h && bar.y < py + pillH;
  if (!hit) return def;
  const left = bar.x + bar.w + 12;
  if (left + pillW <= vw - 20) { const right = Math.round(vw - left - pillW); if (right <= def.right) return { right, bottom: def.bottom }; }
  return { right: def.right, bottom: Math.round(vh - bar.y + 10) };
}
