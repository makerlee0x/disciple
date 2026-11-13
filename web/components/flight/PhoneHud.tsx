"use client";

import type React from "react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import LevelRing from "@/components/xp/LevelRing";
import { usePilotWallet, useXp } from "@/lib/xpClient";
import { FLIGHT_TIERS, GRAD_BADGE, tierIndexAt } from "@/lib/flight/tiers";
import { WALLET_CTA_CLICK_EVENT, WALLET_CTA_EVENT, WALLET_ID_EVENT, walletCtaLabel, walletId, type WalletId } from "@/lib/walletCta";

/**
 * Phone flight HUD v2 (viewport ≤ PHONE_W / max-width:760px, not ?clean=1). Built from the approved boards
 * "Phone v2 · 1 Flying", "· 2 Holders and chart sheet" and "· 3 Wallet limit" (maker 2026-11-13: "that looks good. build it").
 *   top row     ☰ menu (the app menu, Sidebar #apSide) · your pilot chip (level ring + name, or Sign in) · ✕ leave
 *   header card mcap + ticker + mode badge ("EASY · 1% CAP") · zone + "$8.6K to Ozone" + progress · Your bag · Cash · Room
 *               (Room = how much more you can boost before the wallet cap; TradeBridge publishes it with cash, disciple:phonestats)
 *   sky         crew feed under the header (GameChat, phone mode) + chat button, ▸ RADIO folded under it (GameRadio)
 *   bottom      HOLDERS · CHART pill, then the trade bar (TradeBridge → PhoneTradeBar): amount chips over BOOST / DUMP
 *   sheet       tap or swipe up the pill: a short sheet with two tabs, HOLDERS (this file, from the engine's disciple:holders) and
 *               CHART (engine-drawn in the sheet body, window.__phoneHud.body, or the DOM DexChart). The sky dims, a compact
 *               header replaces the top row, and BOOST / DUMP stay usable under it. Closes on swipe down, tap above, or Esc.
 * The engine draws nothing of its own on the phone sky any more (window.__phoneHud.v2: no mcap pill, no tier caption).
 * Desktop (> PHONE_W) is untouched: no class, no global, nothing rendered.
 */
export const PHONE_W = 760;   // = engine.js HUD_NARROW_W; matches site chrome max-width:760px
export type PhoneSheet = "holders" | "chart";
export const SHEET_TABS: { id: PhoneSheet; label: string; engine?: boolean }[] = [
  { id: "holders", label: "HOLDERS" },
  { id: "chart", label: "CHART", engine: true },
];
export const SIDE = 16, TOP_ROW = 44, HEAD_GAP = 12, BAR_BOTTOM = 24, CHIP_H = 36, CHIP_GAP = 6, BTN_H = 64, BTN_H_OPEN = 60, PILL_H = 32, PILL_GAP = 32,
  SHEET_FRAC = 0.355, S_GRAB = 27, S_TABS = 48, S_GAP = 12, BODY_GAP = 12;
export const DRAWER_BG = "rgba(14,16,32,.94)";   // = engine.js PH_DRAWER_BG (the canvas paints the sheet body in the same tint)

/** Pure layout (tested in scripts/test-phone-hud.mjs): viewport + safe areas + the header card's measured bottom → every phone rect. */
export function phoneLayout(o: { w: number; h: number; headBottom: number; safeTop?: number; safeBottom?: number }) {
  const top = Math.max(12, (o.safeTop ?? 0) + 8);
  const headTop = top + TOP_ROW + HEAD_GAP;
  const barBottom = Math.max(BAR_BOTTOM, (o.safeBottom ?? 0) + 8);
  const barTop = o.h - barBottom - BTN_H - CHIP_GAP - CHIP_H;
  const pillTop = barTop - PILL_GAP - PILL_H;
  const feedTop = Math.round(o.headBottom + 16);
  const dTop = Math.round(o.h * SHEET_FRAC);
  const dBtnTop = o.h - barBottom - BTN_H_OPEN;
  const bodyY = dTop + S_GRAB + S_TABS + S_GAP;
  const body = { x: SIDE, y: bodyY, w: o.w - 2 * SIDE, h: Math.max(120, dBtnTop - BODY_GAP - bodyY) };
  return { top, headTop, barBottom, barTop, pillTop, feedTop, radioTop: feedTop + 52, toastTop: feedTop + 96, dTop, dBtnTop, body };
}

type Rules = { ticker?: string; mode?: number; capBps?: number | null } | null;
type PnlView = { valueUsd?: number; txt?: { pnl: string; pct: string; pos?: string }; uPnl?: number } | null;
type HolderItem = { who: string; address: string; usd: number; pct: number; label?: string | null; mine: boolean };
type Holders = { title: string; rows: [string, number][]; you: number; items?: HolderItem[] } | null;

const MODE: Record<number, { t: string; c: string }> = { 1: { t: "EASY", c: "#5FF0A0" }, 2: { t: "HARD", c: "#FF7A3D" }, 0: { t: "EXPERT", c: "#F0307F" } };   // = engine.js DIFF
/** header money: $3.3K · $94.2M · $512 */
export const shortUsd = (v: number) => (!(v > 0) ? "$0" : v >= 1e9 ? `$${+(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${+(v / 1e3).toFixed(1)}K` : `$${Math.round(v)}`);
const cashUsd = (v: number) => (v >= 100 ? `$${Math.floor(v).toLocaleString("en-US")}` : `$${v.toFixed(2)}`);
const title = (s: string) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
/** zone row: current zone, $ to the next one, bar fill = mcap / next zone's low (same number as the desktop tier bar) */
export function zoneLine(mcap: number) {
  const i = tierIndexAt(mcap), t = FLIGHT_TIERS[i], nx = FLIGHT_TIERS[i + 1];
  return { zone: t.name, next: nx ? `${shortUsd(Math.max(0, nx.lo - mcap))} to ${title(nx.name)}` : "", f: nx ? Math.max(0.02, Math.min(1, mcap / nx.lo)) : 1 };
}
const capTxt = (bps: number) => `${+(bps / 100).toFixed(2)}%`;
const AVA = ["#8FD8FF", "#C9B6F2", "#5FF0A0", "#FFB3CF", "#FFE08A", "#FFC9A3"];
const avaOf = (s: string) => AVA[Array.from(s).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % AVA.length];
const G = "var(--dsc-font-game, var(--font-barlow-condensed), 'Barlow Condensed', 'Arial Narrow', sans-serif)";

export default function PhoneHud() {
  const [phone, setPhone] = useState(false);
  const [sheet, setSheetS] = useState<PhoneSheet | null>(null);
  const [L, setL] = useState<ReturnType<typeof phoneLayout> | null>(null);
  const [mcap, setMcap] = useState(0);
  const [rules, setRules] = useState<Rules>(null);
  const [grad, setGrad] = useState(false);
  const [pnl, setPnl] = useState<PnlView>(null);
  const [stats, setStats] = useState<{ cash: number | null; room: number | null }>({ cash: null, room: null });
  const [holders, setHolders] = useState<Holders>(null);
  const [cta, setCta] = useState<string | null>(null);
  const [me, setMe] = useState<WalletId | null>(null);
  const wallet = usePilotWallet();
  const { xp } = useXp(wallet);
  const sheetRef = useRef<PhoneSheet | null>(null);
  const lastTab = useRef<PhoneSheet>("holders");
  const headRef = useRef<HTMLDivElement>(null);

  const setSheet = useCallback((id: PhoneSheet | null) => {
    const prev = sheetRef.current; if (prev === id) return;
    sheetRef.current = id; setSheetS(id); if (id) lastTab.current = id;
    dispatchEvent(new CustomEvent("disciple:phonesheet", { detail: { id } }));
  }, []);

  // phone detection + layout measure (the header card is measured: its zone row folds away on very old coins)
  useEffect(() => {
    if (new URLSearchParams(location.search).get("clean") === "1") return;
    let last = "";
    const tick = () => {
      const vv = window.visualViewport;
      const vw = Math.round(vv?.width ?? innerWidth);
      const vh = Math.round(vv?.height ?? innerHeight);
      const on = window.matchMedia(`(max-width: ${PHONE_W}px)`).matches || vw <= PHONE_W;
      setPhone((p) => (p === on ? p : on));
      if (!on) { last = ""; return; }
      const cs = getComputedStyle(document.documentElement);
      const safeTop = parseFloat(cs.getPropertyValue("--ap-safe-top")) || 0, safeBottom = parseFloat(cs.getPropertyValue("--ap-safe-bottom")) || 0;
      const hb = headRef.current?.getBoundingClientRect();
      const headBottom = hb && hb.height ? Math.round(hb.bottom) : Math.max(12, safeTop + 8) + TOP_ROW + HEAD_GAP + 124;
      const key = `${vw}:${vh}:${headBottom}:${safeTop}:${safeBottom}`;
      if (key === last) return; last = key;
      setL(phoneLayout({ w: vw, h: vh, headBottom, safeTop, safeBottom }));
    };
    tick();
    const id = window.setInterval(tick, 300);
    addEventListener("resize", tick);
    window.visualViewport?.addEventListener("resize", tick);
    return () => { window.clearInterval(id); removeEventListener("resize", tick); window.visualViewport?.removeEventListener("resize", tick); };
  }, []);

  // publish: html class + data-ph-sheet + --ph-* vars (CSS) and window.__phoneHud (engine; mirrored to the worker renderer)
  useEffect(() => {
    const de = document.documentElement, w = window as unknown as { __phoneHud?: unknown };
    if (!phone || !L) { de.classList.remove("ap-phone"); delete de.dataset.phSheet; w.__phoneHud = undefined; return; }
    de.classList.add("ap-phone"); de.dataset.phSheet = sheet || "";
    const vars: Record<string, number> = { top: L.top, "head-top": L.headTop, "feed-top": L.feedTop, "radio-top": L.radioTop, "pill-top": L.pillTop, "bar-bottom": L.barBottom,
      "bar-top": L.barTop, "d-top": L.dTop, bx: L.body.x, by: L.body.y, bw: L.body.w, bh: L.body.h };
    for (const [k, v] of Object.entries(vars)) de.style.setProperty(`--ph-${k}`, v + "px");
    w.__phoneHud = { on: true, v2: true, sheet, drawer: !!sheet, pillTop: L.toastTop, toastTop: L.toastTop, hudTop: L.pillTop, dTop: sheet ? L.dTop : 0, body: L.body };
  }, [phone, L, sheet]);
  useEffect(() => () => { const de = document.documentElement; de.classList.remove("ap-phone"); delete de.dataset.phSheet; (window as unknown as { __phoneHud?: unknown }).__phoneHud = undefined; }, []);

  // header data: mark (engine), coin rules (TradeBridge), graduated (TradeBridge), bag (PnlHud), cash + Room (TradeBridge), holders (engine)
  useEffect(() => {
    const W = window as unknown as { __pnlView?: PnlView; __phoneStats?: { cash: number | null; room: number | null } };
    setPnl(W.__pnlView ?? null); if (W.__phoneStats) setStats(W.__phoneStats);
    setCta(walletCtaLabel()); setMe(walletId());
    const ev: [string, (d: unknown) => void][] = [
      ["disciple:mark", (d) => { const m = (d as { mcap?: number } | null)?.mcap; if (m && m > 0) setMcap(m); }],
      ["disciple:coinrules", (d) => setRules((d as Rules) ?? null)],
      ["disciple:gradneed", (d) => { const g = (d as { graduated?: boolean } | null)?.graduated; if (typeof g === "boolean") setGrad(g); }],
      ["disciple:pnlview", (d) => setPnl((d as PnlView) ?? null)],
      ["disciple:phonestats", (d) => { if (d) setStats(d as { cash: number | null; room: number | null }); }],
      ["disciple:holders", (d) => setHolders((d as Holders) ?? null)],
      [WALLET_CTA_EVENT, (d) => setCta((d as { label: string | null } | null)?.label ?? null)],
      [WALLET_ID_EVENT, (d) => setMe((d as WalletId | null) ?? null)],
    ];
    const hs = ev.map(([n, f]) => { const h = (e: Event) => f((e as CustomEvent).detail); addEventListener(n, h); return [n, h] as const; });
    return () => { for (const [n, h] of hs) removeEventListener(n, h); };
  }, []);

  // sheet requests, Esc
  useEffect(() => {
    const onReq = (e: Event) => { const d = (e as CustomEvent).detail || {}; const r = d.req === "chart" ? "chart" : d.req ? "holders" : null; if (r) setSheet(sheetRef.current === r ? null : r); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && sheetRef.current) setSheet(null); };
    addEventListener("disciple:phonesheet-req", onReq); addEventListener("keydown", onKey);
    return () => { removeEventListener("disciple:phonesheet-req", onReq); removeEventListener("keydown", onKey); };
  }, [setSheet]);
  useEffect(() => { if (!phone && sheetRef.current) setSheet(null); }, [phone, setSheet]);

  // gestures: swipe up / tap the pill opens; swipe down on the sheet head closes
  const g = useRef<{ y: number; id: number } | null>(null);
  const down = (e: React.PointerEvent) => { g.current = { y: e.clientY, id: e.pointerId }; };
  const downOpen = (e: React.PointerEvent) => { down(e); try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* not capturable */ } };
  const moveOpen = (e: React.PointerEvent) => { const s = g.current; if (!s || s.id !== e.pointerId) return; if (e.clientY - s.y < -24) { g.current = null; setSheet(lastTab.current); } };
  const upOpen = (e: React.PointerEvent) => { const s = g.current; g.current = null; if (!s || s.id !== e.pointerId) return; const dy = e.clientY - s.y; if (dy < -18 || Math.abs(dy) < 8) setSheet(lastTab.current); };
  const upClose = (e: React.PointerEvent) => { const s = g.current; g.current = null; if (!s || s.id !== e.pointerId) return; if (e.clientY - s.y > 36) setSheet(null); };

  if (!phone || !L) return null;
  const sim = /\/flight\/sim/.test(typeof location !== "undefined" ? location.pathname : "");
  const zl = zoneLine(mcap);
  const badge = grad ? { t: GRAD_BADGE, c: "#F3DFA8" } : rules && Number.isInteger(rules.mode) && MODE[rules.mode!] ? { t: MODE[rules.mode!].t + (rules.capBps ? ` · ${capTxt(rules.capBps)} CAP` : ""), c: MODE[rules.mode!].c }
    : sim ? { t: "SIM", c: "#C9B6F2" } : null;
  const ticker = rules?.ticker ? `$${rules.ticker.replace(/^\$/, "")}` : "";
  const bagUsd = pnl?.valueUsd ?? 0, bagPct = pnl?.txt?.pct ?? "", neg = (pnl?.uPnl ?? 0) < 0;
  const bag = <span>Your bag <b style={{ color: "#F2F3F7", fontWeight: 600 }}>{`$${bagUsd.toFixed(2)}`}</b>{bagUsd > 0 && bagPct ? <b style={{ color: neg ? "#FF7FB3" : "#5FF0A0", fontWeight: 600 }}> {bagPct}</b> : null}</span>;
  const glass: React.CSSProperties = { background: "rgba(18,19,39,.78)", border: "1px solid #2E323A", boxSizing: "border-box" };
  const sq: React.CSSProperties = { ...glass, width: 44, height: 44, borderRadius: 12, display: "grid", placeItems: "center", cursor: "pointer", padding: 0, color: "#F2F3F7" };
  const name = me?.name ? me.name : me ? `${me.address.slice(0, 6)}…${me.address.slice(-4)}` : "";
  const openMenu = () => { (document.getElementById("apReopen") as HTMLElement | null)?.click(); };

  // holders sheet: ranked real holders (pool / curve rows left out), or the session boosters on sim / paper
  const ranked = holders?.items ? holders.items.filter((r) => !r.label) : null;
  const legacy = !ranked && holders ? holders.rows : null;
  const count = ranked ? ranked.length : legacy ? legacy.length : 0;
  const top10 = ranked ? ranked.slice(0, 10).reduce((a, r) => a + (r.pct || 0), 0) : 0;

  return (
    <>
      {/* bottom scrim: the chips and buttons stay readable over bright clouds — never takes input */}
      <div aria-hidden style={{ position: "fixed", left: 0, right: 0, bottom: 0, height: 260, zIndex: 24, pointerEvents: "none",
        background: "linear-gradient(to bottom, rgba(8,10,22,0) 0%, rgba(8,10,22,.6) 50%, rgba(8,10,22,.85) 100%)" }} />
      {!sheet && <>
        <div data-testid="phone-toprow" style={{ position: "fixed", left: 12, right: 12, top: L.top, zIndex: 45, display: "flex", alignItems: "center", justifyContent: "space-between", pointerEvents: "none" }}>
          <button type="button" aria-label="Menu" data-testid="phone-menu" onClick={openMenu} style={{ ...sq, pointerEvents: "auto" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F2F3F7" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M4 7h16M4 12h16M4 17h16" /></svg></button>
          {cta ? <button type="button" data-testid="phone-signin" onClick={() => dispatchEvent(new Event(WALLET_CTA_CLICK_EVENT))}
            style={{ all: "unset", pointerEvents: "auto", cursor: "pointer", height: 44, boxSizing: "border-box", padding: "0 18px", borderRadius: 999, background: "#F2C14E", color: "#121327",
              display: "flex", alignItems: "center", font: `800 17px/1 ${G}`, letterSpacing: ".04em", textTransform: "uppercase" }}>{cta}</button>
            : name ? <Link href="/achievements" data-testid="phone-pilot" aria-label={xp ? `Level ${xp.level.level}, ${name}. See trophies` : name}
              style={{ ...glass, pointerEvents: "auto", display: "flex", alignItems: "center", gap: 8, height: 44, padding: `0 12px 0 ${xp ? 6 : 12}px`, borderRadius: 999, color: "#F2F3F7", textDecoration: "none", maxWidth: "calc(100vw - 140px)" }}>
              {xp && <LevelRing info={xp.level} size={32} />}
              <span style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span></Link>
            : <span />}
          <Link href="/" aria-label="Leave flight" title="Leave flight" data-testid="flight-leave" style={{ ...sq, pointerEvents: "auto" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F2F3F7" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg></Link>
        </div>
        <div ref={headRef} data-testid="phone-header" style={{ ...glass, position: "fixed", left: 12, right: 12, top: L.headTop, zIndex: 34, padding: "12px 14px", borderRadius: 16, display: "flex", flexDirection: "column", gap: 7, color: "#F2F3F7", pointerEvents: "none" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
              <span data-testid="phone-mcap" style={{ font: `800 32px/1 ${G}` }}>{mcap > 0 ? shortUsd(mcap) : "…"}</span>
              {ticker && <span style={{ font: `700 16px/1 ${G}`, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ticker}</span>}</span>
            {badge && <span data-testid="phone-mode" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 8px", borderRadius: 6, border: `1px solid ${badge.c}`, font: `700 13px/1.2 ${G}`, whiteSpace: "nowrap" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: badge.c }} />{badge.t}</span>}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, font: `600 15px/1.1 ${G}` }}>
            <span data-testid="phone-zone" style={{ color: "#F3DFA8", fontWeight: 700 }}>{zl.zone}</span>
            {zl.next && <span data-testid="phone-next" style={{ color: "#5FF0A0" }}>{zl.next}</span>}</div>
          <div style={{ height: 6, borderRadius: 999, background: "rgba(255,255,255,.12)" }}><div style={{ width: `${Math.round(zl.f * 100)}%`, height: 6, borderRadius: 999, background: "#F2C14E" }} /></div>
          <div data-testid="phone-stats" style={{ display: "flex", justifyContent: "space-between", gap: 6, fontSize: 12, color: "rgba(215,217,228,.85)", whiteSpace: "nowrap" }}>
            {bag}
            {stats.cash != null && <span>Cash <b style={{ color: "#F2F3F7", fontWeight: 600 }}>{cashUsd(stats.cash)}</b></span>}
            {stats.room != null && <span data-testid="phone-room" title="How much more you can boost before this rocket's wallet limit">Room <b style={{ color: "#F3DFA8", fontWeight: 600 }}>{shortUsd(stats.room)}</b></span>}
          </div>
        </div>
        <button type="button" data-testid="phone-handle" aria-label="Open holders and chart"
          onPointerDown={downOpen} onPointerMove={moveOpen} onPointerUp={upOpen} onPointerCancel={() => { g.current = null; }}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSheet(lastTab.current); } }}
          style={{ ...glass, position: "fixed", left: "50%", transform: "translateX(-50%)", top: L.pillTop, zIndex: 31, height: PILL_H, padding: "0 14px", borderRadius: 999,
            display: "flex", alignItems: "center", gap: 8, color: "rgba(215,217,228,.9)", font: `700 14px/1 ${G}`, letterSpacing: 1, cursor: "pointer", touchAction: "none", whiteSpace: "nowrap" }}>
          <span aria-hidden style={{ width: 28, height: 4, borderRadius: 2, background: "rgba(215,217,228,.5)" }} />HOLDERS · CHART</button>
      </>}
      {sheet && <>
        <div data-testid="phone-dim" onPointerDown={(e) => { e.preventDefault(); setSheet(null); }}
          style={{ position: "fixed", inset: 0, zIndex: 29, background: "rgba(5,6,14,.35)" }} />
        <div data-testid="phone-header-mini" style={{ ...glass, background: "rgba(18,19,39,.82)", position: "fixed", left: 12, right: 12, top: L.top, zIndex: 30, padding: "10px 14px", borderRadius: 16,
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, color: "#F2F3F7", pointerEvents: "none" }}>
          <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}><span style={{ font: `800 26px/1 ${G}` }}>{mcap > 0 ? shortUsd(mcap) : "…"}</span>
            <span style={{ font: `700 15px/1 ${G}`, color: "#F3DFA8" }}>{zl.zone}</span></span>
          <span style={{ fontSize: 12, color: "rgba(215,217,228,.85)", whiteSpace: "nowrap" }}>{bag}</span>
        </div>
        <section data-testid="phone-drawer" aria-label="Holders and chart" style={{ position: "fixed", left: 0, right: 0, top: L.dTop, bottom: 0, zIndex: 30, pointerEvents: "none", boxSizing: "border-box",
          borderRadius: "24px 24px 0 0", borderTop: "1px solid #2E323A",
          background: sheet === "chart" && !(window as unknown as { __domChart?: boolean }).__domChart
            ? `linear-gradient(to bottom, ${DRAWER_BG} 0, ${DRAWER_BG} ${L.body.y - L.dTop}px, transparent ${L.body.y - L.dTop}px, transparent ${L.body.y - L.dTop + L.body.h}px, ${DRAWER_BG} ${L.body.y - L.dTop + L.body.h}px)` : "rgba(14,16,32,.97)" }}>
          <div data-testid="phone-drawer-head" onPointerDown={down} onPointerUp={upClose} onPointerCancel={() => { g.current = null; }} style={{ pointerEvents: "auto", padding: "0 16px", touchAction: "none" }}>
            <button type="button" data-testid="phone-drawer-close" aria-label="Close holders and chart" onClick={() => setSheet(null)}
              style={{ all: "unset", display: "grid", placeItems: "center", width: "100%", height: S_GRAB, cursor: "pointer" }}>
              <span style={{ width: 44, height: 5, borderRadius: 3, background: "rgba(215,217,228,.35)" }} /></button>
            <div role="tablist" aria-label="Sheet" style={{ display: "flex", gap: 4, padding: 4, height: S_TABS, boxSizing: "border-box", borderRadius: 12, background: "rgba(255,255,255,.05)" }}>
              {SHEET_TABS.map((t) => <button key={t.id} type="button" role="tab" data-testid={`drawer-tab-${t.id}`} aria-selected={sheet === t.id} onClick={() => setSheet(t.id)}
                style={{ all: "unset", flex: "1 1 0", textAlign: "center", borderRadius: 9, cursor: "pointer", font: `800 17px/1 ${G}`, letterSpacing: 1,
                  color: sheet === t.id ? "#121327" : "rgba(215,217,228,.8)", background: sheet === t.id ? "#F2F3F7" : "transparent" }}>{t.label}{t.id === "holders" && count > 0 ? ` ${count >= 50 ? "50+" : count}` : ""}</button>)}
            </div>
          </div>
          {sheet === "holders" && <div data-testid="phone-holders" style={{ position: "absolute", left: SIDE, right: SIDE, top: L.body.y - L.dTop, height: L.body.h, overflowY: "auto", pointerEvents: "auto", overscrollBehavior: "contain", color: "#F2F3F7" }}>
            <div style={{ display: "flex", justifyContent: "space-between", margin: "2px 2px 6px", fontSize: 12, color: "rgba(215,217,228,.7)" }}>
              {ranked ? <span>Top 10 hold <b style={{ color: "#F2F3F7", fontWeight: 600 }}>{top10.toFixed(0)}%</b></span> : <span>Top boosters</span>}
              <span>Cap per wallet <b style={{ color: "#F2F3F7", fontWeight: 600 }}>{rules?.capBps && !grad ? capTxt(rules.capBps) : "none"}</b></span></div>
            {!holders && <div style={{ padding: "12px 2px", fontSize: 13, opacity: 0.7 }}>Reading holders…</div>}
            {holders && !count && <div style={{ padding: "12px 2px", fontSize: 13, opacity: 0.7 }}>No holders yet. Be the first boost.</div>}
            {ranked && ranked.map((r, i) => <HolderRow key={r.address} rank={i + 1} who={r.mine ? "You" : r.who} mine={r.mine} val={`${r.pct.toFixed(2)}%`} ring={r.mine && xp ? xp.level : null} />)}
            {legacy && legacy.map(([w, v], i) => <HolderRow key={w} rank={i + 1} who={w === "you" ? "You" : w} mine={w === "you"} val={shortUsd(v)} ring={w === "you" && xp ? xp.level : null} />)}
          </div>}
        </section>
      </>}
      <style jsx global>{`
        /* ---- phone flight v2 (html.ap-phone) ----
           These hide or move SITE pieces from GAME's phone layer only: the old cash / total cards, the Crew rewards pill, the
           wallet strip (sign in lives on the pilot chip), the site menu button (our ☰ opens the same menu), PnL / crew panels. */
        html.ap-phone #apReopen,
        html.ap-phone .coin-id,
        html.ap-phone [aria-label="cash and portfolio"],
        html.ap-phone .wb-root .wb-row,
        html.ap-phone .cl-coin,
        html.ap-phone [data-testid="settings-btn"],
        html.ap-phone [data-testid="crew-panel"],
        html.ap-phone .ap-bc:has(> [data-testid="tw-open"]),
        html.ap-phone [data-testid="tw-list"],
        html.ap-phone [data-testid="flight-pills"],
        html.ap-phone .pnl-hud { display: none !important; }
        html.ap-phone:not([data-ph-sheet=""]) [data-testid="chat-dock"],
        html.ap-phone:not([data-ph-sheet=""]) [data-testid="radio-mini"],
        html.ap-phone:not([data-ph-sheet=""]) [data-testid="radio-pill"],
        html.ap-phone:not([data-ph-sheet=""]) [data-testid="sim-chip"],
        html.ap-phone:not([data-ph-sheet=""]) [data-testid="sim-bar"] { display: none !important; }
        /* anti-snipe chip (#133): stays visible, just above the HOLDERS · CHART pill */
        html.ap-phone .ap-bc[data-testid="snipe-chip"],
        html.ap-phone .ap-bc:has(> [data-testid="snipe-chip"]) { bottom: calc(100dvh - var(--ph-pill-top) + 8px) !important; top: auto !important; z-index: 33 !important; }
      `}</style>
    </>
  );
}

function HolderRow({ rank, who, mine, val, ring }: { rank: number; who: string; mine: boolean; val: string; ring: { level: number; progress: number; prestige: number } | null }) {
  return <div data-testid={mine ? "holder-mine" : "holder-row"} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 48, borderBottom: "1px solid rgba(46,50,58,.7)",
    ...(mine ? { background: "rgba(242,193,78,.08)", margin: "0 -8px", padding: "0 8px", borderRadius: 8 } : {}) }}>
    <span style={{ width: 18, font: `700 15px/1 ${G}`, color: "#F3DFA8" }}>{rank}</span>
    {ring ? <LevelRing info={ring} size={28} /> : <span aria-hidden style={{ width: 28, height: 28, flex: "none", borderRadius: "50%", boxSizing: "border-box", display: "grid", placeItems: "center", font: `800 13px/1 ${G}`,
      ...(mine ? { border: "2px solid #F2C14E", color: "#F2F3F7" } : { background: avaOf(who), color: "#121327" }) }}>{mine ? "Y" : (who.replace(/^0x/i, "")[0] || "?").toUpperCase()}</span>}
    <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: mine ? 600 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{who}</span>
    <span style={{ font: `700 16px/1 ${G}` }}>{val}</span>
  </div>;
}

/** true while the phone HUD is on (html.ap-phone, set above) — TradeBridge swaps in the phone trade bar, GameChat its sky feed */
export function useIsPhoneHud() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const de = document.documentElement, f = () => setOn(de.classList.contains("ap-phone"));
    f(); const mo = new MutationObserver(f); mo.observe(de, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return on;
}
