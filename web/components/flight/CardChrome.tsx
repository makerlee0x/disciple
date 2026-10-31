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
import { getLayout, getSavedLayout, isPhoneUI, setFlowOffsets, updateLayout, useCanvasCards, useCardLayout, type FlowOffsets } from "@/lib/game/cardLayoutStore";
import { centerLane, COMPACT_W, computeSlots, layoutCards, nearestSlot, type Box, type FlowCard, type Slot, type SlotEnv, type SlotId } from "@/lib/game/slots";
import { overlayBlocked, startSidebarOverlay } from "@/lib/game/sidebarOverlay";

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
  useEffect(() => { startSidebarOverlay(); const f = () => setPhone(isPhoneUI()); f(); addEventListener("resize", f); return () => removeEventListener("resize", f); }, []);

  // PR #221 snap-to-grid: measure the content area + fixed obstacles, flow the cards into the slots (lib/game/slots)
  const [tabs, setTabs] = useState<{ ids: CardId[]; row: Box | null }>({ ids: [], row: null }), [pop, setPop] = useState<CardId | null>(null), popRef = useRef<CardId | null>(null);
  popRef.current = pop;
  const bases = useRef<Partial<Record<CardId, Box>>>({}), ammo = useRef<Box | null>(null), envRef = useRef<SlotEnv | null>(null), [preview, setPreview] = useState<Slot | null>(null);
  useEffect(() => {
    const onCol = (e: Event) => { const d = (e as CustomEvent<{ ammo?: Box }>).detail; const o = wrapXY(); ammo.current = d?.ammo ? { ...d.ammo, x: d.ammo.x + o.x, y: d.ammo.y + o.y } : null; };
    addEventListener("disciple:hudcol", onCol); return () => removeEventListener("disciple:hudcol", onCol);
  }, []);
  useEffect(() => {
    const dom = (sel: string): Box | null => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r && r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; };
    const union = (bs: (Box | null)[]): Box | null => { const v = bs.filter((b): b is Box => !!b); if (!v.length) return null;
      const x = Math.min(...v.map((b) => b.x)), y = Math.min(...v.map((b) => b.y)); return { x, y, w: Math.max(...v.map((b) => b.x + b.w)) - x, h: Math.max(...v.map((b) => b.y + b.h)) - y }; };
    const run = () => {
      if (isPhoneUI()) { setFlowOffsets({}); envRef.current = null; return; }
      const wrap = document.getElementById("wrap")?.getBoundingClientRect(); if (!wrap || !(wrap.width > 0)) return;
      const wallet = dom('[aria-label="wallet"]');   // real height: the strip can wrap to 3 rows (testnet)
      const bar = union([dom('[data-testid="trade-bar"]'), dom('[data-testid="tw-open"]'), dom('[data-testid="tw-mine"]')]);
      const holders = canvas.cards.holders;
      // usable area = the canvas wrapper's MEASURED box, minus an overlay sidebar while it is open (lib/game/sidebarOverlay)
      const left = Math.max(wrap.left, overlayBlocked()), lane = centerLane(wrap.left, wrap.width, left, innerHeight, wrap.top);
      const env: SlotEnv = { vw: innerWidth, vh: innerHeight, left, top: wrap.top, wallet, bar, ammo: ammo.current, canvasL: wrap.left, canvasW: wrap.width, lane,
        colTop: holders && !holders.dx && !holders.dy && holders.x + wrap.left >= left ? holders.y + wrap.top : undefined };
      (window as unknown as { __hudLane?: Box }).__hudLane = lane;
      envRef.current = env;
      const saved = getSavedLayout(), d = drag.current, cards: FlowCard[] = [], cur = getLayout();
      for (const id of CARD_IDS) {
        const sv = saved[id]; if (sv?.min || sv?.closed || (d && d.id === id)) continue;
        const r = rectOf(id);
        let base: Box;
        if (r) { const e = effOffset(id); base = { x: Math.round(r.x - e.dx), y: Math.round(r.y - e.dy), w: Math.round(r.w), h: Math.round(r.h) }; bases.current[id] = base; }
        else if (cur[id]?.closed && bases.current[id]) base = bases.current[id]!;   // folded into a tab by the flow: keep it in the flow
        else continue;
        if (sv && !sv.slot && (sv.dx || sv.dy)) {   // migrate a legacy raw x / y to the nearest slot (saved once)
          const sl = computeSlots(env), at = { x: base.x + sv.dx, y: base.y + sv.dy };
          const slot = nearestSlot(sl, at.x + base.w / 2, at.y + base.h / 2);
          updateLayout((l) => setCard(l, id, { dx: 0, dy: 0, slot, order: Math.round(at.y) }));
          cards.push({ id, base, slot, order: at.y }); continue;
        }
        cards.push({ id, base, slot: sv?.slot, order: sv?.order });
      }
      const fixed = [wallet, bar, ammo.current].filter((b): b is Box => !!b);
      if (d) { const r = rectOf(d.id); if (r) fixed.push(r); }   // the card in your hand is not flowed (others avoid it)
      const compact = innerWidth - left < COMPACT_W, pinned = CARD_IDS.filter((id) => saved[id]?.pin);
      const res = layoutCards(env, cards, fixed, { compact, pinned }), out = res.pos, offs: FlowOffsets = {};
      for (const c of cards) { const o = out[c.id]; if (!o) continue;
        if (o.tab) {   // a tab: hidden, unless it is the one popped open (a popover under the tab row, over the layout)
          if (popRef.current === c.id && res.tabRow) { const r = res.tabRow; offs[c.id as CardId] = { dx: Math.round(r.x + r.w - c.base.w - c.base.x), dy: Math.round(r.y + r.h + 6 - c.base.y) }; }
          else offs[c.id as CardId] = { dx: 0, dy: 0, hide: true };
        } else if (o.x !== c.base.x || o.y !== c.base.y || c.slot) offs[c.id as CardId] = { dx: o.x - c.base.x, dy: o.y - c.base.y }; }
      setFlowOffsets(offs);
      const ids = res.tabs as CardId[];
      setTabs((t) => (t.ids.join() === ids.join() && JSON.stringify(t.row) === JSON.stringify(res.tabRow) ? t : { ids, row: res.tabRow }));
      if (popRef.current && !ids.includes(popRef.current)) setPop(null);
    };
    run(); const iv = setInterval(run, 700);
    const ro = new ResizeObserver(run); const w = document.getElementById("wrap"); if (w) ro.observe(w);   // content width changes (sidebar)
    addEventListener("resize", run); addEventListener("apsidebar", run);
    return () => { clearInterval(iv); ro.disconnect(); removeEventListener("resize", run); removeEventListener("apsidebar", run); };
  });

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

  useEffect(() => { if (!pop) return; const k = (e: KeyboardEvent) => { if (e.key === "Escape") setPop(null); }; addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [pop]);
  if (phone) return null;
  const startDrag = (id: CardId) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const o = effOffset(id); drag.current = { id, x0: e.clientX, y0: e.clientY, dx: o.dx, dy: o.dy, pid: e.pointerId };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* */ }
  };
  // drag = live offset (no slot) in memory; the drop snaps to the nearest slot and saves {slot, order}
  const targetSlot = (id: CardId): Slot | null => { const env = envRef.current, r = rectOf(id); if (!env || !r) return null;
    const sl = computeSlots(env); return sl[nearestSlot(sl, r.x + r.w / 2, r.y + r.h / 2)]; };
  const onMove = (e: React.PointerEvent) => { const d = drag.current; if (!d || e.pointerId !== d.pid) return;
    updateLayout((l) => setCard(l, d.id, { dx: d.dx + e.clientX - d.x0, dy: d.dy + e.clientY - d.y0, slot: undefined }), false); tick((x) => x + 1);
    const t = targetSlot(d.id); setPreview((p) => (p?.id === t?.id && p?.y === t?.y ? p : t)); };
  const onUp = (e: React.PointerEvent) => { const d = drag.current; if (!d || e.pointerId !== d.pid) return;
    const t = targetSlot(d.id), r = rectOf(d.id); drag.current = null; setPreview(null);
    const slot: SlotId = t?.id ?? "tl", order = Math.round(r?.y ?? 0);
    updateLayout((l) => setCard(l, d.id, { dx: 0, dy: 0, slot, order })); };
  const act = (id: CardId, patch: { min?: boolean; closed?: boolean }) => { updateLayout((l) => setCard(l, id, patch)); setHover(null); };

  const hov = hover && !layout[hover]?.min && !layout[hover]?.closed ? rectOf(hover) : null;
  const pills = CARD_IDS.filter((id) => layout[id]?.min);
  const hidden = hiddenCards(layout);
  return (
    <div data-testid="card-chrome" style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 61 }}>
      {tabs.row && tabs.ids.length > 0 && <div data-testid="card-tabs" style={{ position: "fixed", left: tabs.row.x, top: tabs.row.y, width: tabs.row.w, height: tabs.row.h, display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center", pointerEvents: "auto" }}>
        {tabs.ids.map((id) => <button key={id} data-testid={`card-tab-${id}`} aria-expanded={pop === id} title={pop === id ? `Close ${CARD_TITLES[id]}` : `Show ${CARD_TITLES[id]}`} onClick={() => setPop((p) => (p === id ? null : id))}
          style={{ ...btn, padding: "3px 9px", borderRadius: 11, fontSize: 10, fontWeight: 700, letterSpacing: ".06em", background: pop === id ? "rgba(255,231,163,.18)" : "rgba(8,10,28,.86)", border: "1px solid rgba(255,231,163,.45)" }}>
          {pop === id ? "▾" : "▸"} {CARD_TITLES[id].toUpperCase()}</button>)}
        {pop && <button data-testid={`card-pin-${pop}`} title="Keep this card open on this screen size" onClick={() => { const id = pop; setPop(null); updateLayout((l) => setCard(l, id, { pin: true })); }}
          style={{ ...btn, padding: "3px 7px", borderRadius: 11, fontSize: 10, border: "1px solid rgba(255,231,163,.3)" }}>keep open</button>}
      </div>}
      {preview && <div data-testid="snap-preview" style={{ position: "fixed", left: preview.x - 4, top: preview.y - 4, width: preview.w + 8, height: Math.max(40, preview.h) + 8,
        border: "1px dashed rgba(255,231,163,.6)", background: "rgba(255,231,163,.06)", borderRadius: 10, pointerEvents: "none" }} />}
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
