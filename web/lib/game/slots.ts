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
/** left = first usable x (the canvas wrapper's left edge, or the right edge of an open overlay sidebar); canvasL / canvasW =
 *  the wrapper's measured box (the rocket flies at its centre); lane = the clear centre lane (centerLane) */
export type SlotEnv = { vw: number; vh: number; left: number; top?: number; colTop?: number; wallet?: Box | null; bar?: Box | null; ammo?: Box | null;
  canvasL?: number; canvasW?: number; lane?: Box | null };

/** The clear centre lane around the rocket (lee, PR #221): the rocket's screen x is the canvas centre (engine S.x = W/2,
 *  lanes ±150 are steering targets the camera follows), so the lane is centred there and is ~32% of the canvas width
 *  (16% each side), never narrower than 2×90 px and never into the header column (left usable edge + 20 + 380 + gap) or the
 *  right column (canvas right − 330). No card is placed, dropped, flowed or resized into it. */
export const LANE_FRAC = 0.16;
export function centerLane(canvasL: number, canvasW: number, usableL: number, vh: number, top = 0): Box {
  const cx = canvasL + canvasW / 2, leftCol = usableL + 20 + 380 + GAP, rightCol = canvasL + canvasW - 330 - GAP;
  const half = Math.max(90, Math.min(Math.round(canvasW * LANE_FRAC), cx - leftCol, rightCol - cx));
  return { x: Math.round(cx - half), y: top, w: Math.round(2 * half), h: vh - top };
}
/** DexChart size cap: ≤ 34% of the canvas width and ≤ 45% of its height, and never across the centre lane from where it sits */
export const CHART_CAP = { fw: 0.34, fh: 0.45, minW: 260, minH: 180 };
export function chartCap(canvasW: number, canvasH: number, x?: number, lane?: Box | null, vw?: number): { w: number; h: number } {
  let w = Math.round(canvasW * CHART_CAP.fw); const h = Math.max(CHART_CAP.minH, Math.round(canvasH * CHART_CAP.fh));
  if (x != null && lane) w = Math.min(w, x < lane.x ? lane.x - GAP - x : (vw ?? x + w) - M - x);
  return { w: Math.max(CHART_CAP.minW, w), h };
}
/** secondary cards fold into tabs on a small content area (< COMPACT_W px usable) unless the player opened them there */
export const COMPACT_W = 1200;
export const SECONDARY = ["trades"];
export type Slot = Box & { id: SlotId; side: "l" | "r"; limit: number };
export type FlowOut = { x: number; y: number; slot?: SlotId; tab?: boolean };
export type FlowOpts = { compact?: boolean; secondary?: string[]; pinned?: string[] };
export const TAB_ROW_H = 26;
export type FlowCard = { id: string; base: Box; slot?: SlotId; order?: number };

const M = 20, GAP = 8;
export const hit = (a: Box, b: Box, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
const overlapsX = (x: number, w: number, b: Box | null | undefined) => !!b && x < b.x + b.w && b.x < x + w;

export function computeSlots(e: SlotEnv): Record<SlotId, Slot> {
  const top = (e.top ?? 0) + 18, W = e.vw - e.left;
  let colW = Math.min(440, Math.max(240, Math.floor((W - 3 * M) / 2)));
  const lx = e.left + M; if (e.lane) colW = Math.max(200, Math.min(colW, e.lane.x - GAP - lx));
  let rx = e.vw - M - Math.min(310, colW); if (e.lane) rx = Math.max(rx, e.lane.x + e.lane.w + GAP);
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
/** The full layout: cards in slots + the tab row (tabs = folded secondary cards on a small screen, or any card with no free
 *  spot — a card is never hidden). The tab row sits at the top of the right column (or the top of tl if that is wider). */
export function layoutCards(env: SlotEnv, cards: FlowCard[], fixed: Box[], opts: FlowOpts = {}): { pos: Record<string, FlowOut>; tabs: string[]; tabRow: Box | null } {
  const sec = new Set(opts.secondary ?? SECONDARY), pin = new Set(opts.pinned ?? []);
  const folded = opts.compact ? cards.filter((c) => sec.has(c.id) && !pin.has(c.id)).map((c) => c.id) : [];
  const row = (): Box => { const sl = computeSlots(env); return { x: sl.tr.x, y: sl.tr.y, w: sl.tr.w, h: TAB_ROW_H }; };
  const run = (withRow: boolean) => {
    const rest = cards.filter((c) => !folded.includes(c.id)), r = withRow ? row() : null;
    const pos = flowCards(r ? { ...env, colTop: r.y + r.h + GAP } : env, rest, r ? [...fixed, r] : fixed);
    for (const id of folded) pos[id] = { x: 0, y: 0, tab: true };
    return { pos, tabs: Object.keys(pos).filter((k) => pos[k].tab), tabRow: r };
  };
  let res = run(folded.length > 0);
  if (!res.tabRow && res.tabs.length) res = run(true);
  if (!res.tabs.length) res.tabRow = null;
  return res;
}
export function flowCards(env: SlotEnv, cards: FlowCard[], fixed: Box[]): Record<string, FlowOut> {
  const slots = computeSlots(env), out: Record<string, FlowOut> = {};
  const content: Box = { x: env.left, y: env.top ?? 0, w: env.vw - env.left, h: env.vh - (env.top ?? 0) };
  const obs: Box[] = [...fixed, ...(env.lane ? [env.lane] : [])].filter((b) => b && b.w > 0 && b.h > 0);
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
    if (!placed) { out[c.id] = { x: c.base.x, y: c.base.y, slot: c.slot, tab: true }; continue; }   // no room at all: a tab (not saved)
    cursor[sid] = Math.max(cursor[sid], placed.y + placed.h + GAP); obs.push(placed); out[c.id] = { x: placed.x, y: placed.y, slot: sid };
  }
  return out;
}
