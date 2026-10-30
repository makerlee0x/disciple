"use client";

import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Phone HUD v3 (viewport < PHONE_W, not ?clean=1) — lee 10:36 CT: "build it with the new phone layout".
 * Mockups: phone-v3 frame1 (main) / frame3 (drawer). The rocket gets the screen:
 *   top     site menu + avatar (SITE) left (no ✕ since the Oct 30 cleanup: leave via the menu); under it ONE floating
 *           glass pill `$94.19M · TIER` + thin tier progress (engine-drawn, reads window.__phoneHud.pillTop)
 *   middle  rocket + sky only — touch-drag on the sky steers (engine @drag-steer)
 *   bottom  grab handle + quiet PnL line (this file) and BOOST [$10 ⌄] / DUMP [25% ⌄] (TradeBridge → PhoneTradeBar)
 *   drawer  swipe up / tap the handle: ONE drawer (~62% height) with segmented tabs; BOOST / DUMP stay usable under it.
 *           FEED / HOLDERS / CHART are engine-drawn inside the drawer's transparent body rect (window.__phoneHud.body);
 *           CREW / CHAT / RUN are the existing React panels, moved into the body by the html.ap-phone CSS below.
 *           Closes on swipe down (header), tap on the dimmed sky above, or Esc.
 * Desktop (≥ PHONE_W) is untouched: no class, no global, nothing rendered.
 */
export const PHONE_W = 740;   // = engine.js HUD_NARROW_W
export type PhoneSheet = "feed" | "holders" | "chart" | "crew" | "chat" | "run";
type Tab = { id: PhoneSheet; label: string; engine?: boolean };
// tab labels are final (lee 11:29 CT): Feed / Holders / Chart / Crew / Chat / Run; tramps & walls live under Run (no T/W tab)
export const DRAWER_TABS: Tab[] = [
  { id: "feed", label: "Feed", engine: true },
  { id: "holders", label: "Holders", engine: true },
  { id: "chart", label: "Chart", engine: true },
  { id: "crew", label: "Crew" },
  { id: "chat", label: "Chat" },
  { id: "run", label: "Run" },
];
const AVAIL_SEL: Partial<Record<PhoneSheet, string>> = { crew: '[data-testid="crew-panel"]', chat: '[data-testid="chat-open"],[data-testid="chat-dock"]' };
export const SIDE = 16, BTN_H = 68, BTN_H_OPEN = 60, BTN_BOTTOM = 22, PNL_H = 22, PNL_GAP = 14, HANDLE_H = 28, PILL_GAP = 14,
  DRAWER_FRAC = 0.62, D_HANDLE = 24, D_SEG = 48, D_GAP = 12, BODY_GAP = 12;
export const DRAWER_BG = "rgba(14,16,32,.94)";   // = engine.js PH_DRAWER_BG (the canvas paints the body band in the same tint)

/** Pure layout (tested in scripts/test-phone-hud.mjs): viewport + bottom of the top button row → every phone rect. */
export function phoneLayout(o: { w: number; h: number; topBottom: number }) {
  const btnTop = o.h - BTN_BOTTOM - BTN_H;
  const pnlTop = btnTop - PNL_GAP - PNL_H;
  const hudTop = pnlTop - HANDLE_H;                       // handle zone: grab bar + PnL line (tap / swipe up opens the drawer)
  const pillTop = Math.round(o.topBottom + PILL_GAP);
  const dTop = Math.round(o.h * (1 - DRAWER_FRAC));
  const dBtnTop = o.h - BTN_BOTTOM - BTN_H_OPEN;
  const bodyY = dTop + D_HANDLE + D_SEG + D_GAP;
  const body = { x: SIDE, y: bodyY, w: o.w - 2 * SIDE, h: Math.max(120, dBtnTop - BODY_GAP - bodyY) };
  return { pillTop, hudTop, pnlTop, btnTop, dTop, dBtnTop, body };
}

type PnlView = { txt?: { pnl: string; pct: string }; uPnl?: number } | null;
const rectOf = (s: string) => { const el = document.querySelector(s) as HTMLElement | null; const r = el?.getBoundingClientRect(); return r && r.width ? r : null; };

export default function PhoneHud() {
  const [phone, setPhone] = useState(false);
  const [sheet, setSheetS] = useState<PhoneSheet | null>(null);
  const [L, setL] = useState<ReturnType<typeof phoneLayout> | null>(null);
  const [xRight, setXRight] = useState(SIDE);
  const [cashTop, setCashTop] = useState(72);
  const [avail, setAvail] = useState<Record<string, boolean>>({});
  const [pnl, setPnl] = useState<PnlView>(null);
  const sheetRef = useRef<PhoneSheet | null>(null);
  const lastTab = useRef<PhoneSheet>("feed");

  const setSheet = useCallback((id: PhoneSheet | null) => {
    const prev = sheetRef.current; if (prev === id) return;
    sheetRef.current = id; setSheetS(id); if (id) lastTab.current = id;
    if (prev === "chat") (document.querySelector('[data-testid="chat-collapse"]') as HTMLElement | null)?.click();
    if (id === "chat" && !document.querySelector('[data-testid="chat-dock"]')) (document.querySelector('[data-testid="chat-open"]') as HTMLElement | null)?.click();
    if (id === "crew") { const t = document.querySelector('[data-testid="crew-toggle"]') as HTMLElement | null; if (t && /expand/i.test(t.title)) t.click(); }
    dispatchEvent(new CustomEvent("disciple:phonesheet", { detail: { id } }));
  }, []);

  // phone detection + layout measure (the site's menu / wallet row is measured, not hardcoded)
  useEffect(() => {
    if (new URLSearchParams(location.search).get("clean") === "1") return;
    let last = "";
    const tick = () => {
      const on = innerWidth < PHONE_W;
      setPhone((p) => (p === on ? p : on));
      if (!on) { last = ""; return; }
      const menu = rectOf("#apReopen"), wallet = rectOf('[aria-label="wallet"]');
      // post-grad fix 4: the site's cash + portfolio cards get their own row under the top row (CSS below: position fixed at
      // --ph-cash-top, so the wallet strip's own rect is just the top row); the pill stacks under whichever is lower.
      const rowBottom = Math.max(60, menu ? menu.bottom : 0, wallet ? wallet.bottom : 0), cashTop = Math.round(rowBottom + 8);
      const cash = rectOf('[aria-label="cash and portfolio"]');
      const topBottom = Math.max(64, rowBottom, cash ? cash.bottom : 0);
      // ✕ sits in the top row: flush right, or just left of the site's wallet strip (SITE "Play") while that is there
      const xr = wallet && wallet.top < 40 ? Math.round(innerWidth - wallet.left + 8) : SIDE;
      const a: Record<string, boolean> = {}; for (const [k, s] of Object.entries(AVAIL_SEL)) a[k] = !!document.querySelector(s as string);
      const key = `${innerWidth}:${innerHeight}:${topBottom}:${cashTop}:${xr}:${JSON.stringify(a)}`;
      if (key === last) return; last = key;
      setL(phoneLayout({ w: innerWidth, h: innerHeight, topBottom })); setXRight(xr); setAvail(a); setCashTop(cashTop);
    };
    tick();
    const id = window.setInterval(tick, 300); addEventListener("resize", tick);
    return () => { window.clearInterval(id); removeEventListener("resize", tick); };
  }, []);

  // publish: html class + data-ph-sheet + --ph-* vars (CSS) and window.__phoneHud (engine; mirrored to the worker renderer)
  useEffect(() => {
    const de = document.documentElement, w = window as unknown as { __phoneHud?: unknown };
    if (!phone || !L) { de.classList.remove("ap-phone"); delete de.dataset.phSheet; w.__phoneHud = undefined; return; }
    de.classList.add("ap-phone"); de.dataset.phSheet = sheet || "";
    const vars: Record<string, number> = { "x-right": xRight, "cash-top": cashTop, "pill-top": L.pillTop, "hud-top": L.hudTop, "pnl-top": L.pnlTop, "btn-top": L.btnTop, "d-top": L.dTop,
      bx: L.body.x, by: L.body.y, bw: L.body.w, bh: L.body.h };
    for (const [k, v] of Object.entries(vars)) de.style.setProperty(`--ph-${k}`, v + "px");
    w.__phoneHud = { on: true, sheet, drawer: !!sheet, pillTop: L.pillTop, hudTop: L.hudTop, dTop: sheet ? L.dTop : 0, body: L.body };
  }, [phone, L, sheet, xRight, cashTop]);
  useEffect(() => () => { const de = document.documentElement; de.classList.remove("ap-phone"); delete de.dataset.phSheet; (window as unknown as { __phoneHud?: unknown }).__phoneHud = undefined; }, []);

  // quiet PnL line: the same view PnlHud publishes (disciple:pnlview; window.__pnlView for the first paint)
  useEffect(() => {
    setPnl(((window as unknown as { __pnlView?: PnlView }).__pnlView) ?? null);
    const on = (e: Event) => setPnl(((e as CustomEvent).detail as PnlView) ?? null);
    addEventListener("disciple:pnlview", on); return () => removeEventListener("disciple:pnlview", on);
  }, []);

  // keep in sync with panels that close themselves (chat ✕, PnlHud header) and Esc
  useEffect(() => {
    const onDock = (e: Event) => { const d = (e as CustomEvent).detail || {}; if (!d.open && sheetRef.current === "chat") setSheet(null); };
    const onReq = (e: Event) => { const d = (e as CustomEvent).detail || {}; if (d.req) setSheet(sheetRef.current === d.req ? null : d.req); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && sheetRef.current) setSheet(null); };
    const onTw = (e: Event) => { if ((e.target as HTMLElement | null)?.closest?.('[data-testid="tw-open"]') && sheetRef.current) setSheet(null); };   // placing a tramp / wall: show the game
    addEventListener("disciple:chatdock", onDock); addEventListener("disciple:phonesheet-req", onReq); addEventListener("keydown", onKey); document.addEventListener("click", onTw, true);
    return () => { removeEventListener("disciple:chatdock", onDock); removeEventListener("disciple:phonesheet-req", onReq); removeEventListener("keydown", onKey); document.removeEventListener("click", onTw, true); };
  }, [setSheet]);
  useEffect(() => { if (!phone && sheetRef.current) setSheet(null); }, [phone, setSheet]);
  useEffect(() => { if (sheet && sheet !== "feed" && AVAIL_SEL[sheet] && avail[sheet] === false) setSheet("feed"); }, [sheet, avail, setSheet]);

  // gestures: swipe up / tap the handle zone opens; swipe down on the drawer header closes
  const g = useRef<{ y: number; id: number } | null>(null);
  // post-grad fix 6: capture the pointer so a desktop mouse drag that ends off the handle still delivers pointerup (and
  // opens the drawer as soon as the drag passes the threshold, like a touch swipe)
  // (handle only: capturing on the drawer head would retarget clicks away from its tab buttons)
  const down = (e: React.PointerEvent) => { g.current = { y: e.clientY, id: e.pointerId }; };
  const downOpen = (e: React.PointerEvent) => { down(e); try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* not capturable */ } };
  const moveOpen = (e: React.PointerEvent) => { const s = g.current; if (!s || s.id !== e.pointerId) return; if (e.clientY - s.y < -24) { g.current = null; setSheet(lastTab.current); } };
  const upOpen = (e: React.PointerEvent) => { const s = g.current; g.current = null; if (!s || s.id !== e.pointerId) return; const dy = e.clientY - s.y; if (dy < -18 || Math.abs(dy) < 8) setSheet(lastTab.current); };
  const upClose = (e: React.PointerEvent) => { const s = g.current; g.current = null; if (!s || s.id !== e.pointerId) return; if (e.clientY - s.y > 36) setSheet(null); };

  if (!phone || !L) return null;
  const tabs = DRAWER_TABS.filter((t) => !AVAIL_SEL[t.id] || avail[t.id]);
  const cur = DRAWER_TABS.find((t) => t.id === sheet);
  const by = L.body.y - L.dTop, bb = by + L.body.h;   // body band, relative to the drawer top
  const bg = cur?.engine ? `linear-gradient(to bottom, ${DRAWER_BG} 0, ${DRAWER_BG} ${by}px, transparent ${by}px, transparent ${bb}px, ${DRAWER_BG} ${bb}px)` : DRAWER_BG;
  const pos = !!pnl?.txt, neg = (pnl?.uPnl ?? 0) < 0;
  const pnlLine = pos ? <><b style={{ color: neg ? "#FF9EBE" : "#BFF5D9", fontWeight: 700 }}>{pnl!.txt!.pnl}</b> · {pnl!.txt!.pct}</> : <>No position yet</>;
  return (
    <>
      {/* bottom scrim (legibility under the buttons) — never takes input */}
      <div aria-hidden style={{ position: "fixed", left: 0, right: 0, bottom: 0, height: 300, zIndex: 24, pointerEvents: "none",
        background: "linear-gradient(to bottom, rgba(8,10,22,0) 0%, rgba(8,10,22,.72) 55%, rgba(8,10,22,.9) 100%)" }} />
      <div aria-hidden style={{ position: "fixed", left: 0, right: 0, top: 0, height: 150, zIndex: 24, pointerEvents: "none",
        background: "linear-gradient(to bottom, rgba(8,10,22,.55), rgba(8,10,22,0))" }} />
      {!sheet && <div data-testid="phone-handle" role="button" tabIndex={0} aria-label="Open panels (feed, holders, chart, crew, chat, run)"
        onPointerDown={downOpen} onPointerMove={moveOpen} onPointerUp={upOpen} onPointerCancel={() => { g.current = null; }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSheet(lastTab.current); } }}
        style={{ position: "fixed", left: 0, right: 0, top: L.hudTop, height: HANDLE_H + PNL_H + 6, zIndex: 31, touchAction: "none", cursor: "pointer", outline: "none" }}>
        <div style={{ height: HANDLE_H, display: "grid", placeItems: "center" }}><span style={{ width: 40, height: 5, borderRadius: 3, background: "rgba(255,255,255,.38)" }} /></div>
        <div data-testid="phone-pnl" style={{ height: PNL_H, textAlign: "center", font: "500 14px ui-monospace,Menlo,monospace", letterSpacing: ".06em", color: "rgba(214,222,245,.62)" }}>{pnlLine}</div>
      </div>}
      {sheet && <div data-testid="phone-dim" onPointerDown={(e) => { e.preventDefault(); setSheet(null); }}
        style={{ position: "fixed", left: 0, right: 0, top: 0, height: L.dTop, zIndex: 29, background: "rgba(5,6,14,.22)" }} />}
      {sheet && <section data-testid="phone-drawer" aria-label="Panels" style={{ position: "fixed", left: 0, right: 0, top: L.dTop, bottom: 0, zIndex: 30, pointerEvents: "none",
        borderRadius: "30px 30px 0 0", background: bg, boxShadow: "0 -1px 0 rgba(255,255,255,.08), 0 -20px 60px rgba(0,0,0,.45)" }}>
        <div data-testid="phone-drawer-head" onPointerDown={down} onPointerUp={upClose} onPointerCancel={() => { g.current = null; }}
          style={{ pointerEvents: "auto", padding: "0 16px", touchAction: "none" }}>
          <button type="button" data-testid="phone-drawer-close" aria-label="Close panels" onClick={() => setSheet(null)}
            style={{ all: "unset", display: "grid", placeItems: "center", width: "100%", height: D_HANDLE, cursor: "pointer" }}>
            <span style={{ width: 40, height: 5, borderRadius: 3, background: "rgba(255,255,255,.38)" }} /></button>
          <div role="tablist" className="ph-seg" style={{ display: "flex", height: D_SEG, boxSizing: "border-box", padding: 4, gap: 2, borderRadius: 16, background: "rgba(255,255,255,.06)" }}>
            {tabs.map((t) => <button key={t.id} type="button" role="tab" data-testid={`drawer-tab-${t.id}`} aria-selected={sheet === t.id} onClick={() => setSheet(t.id)}
              style={{ all: "unset", flex: "1 1 0", minWidth: 0, textAlign: "center", borderRadius: 12, cursor: "pointer", font: "700 12.5px ui-monospace,Menlo,\"DejaVu Sans Mono\",monospace",
                color: sheet === t.id ? "#fff" : "rgba(214,222,245,.62)", background: sheet === t.id ? "rgba(255,255,255,.14)" : "transparent" }}>{t.label}</button>)}
          </div>
        </div>
        {sheet === "feed" && <div data-testid="phone-feedhead" style={{ position: "absolute", left: SIDE + 4, right: SIDE + 4, top: by, height: 24, display: "flex", alignItems: "center",
          justifyContent: "space-between", font: "11.5px ui-monospace,Menlo,monospace", letterSpacing: ".14em", color: "rgba(214,222,245,.56)" }}>
          <span><span style={{ color: "#2FD98A" }}>●</span> LIVE TRADES</span>
          <span style={{ letterSpacing: ".04em" }}>{pnlLine}</span></div>}
      </section>}
      <style jsx global>{`
        /* ---- phone HUD v3 (html.ap-phone) ---- */
        /* post-grad fix 4 (play-test 8:26 PM CT). These restyle SITE components (claims FloorBins pill, WalletButton cash /
           portfolio cards) from GAME's phone layer only — no SITE file is edited. */
        /* floor-support pill: stacked under the mcap / tier pill + its caption or GRADUATED badge, never on top of it */
        html.ap-phone .cl-coin { top: calc(var(--ph-pill-top) + 46px + 30px) !important; max-width: calc(100vw - 24px) !important; }
        /* cash + portfolio: own full-width row under the logo / wallet row — room, contrast, never clipped */
        html.ap-phone [aria-label="cash and portfolio"] { position: fixed !important; top: var(--ph-cash-top) !important; left: 16px !important; right: 16px !important;
          display: flex !important; gap: 8px !important; justify-content: flex-end; z-index: 60; }
        html.ap-phone [data-testid="cash-card"], html.ap-phone [data-testid="portfolio-card"] { flex: 1 1 0; min-width: 0; max-width: 200px; overflow: visible !important;
          white-space: nowrap !important; padding: 6px 12px !important; border-radius: 14px !important; background: rgba(12,14,28,.9) !important;
          border: 1px solid rgba(255,255,255,.22) !important; box-shadow: 0 8px 24px rgba(0,0,0,.4); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); }
        html.ap-phone [data-testid="cash-card"] a { color: #9FF5C8 !important; }
        html.ap-phone [data-testid="settings-btn"],
        html.ap-phone [data-testid="crew-panel"],
        html.ap-phone [data-testid="chat-open"],
        html.ap-phone [data-testid="chat-dock"],
        html.ap-phone .ap-bc:has(> [data-testid="tw-open"]),
        html.ap-phone [data-testid="tw-list"],
        html.ap-phone [data-testid="flight-pills"],
        html.ap-phone .pnl-hud { display: none !important; }
        /* drawer tabs backed by the existing React panels: moved into the drawer body */
        html.ap-phone[data-ph-sheet="crew"] [data-testid="crew-panel"],
        html.ap-phone[data-ph-sheet="chat"] [data-testid="chat-dock"],
        html.ap-phone[data-ph-sheet="run"] .pnl-hud {
          display: block !important; position: fixed !important; left: var(--ph-bx) !important; right: auto !important; top: var(--ph-by) !important; bottom: auto !important;
          width: var(--ph-bw) !important; max-height: var(--ph-bh) !important; overflow: auto; z-index: 32 !important; transform: none !important; box-sizing: border-box;
          background: rgba(255,255,255,.04) !important; border: 1px solid rgba(255,255,255,.08) !important; border-radius: 20px !important; box-shadow: none !important;
        }
        html.ap-phone[data-ph-sheet="chat"] [data-testid="chat-dock"] { display: flex !important; height: var(--ph-bh) !important; overflow: hidden; }
        html.ap-phone[data-ph-sheet="run"] .pnl-hud { max-height: calc(var(--ph-bh) - 52px) !important; }   /* room for the T/W bar */
        html.ap-phone[data-ph-sheet="run"] .ap-bc:has(> [data-testid="tw-open"]) {
          display: flex !important; position: fixed !important; left: var(--ph-bx) !important; top: calc(var(--ph-by) + var(--ph-bh) - 40px) !important; bottom: auto !important;
          transform: none !important; z-index: 32 !important; height: 40px; align-items: center; gap: 6px;
        }
        html.ap-phone[data-ph-sheet="run"] [data-testid="tw-list"] {
          display: block !important; left: var(--ph-bx) !important; top: var(--ph-by) !important; bottom: auto !important; transform: none !important; z-index: 34 !important;
          width: var(--ph-bw) !important; max-height: calc(var(--ph-bh) - 52px); overflow: auto;
        }
        @media (max-width: 374px) { .ph-seg button { font-size: 11px !important; letter-spacing: -.02em; } }
        /* anti-snipe chip (#133): stays visible, just above the handle */
        html.ap-phone .ap-bc[data-testid="snipe-chip"],
        html.ap-phone .ap-bc:has(> [data-testid="snipe-chip"]) { bottom: calc(100vh - var(--ph-hud-top) + 6px) !important; top: auto !important; z-index: 33 !important; }
      `}</style>
    </>
  );
}

/** true while the phone HUD is on (html.ap-phone, set above) — TradeBridge swaps in the phone trade bar */
export function useIsPhoneHud() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const de = document.documentElement, f = () => setOn(de.classList.contains("ap-phone"));
    f(); const mo = new MutationObserver(f); mo.observe(de, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return on;
}
