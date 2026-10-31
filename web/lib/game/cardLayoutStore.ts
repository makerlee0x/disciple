"use client";
/**
 * Coin-screen card layout store (pass 3 #4): one in-memory layout for the signed-in account (guest when signed out), loaded
 * from / saved to localStorage (lib/game/cardLayout), published to the engine (disciple:cardlayout + window.__cardLayout) and
 * to React (useCardLayout). Canvas cards' drawn rects come back from the engine (disciple:cardrects → useCanvasCards).
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { onWallet } from "@/lib/wallet";
import { clampOffset, loadLayout, saveLayout, type CardId, type Layout } from "@/lib/game/cardLayout";

type Win = { __cardLayout?: Layout };
let layout: Layout = {}, account: string | null = null, started = false;
/** PR #221 snap-to-grid: the slot flow (CardChrome → lib/game/slots) turns slot assignments into drawn offsets; the engine
 *  and the DOM cards get the SAVED layout with those offsets merged in (overflow = no room anywhere ⇒ hidden, not saved). */
export type FlowOffsets = Partial<Record<CardId, { dx: number; dy: number; hide?: boolean }>>;
let flow: FlowOffsets = {}, merged: Layout = {};
const subs = new Set<(l: Layout) => void>();
const ls = () => (typeof localStorage !== "undefined" ? localStorage : null);
function merge(): Layout {
  const out: Layout = { ...layout };
  for (const k of Object.keys(flow) as CardId[]) { const f = flow[k]!, c = out[k] || { dx: 0, dy: 0 };
    out[k] = { ...c, dx: f.dx, dy: f.dy, ...(f.hide ? { closed: true } : {}) }; }
  return out;
}
function publish() {
  if (typeof window === "undefined") return;
  merged = merge();
  (window as unknown as Win).__cardLayout = merged;
  dispatchEvent(new CustomEvent("disciple:cardlayout", { detail: merged }));
  for (const f of subs) f(merged);
}
export const getSavedLayout = () => layout;
export function setFlowOffsets(f: FlowOffsets) { if (JSON.stringify(f) === JSON.stringify(flow)) return; flow = f; publish(); }
function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  layout = loadLayout(ls(), null); publish();
  onWallet((a) => { const n = a ? a.toLowerCase() : null; if (n === account) return; account = n; layout = loadLayout(ls(), account); publish(); });
}
/** what is on screen (saved layout + slot flow) */
export const getLayout = () => merged;
/** persist=false while dragging (memory + engine only); the pointerup commits */
export function updateLayout(f: (l: Layout) => Layout, persist = true) { start(); layout = f(layout); if (persist) saveLayout(ls(), account, layout); publish(); }
export function useCardLayout(): Layout {
  const [l, setL] = useState<Layout>(merged);
  useEffect(() => { start(); setL(merged); subs.add(setL); return () => { subs.delete(setL); }; }, []);
  return l;
}
export const isPhoneUI = () => typeof document !== "undefined" && (document.documentElement.classList.contains("ap-phone") || !!window.matchMedia?.("(max-width: 760px)").matches);

export type CanvasCard = { x: number; y: number; w: number; h: number; dx: number; dy: number; min: boolean; closed: boolean };
export type CanvasCards = { W: number; H: number; cards: Partial<Record<CardId, CanvasCard>> };
let lastRects: CanvasCards = { W: 0, H: 0, cards: {} };
if (typeof window !== "undefined") addEventListener("disciple:cardrects", (e) => { const d = (e as CustomEvent<CanvasCards>).detail; if (d && d.cards) lastRects = d; });
export function useCanvasCards(): CanvasCards {
  const [r, setR] = useState<CanvasCards>(lastRects);
  useEffect(() => { const h = (e: Event) => { const d = (e as CustomEvent<CanvasCards>).detail; if (d && d.cards) setR(d); };
    setR(lastRects); addEventListener("disciple:cardrects", h); return () => removeEventListener("disciple:cardrects", h); }, []);
  return r;
}

/** DOM cards (PnL, chat): the clamped offset to apply as a transform + min / closed. The card's base rect is measured with the
 *  applied offset removed, so the clamp matches the engine's for canvas cards. Phones: no layout. */
export function useDomCard(id: CardId, ref: RefObject<HTMLElement | null>) {
  const l = useCardLayout(), c = l[id];
  const [off, setOff] = useState({ dx: 0, dy: 0 }), [phone, setPhone] = useState(false), offRef = useRef(off);
  offRef.current = off;
  useLayoutEffect(() => {
    const fit = () => {
      const ph = isPhoneUI(); setPhone(ph);
      const el = ref.current;
      if (ph || !el || !c) { if (offRef.current.dx || offRef.current.dy) setOff({ dx: 0, dy: 0 }); return; }
      const r = el.getBoundingClientRect(); if (!(r.width > 0)) return;
      const base = { x: r.left - offRef.current.dx, y: r.top - offRef.current.dy, w: r.width, h: r.height };
      const o = clampOffset(base, c, window.innerWidth, window.innerHeight);
      if (o.dx !== offRef.current.dx || o.dy !== offRef.current.dy) setOff(o);
    };
    fit(); addEventListener("resize", fit);
    return () => removeEventListener("resize", fit);
  }, [c, ref]);
  const hidden = !phone && !!(c && (c.min || c.closed));
  return { dx: phone ? 0 : off.dx, dy: phone ? 0 : off.dy, hidden, min: !phone && !!c?.min, closed: !phone && !!c?.closed,
    transform: !phone && (off.dx || off.dy) ? `translate(${off.dx}px, ${off.dy}px)` : undefined };
}
