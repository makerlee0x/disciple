/* game/hud-sidebar-layout: the closed-chat CHAT pill defaults to right:344 / bottom:20 (left of the right HUD column).
 * When the content area is narrow (sidebar open) that lands on the bottom trade bar (DOM [data-testid=trade-bar], or the
 * canvas controls card when undocked). Then slide it just right of the bottom obstacles; if there is no room, lift it
 * above them. All rects in viewport px. Pure: scripts/test-chat-pill.mts. */
export type Box = { x: number; y: number; w: number; h: number };
const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
export function chatPillPlace(vw: number, vh: number, pillW: number, pillH: number, obstacles: (Box | null | undefined)[]): { right: number; bottom: number } {
  const def = { right: 344, bottom: 20 };
  const obs = obstacles.filter((b): b is Box => !!b && b.w > 0 && b.h > 0);
  const at = (p: { right: number; bottom: number }): Box => ({ x: vw - p.right - pillW, y: vh - p.bottom - pillH, w: pillW, h: pillH });
  const free = (p: { right: number; bottom: number }) => !obs.some((b) => hit(at(p), b));
  if (free(def)) return def;
  const band = obs.filter((b) => b.y < vh - def.bottom && b.y + b.h > vh - def.bottom - pillH);
  const left = Math.max(...band.map((b) => b.x + b.w)) + 12;
  const slid = { right: Math.round(vw - left - pillW), bottom: def.bottom };
  if (band.length && slid.right >= 20 && slid.right <= def.right && free(slid)) return slid;
  const top = Math.min(...obs.filter((b) => hit({ ...at(def), y: 0, h: vh }, b)).map((b) => b.y));
  return { right: def.right, bottom: Math.round(vh - top + 10) };
}
