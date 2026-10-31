/**
 * Coin-screen card layout (pass 3 #4, lee): every desktop card can be dragged by its handle, minimized or closed, and
 * restored from the LAYOUT menu. Pure helpers (tested in scripts/test-card-layout.mts); the store / hooks live in
 * lib/game/cardLayoutStore.ts.
 *
 * Saved per player: localStorage `disciple.layout.v1:<account lowercased>` (signed out ⇒ `…:guest`). Offsets are stored RAW
 * (what you dragged) and clamped at display time against the current viewport, so shrinking the window never loses a card
 * and growing it back restores the spot you chose. Phones ignore the layout (their drawers / sheets own the screen).
 */
import { SLOT_IDS, type SlotId } from "@/lib/game/slots";
export type CardId = "header" | "holders" | "trades" | "controls" | "chart" | "pnl" | "chat";
/** w / h: a RESIZED card's size (resizable cards only — today the DEX chart); absent = the card's default size */
/** slot / order (PR #221 snap-to-grid, lib/game/slots): where a moved card lives — the slot it was dropped in and its place in
 *  that slot's stack. dx / dy: legacy raw offsets (migrated to a slot on first sight) or the live offset while dragging. */
export type CardState = { dx: number; dy: number; min?: boolean; closed?: boolean; w?: number; h?: number; slot?: SlotId; order?: number; pin?: boolean };
/* pin: the player opened a secondary card (TOP HOLDERS / TRADES) from its tab on a small screen — keep it open there */
export type Layout = Partial<Record<CardId, CardState>>;
export type Rect = { x: number; y: number; w: number; h: number };

/** canvas cards = engine.js @cards (drawn on the canvas); DOM cards apply the offset themselves */
export const CANVAS_CARDS: CardId[] = ["header", "holders", "trades", "controls"];
/** chart: the DOM DEX chart (components/flight/DexChart.tsx, lightweight-charts) since Oct 30 — was the engine's canvas chart */
export const DOM_CARDS: CardId[] = ["chart", "pnl", "chat"];
/** cards with a resize handle (CardState.w / h) and their size limits (px) */
export const RESIZABLE: Partial<Record<CardId, { minW: number; minH: number; defW: number; defH: number }>> = {
  chart: { minW: 260, minH: 180, defW: 440, defH: 280 },   // + the canvas-relative cap in lib/game/slots chartCap
};
export const CARD_IDS: CardId[] = [...CANVAS_CARDS, ...DOM_CARDS];
export const CARD_TITLES: Record<CardId, string> = {
  header: "Coin", holders: "Top holders", trades: "Trades", controls: "Controls", chart: "Chart", pnl: "Your position", chat: "Chat",
};
export const LAYOUT_PREFIX = "disciple.layout.v1:";
export const layoutKey = (account: string | null | undefined) => LAYOUT_PREFIX + (account && /^0x[0-9a-fA-F]{40}$/.test(account) ? account.toLowerCase() : "guest");

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);
/** tolerant parse: unknown ids / junk dropped, offsets rounded, flags booleans; a default card (0,0, open) is not stored */
export function parseLayout(raw: string | null | undefined): Layout {
  let j: unknown; try { j = raw ? JSON.parse(raw) : null; } catch { return {}; }
  if (!j || typeof j !== "object") return {};
  const out: Layout = {};
  for (const id of CARD_IDS) {
    const c = (j as Record<string, unknown>)[id];
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>, s: CardState = { dx: num(o.dx), dy: num(o.dy) };
    if (o.min === true) s.min = true;
    if (o.closed === true) s.closed = true;
    const rz = RESIZABLE[id];
    if (rz) { const w = num(o.w), h = num(o.h); if (w > 0 && h > 0) { s.w = Math.max(rz.minW, w); s.h = Math.max(rz.minH, h); } }
    if (typeof o.slot === "string" && (SLOT_IDS as string[]).includes(o.slot)) { s.slot = o.slot as SlotId; s.order = num(o.order); s.dx = 0; s.dy = 0; }
    if (o.pin === true) s.pin = true;
    if (s.dx || s.dy || s.min || s.closed || s.w || s.slot || s.pin) out[id] = s;
  }
  return out;
}
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function loadLayout(ls: Store | null | undefined, account: string | null | undefined): Layout {
  try { return parseLayout(ls?.getItem(layoutKey(account))); } catch { return {}; }
}
export function saveLayout(ls: Store | null | undefined, account: string | null | undefined, l: Layout) {
  try { const k = layoutKey(account), clean = parseLayout(JSON.stringify(l)); if (Object.keys(clean).length) ls?.setItem(k, JSON.stringify(clean)); else ls?.removeItem(k); } catch { /* private mode */ }
}
/** immutable update of one card (patch merged; a card back at 0,0 + open is dropped) */
export function setCard(l: Layout, id: CardId, patch: Partial<CardState>): Layout {
  const cur = l[id] || { dx: 0, dy: 0 }, next: CardState = { ...cur, ...patch };
  const out: Layout = { ...l };
  if (!next.min) delete next.min;
  if (!next.closed) delete next.closed;
  if (!(next.w && next.h && RESIZABLE[id])) { delete next.w; delete next.h; }
  if (!next.slot) { delete next.slot; delete next.order; }
  if (!next.pin) delete next.pin;
  if (!next.dx && !next.dy && !next.min && !next.closed && !next.w && !next.slot && !next.pin) delete out[id]; else out[id] = next;
  return out;
}
export const restoreCard = (l: Layout, id: CardId) => setCard(l, id, { min: false, closed: false });
export const resetLayout = (): Layout => ({});
/** a resizable card's drawn size: the saved (or default) size, at least its minimum and at most the viewport minus a margin */
export function clampSize(id: CardId, s: { w?: number; h?: number } | null | undefined, vw: number, vh: number, margin = 8): { w: number; h: number } {
  const rz = RESIZABLE[id] ?? { minW: 100, minH: 60, defW: 300, defH: 200 };
  const w = s?.w && s.w > 0 ? s.w : rz.defW, h = s?.h && s.h > 0 ? s.h : rz.defH;
  const maxW = Math.max(rz.minW, vw - 2 * margin), maxH = Math.max(rz.minH, vh - 2 * margin);
  return { w: Math.round(Math.min(maxW, Math.max(rz.minW, w))), h: Math.round(Math.min(maxH, Math.max(rz.minH, h))) };
}
export const hiddenCards = (l: Layout) => CARD_IDS.filter((id) => l[id]?.closed || l[id]?.min);

/** the drawn offset: the raw offset clamped so the whole card stays inside vw × vh (a card larger than the viewport pins to
 *  its top / left). SAME formula as engine.js cardOff (scripts/test-card-layout.mts checks they agree). */
export function clampOffset(r: Rect, d: { dx: number; dy: number }, vw: number, vh: number): { dx: number; dy: number } {
  const ax = (lo: number, hi: number, v: number) => (hi < lo ? lo : Math.min(hi, Math.max(lo, v)));
  return { dx: Math.round(ax(-r.x, vw - r.w - r.x, num(d.dx))), dy: Math.round(ax(-r.y, vh - r.h - r.y, num(d.dy))) };
}
