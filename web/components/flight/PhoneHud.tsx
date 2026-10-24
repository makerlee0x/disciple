"use client";

import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Phone-first HUD (viewport < PHONE_W, not ?clean=1). The rocket gets the screen: always visible are the compact MCAP strip
 * (engine), the BUY/SELL preset chips (engine), a one-line YOUR RUN / PnL strip (PnlHud) and the BOOST/DUMP trade bar.
 * Every other panel collapses into a tab on the right edge and opens as ONE sheet at a time (tap outside or ✕ closes):
 *   engine-drawn: status, top holders, trades feed, chart  — the engine reads window.__phoneHud (rect + open sheet)
 *   React:        crew, your run, chat, tramp/wall          — positioned by the html.ap-phone CSS below (--ph-* vars)
 * Desktop (≥ PHONE_W) is untouched: no class, no global, nothing rendered.
 * TAB LABELS ARE PLACEHOLDERS — pending lee / BRAND copy approval.
 */
export const PHONE_W = 740;   // = engine.js HUD_NARROW_W
export type PhoneSheet = "status" | "holders" | "feed" | "chart" | "crew" | "run" | "chat" | "tw";
type Tab = { id: PhoneSheet; label: string; title: string; react?: boolean };
// placeholder copy (flagged for lee / BRAND approval)
export const PHONE_TABS: Tab[] = [
  { id: "status", label: "STAT", title: "Status" },
  { id: "holders", label: "TOP", title: "Top holders" },
  { id: "feed", label: "FEED", title: "Trades feed" },
  { id: "chart", label: "CHART", title: "Chart" },
  { id: "crew", label: "CREW", title: "Crew", react: true },
  { id: "run", label: "RUN", title: "Your run", react: true },
  { id: "chat", label: "CHAT", title: "Chat", react: true },
  { id: "tw", label: "T/W", title: "Tramp / Wall", react: true },
];
const SEL: Partial<Record<PhoneSheet, string>> = { crew: '[data-testid="crew-panel"]', run: ".pnl-hud", chat: '[data-testid="chat-open"],[data-testid="chat-dock"]', tw: '[data-testid="tw-open"]' };
export const TAB_W = 44, EDGE = 6, GAP = 4, STRIP_H = 60, PNL_H = 32, PRESETS_H = 56;

/** Pure layout (tested in scripts/test-phone-hud.mjs): viewport + top-button row + trade-bar top → every phone rect. */
export function phoneLayout(o: { w: number; h: number; trTop: number; barTop: number }) {
  const top = o.trTop + 46;                              // under the Settings / Exit button row
  const pnlBottom = o.h - o.barTop + 6;                  // PnL strip sits 6px above the trade bar
  const py = o.barTop - 6 - PNL_H - 6;                   // preset chips end here
  const presetsTop = py - PRESETS_H;
  const sx = EDGE, sy = top + STRIP_H + 8, sw = o.w - EDGE - GAP - TAB_W - EDGE, sh = Math.max(120, presetsTop - 8 - sy);
  return { top, sx, sy, sw, sh, py, pnlBottom, chipBottom: o.h - presetsTop + 6, tabX: o.w - EDGE - TAB_W };
}

export default function PhoneHud() {
  const [phone, setPhone] = useState(false);
  const [sheet, setSheetS] = useState<PhoneSheet | null>(null);
  const [L, setL] = useState<ReturnType<typeof phoneLayout> | null>(null);
  const [avail, setAvail] = useState<Record<string, boolean>>({});
  const sheetRef = useRef<PhoneSheet | null>(null);

  const setSheet = useCallback((id: PhoneSheet | null) => {
    const prev = sheetRef.current; if (prev === id) return;
    sheetRef.current = id; setSheetS(id);
    if (prev === "chat") (document.querySelector('[data-testid="chat-collapse"]') as HTMLElement | null)?.click();
    if (id === "chat" && !document.querySelector('[data-testid="chat-dock"]')) (document.querySelector('[data-testid="chat-open"]') as HTMLElement | null)?.click();
    if (id === "crew") { const t = document.querySelector('[data-testid="crew-toggle"]') as HTMLElement | null; if (t && /expand/i.test(t.title)) t.click(); }
    dispatchEvent(new CustomEvent("disciple:phonesheet", { detail: { id } }));
  }, []);

  // phone detection + layout measure (wallet row and trade bar move; measured, not hardcoded)
  useEffect(() => {
    if (new URLSearchParams(location.search).get("clean") === "1") return;
    let last = "";
    const tick = () => {
      const on = innerWidth < PHONE_W;
      setPhone((p) => (p === on ? p : on));
      if (!on) { last = ""; return; }
      const cs = getComputedStyle(document.documentElement);
      const trTop = parseFloat(cs.getPropertyValue("--ap-tr-top")) || 12;
      const bar = document.querySelector('[data-testid="trade-bar"]') as HTMLElement | null;
      const barTop = bar ? Math.round(bar.getBoundingClientRect().top) : innerHeight - 14;
      const a: Record<string, boolean> = {}; for (const [k, s] of Object.entries(SEL)) a[k] = !!document.querySelector(s as string);
      const key = `${innerWidth}:${innerHeight}:${trTop}:${barTop}:${JSON.stringify(a)}`;
      if (key === last) return; last = key;
      setL(phoneLayout({ w: innerWidth, h: innerHeight, trTop, barTop })); setAvail(a);
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
    for (const [k, v] of Object.entries({ sx: L.sx, sy: L.sy, sw: L.sw, sh: L.sh, top: L.top, "pnl-bottom": L.pnlBottom, "chip-bottom": L.chipBottom })) de.style.setProperty(`--ph-${k}`, v + "px");
    w.__phoneHud = { on: true, sheet, top: L.top, sx: L.sx, sy: L.sy, sw: L.sw, sh: L.sh, py: L.py };
  }, [phone, L, sheet]);
  useEffect(() => () => { const de = document.documentElement; de.classList.remove("ap-phone"); delete de.dataset.phSheet; (window as unknown as { __phoneHud?: unknown }).__phoneHud = undefined; }, []);

  // keep in sync with panels that close themselves (chat ✕, PnlHud header) and Esc
  useEffect(() => {
    const onDock = (e: Event) => { const d = (e as CustomEvent).detail || {}; if (!d.open && sheetRef.current === "chat") setSheet(null); };
    const onReq = (e: Event) => { const d = (e as CustomEvent).detail || {}; if (d.req) setSheet(sheetRef.current === d.req ? null : d.req); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && sheetRef.current) setSheet(null); };
    const onTw = (e: Event) => { if ((e.target as HTMLElement | null)?.closest?.('[data-testid="tw-open"]') && sheetRef.current === "tw") setSheet(null); };   // placing: show the game
    addEventListener("disciple:chatdock", onDock); addEventListener("disciple:phonesheet-req", onReq); addEventListener("keydown", onKey); document.addEventListener("click", onTw, true);
    return () => { removeEventListener("disciple:chatdock", onDock); removeEventListener("disciple:phonesheet-req", onReq); removeEventListener("keydown", onKey); document.removeEventListener("click", onTw, true); };
  }, [setSheet]);
  useEffect(() => { if (!phone && sheetRef.current) setSheet(null); }, [phone, setSheet]);

  if (!phone || !L) return null;
  const tabs = PHONE_TABS.filter((t) => !t.react || avail[t.id]);
  const th = Math.max(30, Math.min(40, Math.floor((L.sh + 5) / tabs.length) - 5));
  const close = () => setSheet(null);
  const shield = (s: React.CSSProperties) => <div onPointerDown={(e) => { e.preventDefault(); close(); }} style={{ position: "fixed", zIndex: 29, ...s }} />;
  return (
    <>
      {sheet && <div data-testid="phone-backdrop">
        {shield({ left: 0, right: 0, top: 0, height: L.sy })}
        {shield({ left: 0, right: 0, top: L.sy + L.sh, bottom: 0 })}
        {shield({ left: 0, width: L.sx, top: L.sy, height: L.sh })}
        {shield({ left: L.sx + L.sw, right: 0, top: L.sy, height: L.sh })}
      </div>}
      <nav aria-label="HUD panels" data-testid="phone-tabs" style={{ position: "fixed", left: L.tabX, top: L.sy, zIndex: 45, display: "flex", flexDirection: "column", gap: 5 }}>
        {tabs.map((t) => <button key={t.id} type="button" data-testid={`phone-tab-${t.id}`} aria-pressed={sheet === t.id} title={t.title}
          onClick={() => setSheet(sheet === t.id ? null : t.id)}
          style={{ width: TAB_W, height: th, padding: 0, borderRadius: 9, cursor: "pointer", font: "bold 9px ui-monospace,monospace", letterSpacing: ".03em",
            color: sheet === t.id ? "#1a1630" : "#ffe7a3", background: sheet === t.id ? "rgba(255,231,163,.92)" : "rgba(8,10,28,.72)",
            border: `1px solid ${sheet === t.id ? "#fff" : "rgba(255,231,163,.35)"}` }}>{t.label}</button>)}
      </nav>
      {sheet && <button type="button" data-testid="phone-sheet-close" aria-label="Close panel" onClick={close}
        style={{ position: "fixed", left: L.sx + L.sw - 20, top: L.sy - 14, zIndex: 46, width: 28, height: 28, padding: 0, borderRadius: "50%", cursor: "pointer",
          font: "bold 13px ui-monospace,monospace", color: "#ffe7a3", background: "rgba(8,10,28,.92)", border: "1px solid rgba(255,231,163,.6)" }}>✕</button>}
      <style jsx global>{`
        /* ---- phone HUD (html.ap-phone): collapse every panel; show only the open sheet ---- */
        html.ap-phone [data-testid="crew-panel"],
        html.ap-phone [data-testid="chat-open"],
        html.ap-phone [data-testid="chat-dock"],
        html.ap-phone .ap-bc:has(> [data-testid="tw-open"]),
        html.ap-phone [data-testid="tw-list"],
        html.ap-phone [data-testid="flight-pills"] { display: none !important; }
        html.ap-phone[data-ph-sheet="crew"] [data-testid="crew-panel"],
        html.ap-phone[data-ph-sheet="chat"] [data-testid="chat-dock"] {
          left: var(--ph-sx) !important; right: auto !important; top: var(--ph-sy) !important; bottom: auto !important;
          width: var(--ph-sw) !important; max-height: var(--ph-sh) !important; overflow: auto; z-index: 32 !important;
        }
        html.ap-phone[data-ph-sheet="crew"] [data-testid="crew-panel"] { display: block !important; }
        html.ap-phone[data-ph-sheet="chat"] [data-testid="chat-dock"] { display: flex !important; height: var(--ph-sh) !important; overflow: hidden; background: rgba(8,10,24,.9) !important; }
        html.ap-phone[data-ph-sheet="tw"] .ap-bc:has(> [data-testid="tw-open"]) {
          display: flex !important; flex-wrap: wrap; left: var(--ph-sx) !important; top: var(--ph-sy) !important; bottom: auto !important; transform: none !important; width: var(--ph-sw);
        }
        html.ap-phone[data-ph-sheet="tw"] [data-testid="tw-list"] {
          display: block !important; left: var(--ph-sx) !important; top: calc(var(--ph-sy) + 92px) !important; bottom: auto !important; transform: none !important;
          width: var(--ph-sw) !important; max-height: calc(var(--ph-sh) - 92px); overflow: auto;
        }
        html.ap-phone[data-ph-sheet="status"] [data-testid="flight-pills"] {
          display: flex !important; left: calc(var(--ph-sx) + 8px) !important; top: calc(var(--ph-sy) + 100px) !important; bottom: auto !important; transform: none !important;
        }
        /* YOUR RUN (PnlHud: header button, hero row, UNREALIZED label, details): one-line strip above the trade bar; the RUN sheet shows the full card */
        html.ap-phone .pnl-hud { left: var(--ph-sx) !important; right: var(--ph-sx) !important; width: auto !important; top: auto !important; bottom: var(--ph-pnl-bottom) !important; }
        html.ap-phone:not([data-ph-sheet="run"]) .pnl-hud { display: flex; align-items: center; gap: 8px; height: ${PNL_H}px; box-sizing: border-box; padding: 0 10px !important; overflow: hidden; }
        html.ap-phone:not([data-ph-sheet="run"]) .pnl-hud > button:first-of-type { width: auto !important; flex: 1 1 auto; min-width: 0; font-size: 10px; }
        html.ap-phone:not([data-ph-sheet="run"]) .pnl-hud > button + div { margin-top: 0 !important; gap: 6px !important; }
        html.ap-phone:not([data-ph-sheet="run"]) .pnl-hud > button + div > span:first-child { font-size: 15px !important; }
        html.ap-phone:not([data-ph-sheet="run"]) .pnl-hud > button + div + div { display: none !important; }
        html.ap-phone[data-ph-sheet="run"] .pnl-hud { top: var(--ph-sy) !important; bottom: auto !important; right: auto !important; width: var(--ph-sw) !important; max-height: var(--ph-sh); overflow: auto; z-index: 32 !important; }
        /* trade bar: layout only (TradeBridge.tsx untouched) — full width, BOOST / DUMP on their own row, inputs + LIVE/pos below */
        html.ap-phone [data-testid="trade-bar"] { left: var(--ph-sx) !important; right: var(--ph-sx) !important; transform: none !important; bottom: 8px !important; }
        html.ap-phone [data-testid="trade-bar"] > div:first-child { flex-wrap: wrap; row-gap: 6px; }
        html.ap-phone [data-testid="trade-bar"] [data-testid="buy-btn"],
        html.ap-phone [data-testid="trade-bar"] [data-testid="sell-btn"] { order: -1; flex: 1 1 40%; min-width: 0 !important; }
        html.ap-phone [data-testid="trade-bar"] input[aria-label="custom amount"] { flex: 1 1 60px; min-width: 0; }
        /* anti-snipe chip (#133): stays visible, just above the preset chips */
        html.ap-phone .ap-bc[data-testid="snipe-chip"],
        html.ap-phone .ap-bc:has(> [data-testid="snipe-chip"]) { bottom: var(--ph-chip-bottom) !important; top: auto !important; z-index: 33 !important; }
      `}</style>
    </>
  );
}
