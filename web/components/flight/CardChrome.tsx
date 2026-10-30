"use client";
/**
 * Coin-screen card chrome (pass 3 #4, lee): a small ⠿ / – / × toolbar on the card under the mouse (drag ⠿ to move, – minimize,
 * × close), a pill per minimized card (click = restore) and a LAYOUT menu (bottom-left) that lists every card, brings
 * closed / minimized ones back and resets the layout. Desktop only (phones keep their drawers / sheets).
 *
 * Canvas cards (header, holders, trades, controls) are drawn by engine.js @cards from the layout and report their
 * drawn rects (disciple:cardrects, canvas px from #wrap); DOM cards (chart = DexChart, pnl, chat) apply their offset themselves
 * (useDomCard / DexChart; the chart also has its own resize handle, size saved in the same layout)
 * and are located by [data-card]. All pointer input here lands on DOM elements, so it never reaches the game (no steering).
 */
import { useEffect, useRef, useState } from "react";
import { CARD_IDS, CARD_TITLES, CANVAS_CARDS, hiddenCards, resetLayout, restoreCard, setCard, type CardId, type Layout } from "@/lib/game/cardLayout";
import { getLayout, isPhoneUI, updateLayout, useCanvasCards, useCardLayout } from "@/lib/game/cardLayoutStore";

type R = { x: number; y: number; w: number; h: number };
const mono = "ui-monospace, monospace";
const btn: React.CSSProperties = { all: "unset", cursor: "pointer", padding: "0 5px", lineHeight: "16px", fontSize: 11, color: "#ffe7a3", fontFamily: mono };
const DOM_SEL: Partial<Record<CardId, string>> = { chart: '[data-card="chart"]', pnl: '[data-card="pnl"]', chat: '[data-card="chat"]' };
const DOM_HOME: Partial<Record<CardId, R>> = { chart: { x: 84, y: 470, w: 440, h: 40 }, pnl: { x: 86, y: 212, w: 272, h: 40 }, chat: { x: 0, y: 160, w: 300, h: 40 } };   // pill spot if never seen

export default function CardChrome() {
  const layout = useCardLayout(), canvas = useCanvasCards();
  const [phone, setPhone] = useState(true), [hover, setHover] = useState<CardId | null>(null), [menu, setMenu] = useState(false), [, tick] = useState(0);
  const lastDom = useRef<Partial<Record<CardId, R>>>({});
  const drag = useRef<{ id: CardId; x0: number; y0: number; dx: number; dy: number; pid: number } | null>(null);
  useEffect(() => { const f = () => setPhone(isPhoneUI()); f(); addEventListener("resize", f); return () => removeEventListener("resize", f); }, []);

  const wrapXY = () => { const r = typeof document !== "undefined" ? document.getElementById("wrap")?.getBoundingClientRect() : null; return { x: r?.left ?? 0, y: r?.top ?? 0 }; };
  /** page-px rect of a card (null = not on screen) */
  const rectOf = (id: CardId): R | null => {
    if (CANVAS_CARDS.includes(id)) { const c = canvas.cards[id]; if (!c) return null; const o = wrapXY(); return { x: c.x + o.x, y: c.y + o.y, w: c.w, h: c.h }; }
    const el = document.querySelector(DOM_SEL[id] || "") as HTMLElement | null, r = el?.getBoundingClientRect();
    if (r && r.width > 0) { const v = { x: r.left, y: r.top, w: r.width, h: r.height }; lastDom.current[id] = v; return v; }
    return null;
  };
  const effOffset = (id: CardId) => { if (CANVAS_CARDS.includes(id)) { const c = canvas.cards[id]; return c ? { dx: c.dx, dy: c.dy } : { dx: 0, dy: 0 }; }
    const el = document.querySelector(DOM_SEL[id] || "") as HTMLElement | null, m = el && /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.style.transform || "");
    return m ? { dx: +m[1], dy: +m[2] } : { dx: 0, dy: 0 }; };

  // hover: the card under the pointer (its rect + the toolbar strip above it)
  useEffect(() => {
    if (phone) return;
    const mv = (e: PointerEvent) => {
      if (drag.current) return;
      let hit: CardId | null = null;
      for (const id of CARD_IDS) { const l = getLayout()[id]; if (l?.min || l?.closed) continue; const r = rectOf(id); if (!r) continue;
        if (e.clientX >= r.x && e.clientX <= r.x + r.w && e.clientY >= r.y - 20 && e.clientY <= r.y + r.h) { hit = id; break; } }
      setHover((h) => (h === hit ? h : hit));
    };
    addEventListener("pointermove", mv); return () => removeEventListener("pointermove", mv);
  });

  if (phone) return null;
  const startDrag = (id: CardId) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const o = effOffset(id); drag.current = { id, x0: e.clientX, y0: e.clientY, dx: o.dx, dy: o.dy, pid: e.pointerId };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* */ }
  };
  const onMove = (e: React.PointerEvent) => { const d = drag.current; if (!d || e.pointerId !== d.pid) return;
    updateLayout((l) => setCard(l, d.id, { dx: d.dx + e.clientX - d.x0, dy: d.dy + e.clientY - d.y0 }), false); tick((x) => x + 1); };
  const onUp = (e: React.PointerEvent) => { const d = drag.current; if (!d || e.pointerId !== d.pid) return; drag.current = null;
    // commit the CLAMPED spot (what you see), so a card dragged past the edge doesn't jump when the window grows later
    requestAnimationFrame(() => { const o = effOffset(d.id); updateLayout((l) => setCard(l, d.id, o)); }); };
  const act = (id: CardId, patch: { min?: boolean; closed?: boolean }) => { updateLayout((l) => setCard(l, id, patch)); setHover(null); };

  const hov = hover && !layout[hover]?.min && !layout[hover]?.closed ? rectOf(hover) : null;
  const pills = CARD_IDS.filter((id) => layout[id]?.min);
  const hidden = hiddenCards(layout);
  return (
    <div data-testid="card-chrome" style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 61 }}>
      {hov && hover && (
        <div data-testid={`card-bar-${hover}`} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          style={{ position: "fixed", left: Math.max(0, hov.x + hov.w - 74), top: Math.max(0, hov.y - 17), height: 16, display: "flex", gap: 1, pointerEvents: "auto",
            background: "rgba(8,10,28,.86)", border: "1px solid rgba(255,231,163,.35)", borderRadius: 6, userSelect: "none" }}>
          <button data-testid={`card-drag-${hover}`} title={`Drag to move ${CARD_TITLES[hover]}`} onPointerDown={startDrag(hover)} style={{ ...btn, cursor: "grab", touchAction: "none" }}>⠿</button>
          <button data-testid={`card-min-${hover}`} title="Minimize" onClick={() => act(hover, { min: true })} style={btn}>–</button>
          <button data-testid={`card-close-${hover}`} title="Close (bring it back from LAYOUT)" onClick={() => act(hover, { closed: true })} style={btn}>×</button>
        </div>)}
      {pills.map((id) => { const c = CANVAS_CARDS.includes(id) ? canvas.cards[id] : null, o = wrapXY();
        const r = c ? { x: c.x + o.x, y: c.y + o.y } : lastDom.current[id] || DOM_HOME[id] || { x: 80, y: 80 };
        const x = id === "chat" && !lastDom.current.chat ? window.innerWidth - 140 : r.x;
        return <button key={id} data-testid={`card-pill-${id}`} title={`Restore ${CARD_TITLES[id]}`} onClick={() => updateLayout((l) => restoreCard(l, id))}
          style={{ ...btn, position: "fixed", left: x, top: r.y, pointerEvents: "auto", padding: "2px 8px", borderRadius: 8, background: "rgba(8,10,28,.86)", border: "1px solid rgba(255,231,163,.45)", fontWeight: 700, letterSpacing: ".06em" }}>
          ▸ {CARD_TITLES[id].toUpperCase()}</button>; })}
      <div style={{ position: "fixed", left: wrapXY().x + 20, bottom: 3, pointerEvents: "auto" }}>
        <button data-testid="layout-menu" onClick={() => setMenu((m) => !m)} title="Cards: restore closed ones or reset the layout"
          style={{ ...btn, fontSize: 9.5, opacity: menu || hidden.length ? 0.95 : 0.55, letterSpacing: ".08em" }}>⧉ LAYOUT{hidden.length ? ` · ${hidden.length} hidden` : ""}</button>
        {menu && <LayoutMenu layout={layout} close={() => setMenu(false)} />}
      </div>
    </div>
  );
}

function LayoutMenu({ layout, close }: { layout: Layout; close: () => void }) {
  return (
    <div data-testid="layout-pop" style={{ position: "absolute", left: 0, bottom: 20, minWidth: 190, padding: 8, borderRadius: 10, background: "rgba(10,12,30,.96)",
      border: "1px solid rgba(255,231,163,.35)", font: `11px ${mono}`, color: "#e8ecff", boxShadow: "0 8px 24px rgba(0,0,0,.5)" }}>
      {CARD_IDS.map((id) => { const s = layout[id], st = s?.closed ? "closed" : s?.min ? "minimized" : s?.dx || s?.dy ? "moved" : s?.w ? "resized" : "";
        return <div key={id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "2px 0" }}>
          <span>{CARD_TITLES[id]}{st && <span style={{ opacity: 0.55 }}> · {st}</span>}</span>
          {(s?.closed || s?.min) && <button data-testid={`layout-show-${id}`} onClick={() => updateLayout((l) => restoreCard(l, id))} style={{ ...btn, padding: 0 }}>show</button>}
        </div>; })}
      <button data-testid="layout-reset" onClick={() => { updateLayout(() => resetLayout()); close(); }}
        style={{ ...btn, marginTop: 6, padding: "2px 8px", borderRadius: 6, border: "1px solid rgba(255,231,163,.45)" }}>Reset layout</button>
    </div>
  );
}
