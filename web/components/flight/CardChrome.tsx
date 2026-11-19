"use client";
/**
 * Coin-screen card layout (pass 3 #4 + PR #221 snap-to-grid): flows the desktop cards into slots so they never overlap, and
 * folds cards that don't fit into a tab row. The old ⠿ / – / × hover bar, minimized pills and LAYOUT menu were removed
 * (maker 2026-11-18: "old design leftover"). Desktop only (phones keep their drawers / sheets).
 */
import { useEffect, useRef, useState } from "react";
import { CARD_IDS, CARD_TITLES, CANVAS_CARDS, FLOAT_CARDS, restoreCard, setCard, type CardId } from "@/lib/game/cardLayout";
import { getLayout, getSavedLayout, isPhoneUI, setFlowOffsets, updateLayout, useCanvasCards, type FlowOffsets } from "@/lib/game/cardLayoutStore";
import { centerLane, COMPACT_W, computeSlots, layoutCards, nearestSlot, type Box, type FlowCard, type SlotEnv } from "@/lib/game/slots";
import { overlayBlocked, startSidebarOverlay } from "@/lib/game/sidebarOverlay";

type R = { x: number; y: number; w: number; h: number };
const mono = "ui-monospace, monospace";
const btn: React.CSSProperties = { all: "unset", cursor: "pointer", padding: "0 5px", lineHeight: "16px", fontSize: 11, color: "#ffe7a3", fontFamily: mono };
const DOM_SEL: Partial<Record<CardId, string>> = { chart: '[data-card="chart"]', pnl: '[data-card="pnl"]', chat: '[data-card="chat"]', radio: '[data-card="radio"]' };

export default function CardChrome() {
  const canvas = useCanvasCards();
  const [phone, setPhone] = useState(true);
  const lastDom = useRef<Partial<Record<CardId, R>>>({});
  // maker 2026-11-18: the ⠿ / – / × bar and the LAYOUT menu were old-design leftovers and are gone, so a card someone
  // minimized or closed before then would have no way back: bring every one back once on load.
  useEffect(() => { const l = getSavedLayout(); if (CARD_IDS.some((id) => l[id]?.min || l[id]?.closed)) updateLayout((x) => CARD_IDS.reduce((acc, id) => (acc[id]?.min || acc[id]?.closed ? restoreCard(acc, id) : acc), x)); }, []);
  useEffect(() => { startSidebarOverlay(); const f = () => setPhone(isPhoneUI()); f(); addEventListener("resize", f); return () => removeEventListener("resize", f); }, []);

  // PR #221 snap-to-grid: measure the content area + fixed obstacles, flow the cards into the slots (lib/game/slots)
  const [tabs, setTabs] = useState<{ ids: CardId[]; row: Box | null }>({ ids: [], row: null }), [pop, setPop] = useState<CardId | null>(null), popRef = useRef<CardId | null>(null);
  popRef.current = pop;
  const bases = useRef<Partial<Record<CardId, Box>>>({}), ammo = useRef<Box | null>(null), envRef = useRef<SlotEnv | null>(null), colTopRef = useRef<number | null>(null);
  useEffect(() => {
    const onCol = (e: Event) => { const d = (e as CustomEvent<{ top?: number; ammo?: Box }>).detail; const o = wrapXY(); colTopRef.current = Number.isFinite(d?.top) ? d!.top! : null; ammo.current = d?.ammo ? { ...d.ammo, x: d.ammo.x + o.x, y: d.ammo.y + o.y } : null; };
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
      // right-column top (lee Oct 31: the TOP HOLDERS card is gone): the engine's column top (disciple:hudcol, canvas px) + the
      // status box (--ap-status-h) — where the old card sat, so the column's next card (the chat dock) starts there, no gap
      const ct = colTopRef.current, statusH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ap-status-h")) || 0;
      // usable area = the canvas wrapper's MEASURED box, minus an overlay sidebar while it is open (lib/game/sidebarOverlay)
      const left = Math.max(wrap.left, overlayBlocked()), lane = centerLane(wrap.left, wrap.width, left, innerHeight, wrap.top);
      const env: SlotEnv = { vw: innerWidth, vh: innerHeight, left, top: wrap.top, wallet, bar, ammo: ammo.current, canvasL: wrap.left, canvasW: wrap.width, lane,
        colTop: ct != null ? ct + statusH + wrap.top : undefined };
      (window as unknown as { __hudLane?: Box }).__hudLane = lane;
      envRef.current = env;
      const saved = getSavedLayout(), cards: FlowCard[] = [], cur = getLayout();
      const colFixed: Box[] = [];
      for (const id of CARD_IDS) {
        if (FLOAT_CARDS.includes(id)) continue;   // radio: drag / minimize / saved dx,dy, but stay out of the snap-to-grid flow
        // approved mockup (Nov 12): the right column is fixed, chart on top (Pro) and the crew feed under it. They hold their
        // spots; the flow only keeps the other cards clear of them.
        if (id === "chart" || id === "chat") { const r = rectOf(id); if (r) colFixed.push(r); continue; }
        const sv = saved[id]; if (sv?.min || sv?.closed) continue;
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
      const fixed = [wallet, bar, ammo.current, ...colFixed].filter((b): b is Box => !!b);
      const compact = innerWidth - left < COMPACT_W, pinned = CARD_IDS.filter((id) => saved[id]?.pin);
      const res = layoutCards(env, cards, fixed, { compact, pinned }), out = res.pos, offs: FlowOffsets = {};
      for (const c of cards) { const o = out[c.id]; if (!o) continue;
        if (o.tab) {   // a tab: hidden, unless it is the one popped open (a popover under the tab row, over the layout)
          if (popRef.current === c.id && res.tabRow) { const r = res.tabRow; offs[c.id as CardId] = { dx: Math.round(r.x + r.w - c.base.w - c.base.x), dy: Math.round(r.y + r.h + 6 - c.base.y) }; }
          else offs[c.id as CardId] = { dx: 0, dy: 0, hide: true };
        } else if (o.x !== c.base.x || o.y !== c.base.y || c.slot) offs[c.id as CardId] = { dx: o.x - c.base.x, dy: o.y - c.base.y }; }
      setFlowOffsets(offs);
      (window as unknown as { __slotDebug?: unknown }).__slotDebug = { env, cards, tabs: res.tabs, tabRow: res.tabRow };   // read by the overlap check
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

  useEffect(() => { if (!pop) return; const k = (e: KeyboardEvent) => { if (e.key === "Escape") setPop(null); }; addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [pop]);
  if (phone) return null;
  return (
    <div data-testid="card-chrome" style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 61 }}>
      {tabs.row && tabs.ids.length > 0 && <div data-testid="card-tabs" style={{ position: "fixed", left: tabs.row.x, top: tabs.row.y, width: tabs.row.w, height: tabs.row.h, display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center", pointerEvents: "auto" }}>
        {tabs.ids.map((id) => <button key={id} data-testid={`card-tab-${id}`} aria-expanded={pop === id} title={pop === id ? `Close ${CARD_TITLES[id]}` : `Show ${CARD_TITLES[id]}`} onClick={() => setPop((p) => (p === id ? null : id))}
          style={{ ...btn, padding: "3px 9px", borderRadius: 11, fontSize: 10, fontWeight: 700, letterSpacing: ".06em", background: pop === id ? "rgba(255,231,163,.18)" : "rgba(8,10,28,.86)", border: "1px solid rgba(255,231,163,.45)" }}>
          {pop === id ? "▾" : "▸"} {CARD_TITLES[id].toUpperCase()}</button>)}
        {pop && <button data-testid={`card-pin-${pop}`} title="Keep this card open on this screen size" onClick={() => { const id = pop; setPop(null); updateLayout((l) => setCard(l, id, { pin: true })); }}
          style={{ ...btn, padding: "3px 7px", borderRadius: 11, fontSize: 10, border: "1px solid rgba(255,231,163,.3)" }}>keep open</button>}
      </div>}
    </div>
  );
}

