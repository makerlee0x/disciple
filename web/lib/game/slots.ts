/**
 * Snap-to-grid card slots (lee, PR #221): the coin-screen cards live in a few slots laid out inside the MEASURED content
 * area (viewport minus the sidebar: the canvas wrapper's left edge, never a hard-coded width), clear of the top-right wallet
 * strip, the BUY / SELL panel (engine hudTopLayout, published as disciple:hudcol) and the bottom BOOST / DUMP bar.
 *
 *   tl ┌─────┐  [BUY/SELL]  ┌─────┐ tr      left column: tl (top half) · bl (bottom half, above the bar if they meet)
 *      │     │              │ col │         right column: tr · col · br (top 40% · to 70% · to the bottom)
 *   bl └─────┘  [BOOST/DUMP]└─────┘ br
 *
 * A card dropped anywhere snaps to the nearest slot; cards in one slot stack top-down (gap 8), skipping fixed obstacles,
 * and a card that does not fit spills into the next slot (tl → bl → tr → col → br → tl …). Saved per account as
 * {slot, order} (order = the y it was dropped at, so the stack keeps the order you dropped them in). Cards never moved stay at
 * their default spot unless that spot hits something, then they are flowed too (not saved). Pure — scripts/test-slots.mts.
 */
export type SlotId = "tl" | "bl" | "tr" | "col" | "br";
export const SLOT_IDS: SlotId[] = ["tl", "bl", "tr", "col", "br"];
export type Box = { x: number; y: number; w: number; h: number };
export type SlotEnv = { vw: number; vh: number; left: number; top?: number; colTop?: number; wallet?: Box | null; bar?: Box | null; ammo?: Box | null };
export type Slot = Box & { id: SlotId; side: "l" | "r"; limit: number };
export type FlowOut = { x: number; y: number; slot?: SlotId; overflow?: boolean };
export type FlowCard = { id: string; base: Box; slot?: SlotId; order?: number };

const M = 20, GAP = 8;
export const hit = (a: Box, b: Box, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
const overlapsX = (x: number, w: number, b: Box | null | undefined) => !!b && x < b.x + b.w && b.x < x + w;

export function computeSlots(e: SlotEnv): Record<SlotId, Slot> {
  const top = (e.top ?? 0) + 18, W = e.vw - e.left;
  const colW = Math.min(440, Math.max(240, Math.floor((W - 3 * M) / 2)));
  const lx = e.left + M, rx = e.vw - M - Math.min(310, colW);
  const rTop = Math.max(top, e.colTop ?? 0, e.wallet ? e.wallet.y + e.wallet.h + GAP : 0);
  const bottom = (x: number, w: number) => (overlapsX(x, w, e.bar) ? e.bar!.y - 10 : e.vh - 24);
  const lLim = bottom(lx, colW), rLim = bottom(rx, e.vw - M - rx);
  const mid = Math.round(top + (lLim - top) / 2), r1 = Math.round(rTop + (rLim - rTop) * 0.4), r2 = Math.round(rTop + (rLim - rTop) * 0.7);
  const L = (id: SlotId, y0: number, y1: number): Slot => ({ id, side: "l", x: lx, y: y0, w: colW, h: Math.max(0, y1 - y0), limit: lLim });
  const R = (id: SlotId, y0: number, y1: number): Slot => ({ id, side: "r", x: rx, y: y0, w: e.vw - M - rx, h: Math.max(0, y1 - y0), limit: rLim });
  return { tl: L("tl", top, mid), bl: L("bl", mid, lLim), tr: R("tr", rTop, r1), col: R("col", r1, r2), br: R("br", r2, rLim) };
}
export function nearestSlot(slots: Record<SlotId, Slot>, cx: number, cy: number): SlotId {
  let best: SlotId = "tl", bd = Infinity;
  for (const id of SLOT_IDS) { const s = slots[id], dx = Math.max(s.x - cx, 0, cx - (s.x + s.w)), dy = Math.max(s.y - cy, 0, cy - (s.y + s.h)), d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = id; } }
  return best;
}
/** fixed = obstacles that never move (wallet, bar, BUY panel …). Returns the drawn top-left of every card. */
export function flowCards(env: SlotEnv, cards: FlowCard[], fixed: Box[]): Record<string, FlowOut> {
  const slots = computeSlots(env), out: Record<string, FlowOut> = {};
  const content: Box = { x: env.left, y: env.top ?? 0, w: env.vw - env.left, h: env.vh - (env.top ?? 0) };
  const obs: Box[] = fixed.filter((b) => b && b.w > 0 && b.h > 0);
  const inside = (b: Box) => b.x >= content.x && b.y >= content.y && b.x + b.w <= content.x + content.w && b.y + b.h <= content.y + content.h;
  const free = (b: Box) => inside(b) && !obs.some((o) => hit(b, o, GAP - 1));
  // 1) never-moved cards keep their default spot when it is clear; otherwise they join the flow at their nearest slot
  const flow: FlowCard[] = [];
  for (const c of cards) {
    if (!c.slot && free(c.base)) { obs.push(c.base); out[c.id] = { x: c.base.x, y: c.base.y }; continue; }
    flow.push(c.slot ? c : { ...c, slot: nearestSlot(slots, c.base.x + c.base.w / 2, c.base.y + c.base.h / 2), order: c.base.y });
  }
  // 2) slotted cards: by slot, then order; stack top-down, spill to the next slot
  const cursor: Record<SlotId, number> = { tl: slots.tl.y, bl: slots.bl.y, tr: slots.tr.y, col: slots.col.y, br: slots.br.y };
  flow.sort((a, b) => SLOT_IDS.indexOf(a.slot!) - SLOT_IDS.indexOf(b.slot!) || (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
  const tryIn = (s: Slot, w: number, h: number): Box | null => {
    const x = s.side === "l" ? s.x : Math.max(content.x + M, s.x + s.w - w);
    let y = cursor[s.id];
    for (let guard = 0; guard < 40; guard++) {
      if (y > s.y + s.h || y + h > s.limit) return null;
      const b = { x, y, w, h }, o = obs.find((q) => hit(b, q, GAP - 1));
      if (!o) return inside(b) ? b : null;
      y = o.y + o.h + GAP;
    }
    return null;
  };
  for (const c of flow) {
    const i0 = SLOT_IDS.indexOf(c.slot!);
    let placed: Box | null = null, sid: SlotId = c.slot!;
    for (let k = 0; k < SLOT_IDS.length && !placed; k++) { sid = SLOT_IDS[(i0 + k) % SLOT_IDS.length]; placed = tryIn(slots[sid], c.base.w, c.base.h); }
    if (!placed) {   // every slot full: the free spot nearest the slot it was dropped in, anywhere in the content area
      const s0 = slots[c.slot!], w = c.base.w, h = c.base.h; let bd = Infinity; sid = c.slot!;
      for (let y = content.y + 18; y + h <= env.vh - 24; y += 8) for (let x = content.x + M; x + w <= env.vw - M; x += 16) {
        const b = { x, y, w, h }, d = (x - s0.x) ** 2 + (y - s0.y) ** 2; if (d < bd && free(b)) { bd = d; placed = b; } }
    }
    if (!placed) { out[c.id] = { x: c.base.x, y: c.base.y, slot: c.slot, overflow: true }; continue; }   // no room at all: hidden (not saved)
    cursor[sid] = Math.max(cursor[sid], placed.y + placed.h + GAP); obs.push(placed); out[c.id] = { x: placed.x, y: placed.y, slot: sid };
  }
  return out;
}
