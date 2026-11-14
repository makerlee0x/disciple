"use client";

import type React from "react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import LevelRing from "@/components/xp/LevelRing";
import PhoneChart from "./PhoneChart";
import { openCash } from "@/lib/cashLink";
import { usePilotWallet, useXp } from "@/lib/xpClient";
import { FLIGHT_TIERS, GRAD_BADGE, tierIndexAt } from "@/lib/flight/tiers";
import { WALLET_CTA_EVENT, WALLET_ID_EVENT, walletCtaLabel, walletId, type WalletId } from "@/lib/walletCta";

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
type PnlView = { valueUsd?: number; entryMcap?: number; pnlPct?: number; txt?: { pnl: string; pct: string; pos?: string }; uPnl?: number } | null;
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
  const [chartTf, setChartTf] = useState(0);
  const [chartBig, setChartBig] = useState(false);
  const [banked, setBanked] = useState(0);
  const [basis, setBasis] = useState(0);
  const [floats, setFloats] = useState<{ id: number; t: string; k: string }[]>([]);
  const [steerHint, setSteerHint] = useState(false);

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
    w.__phoneHud = { on: true, v2: true, thr: true, sheet, drawer: !!sheet, pillTop: L.toastTop, toastTop: L.toastTop, hudTop: L.pillTop, dTop: sheet ? L.dTop : 0, body: L.body };
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

  // bag card: cost basis (disciple:position) and BANKED (PnlHud disciple:banked, realized $ on this rocket)
  const lastReal = useRef<number | null>(null);
  const float = useCallback((t: string, k: string) => {
    const id = Date.now() + Math.random();
    setFloats((f) => [...f.slice(-3), { id, t, k }]); setTimeout(() => setFloats((f) => f.filter((x) => x.id !== id)), 1400);
  }, []);
  useEffect(() => {
    const W = window as unknown as { __banked?: { realized?: number; costBasis?: number } };
    if (W.__banked) { setBanked(W.__banked.realized ?? 0); lastReal.current = W.__banked.realized ?? 0; }
    const onBank = (e: Event) => {
      const r = (e as CustomEvent<{ realized?: number }>).detail?.realized ?? 0;
      const prev = lastReal.current; lastReal.current = r; setBanked(r);
      if (prev != null && Math.abs(r - prev) >= 0.01) float(`BANKED ${r - prev >= 0 ? "+" : "-"}$${Math.abs(r - prev).toFixed(2)}`, r - prev >= 0 ? "bank" : "loss");
    };
    const onPos = (e: Event) => { const c = (e as CustomEvent<{ costBasis?: number }>).detail?.costBasis; setBasis(typeof c === "number" && c > 0 ? c : 0); };
    // (a boost already gets the engine's own "+$X aboard" pop; a dump gets this BANKED one)
    addEventListener("disciple:banked", onBank); addEventListener("disciple:position", onPos);
    return () => { removeEventListener("disciple:banked", onBank); removeEventListener("disciple:position", onPos); };
  }, [float]);
  // first flights: "drag the sky to steer" for a few seconds, until the pilot has steered once
  useEffect(() => {
    if (!phone) return;
    let seen = false; try { seen = localStorage.getItem("disciple.steerhint") === "1"; } catch { /* private mode */ }
    if (seen) return;
    const done = () => { setSteerHint(false); try { localStorage.setItem("disciple.steerhint", "1"); } catch { /* */ } removeEventListener("pointerdown", onDown, true); };
    const onDown = (e: PointerEvent) => { if ((e.target as Element | null)?.tagName === "CANVAS") done(); };
    const t0 = setTimeout(() => setSteerHint(true), 2500), t1 = setTimeout(() => setSteerHint(false), 9000);
    addEventListener("pointerdown", onDown, true);
    return () => { clearTimeout(t0); clearTimeout(t1); removeEventListener("pointerdown", onDown, true); };
  }, [phone]);

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
    : sim ? { t: "FREE PLAY", c: "#C9B6F2" } : null;
  const ticker = rules?.ticker ? `$${rules.ticker.replace(/^\$/, "")}` : "";
  const bagUsd = pnl?.valueUsd ?? 0, bagPct = pnl?.txt?.pct ?? "", neg = (pnl?.uPnl ?? 0) < 0;
  const bag = <span>Your bag <b style={{ color: "#F2F3F7", fontWeight: 600 }}>{`$${bagUsd.toFixed(2)}`}</b>{bagUsd > 0 && bagPct ? <b style={{ color: neg ? "#FF7FB3" : "#5FF0A0", fontWeight: 600 }}> {bagPct}</b> : null}</span>;
  const glass: React.CSSProperties = { background: "rgba(18,19,39,.78)", border: "1px solid #2E323A", boxSizing: "border-box" };
  const sq: React.CSSProperties = { ...glass, position: "relative", width: 44, height: 44, borderRadius: 12, display: "grid", placeItems: "center", cursor: "pointer", padding: 0, color: "#F2F3F7" };
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
        {/* throttle layout (flight direction D, maker 2026-11-14; prototype v12): top row · chart card · icon column + crew feed ·
            lever on the right (TradeBridge → PhoneThrottle) · YOUR BAG card bottom left */}
        <div data-testid="phone-toprow" style={{ position: "fixed", left: 12, right: 12, top: L.top, zIndex: 45, height: 48, display: "flex", alignItems: "center", justifyContent: "space-between", pointerEvents: "none" }}>
          {!cta && name ? <Link href="/profile" data-testid="phone-pilot" aria-label={xp ? `Level ${xp.level.level}, ${name}. Open your profile` : `${name}. Open your profile`}
              style={{ ...glass, pointerEvents: "auto", width: 48, height: 48, borderRadius: "50%", display: "grid", placeItems: "center", color: "#F2F3F7", textDecoration: "none", font: `800 18px/1 ${G}` }}>
              {xp ? <LevelRing info={xp.level} size={40} /> : name.slice(0, 1).toUpperCase()}</Link>
            : <span style={{ width: 48 }} />}
          <div data-testid="phone-mc" style={{ position: "absolute", left: "50%", transform: "translateX(-50%)", top: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <span data-testid="phone-mcap" style={{ font: `800 30px/1 ${G}`, color: "#F2F3F7", textShadow: "0 2px 0 #121327", fontVariantNumeric: "tabular-nums" }}>{mcap > 0 ? shortUsd(mcap) : "…"}</span>
            <span style={{ width: 120, height: 7, borderRadius: 4, background: "rgba(0,0,0,.45)", border: "1px solid rgba(255,255,255,.35)", overflow: "hidden" }}>
              <span style={{ display: "block", width: `${Math.round(zl.f * 100)}%`, height: "100%", background: "#F2C14E" }} /></span>
            <span data-testid="phone-next" style={{ font: `700 12px/1 ${G}`, letterSpacing: ".5px", color: "#F3DFA8", textShadow: "0 1px 2px rgba(0,0,0,.9)", whiteSpace: "nowrap", textTransform: "uppercase" }}>
              {zl.next || <span data-testid="phone-zone">{zl.zone}</span>}</span>
          </div>
          <span style={{ display: "flex", alignItems: "center", gap: 6, pointerEvents: "auto" }}>
            {stats.cash != null && <button type="button" data-testid="phone-cash" aria-label={`Cash ${cashUsd(stats.cash)}. Add cash`} onClick={() => openCash("add")}
              style={{ ...glass, height: 40, borderRadius: 999, padding: "0 5px 0 11px", display: "flex", alignItems: "center", gap: 7, color: "#F2F3F7", font: `800 17px/1 ${G}`, cursor: "pointer", fontVariantNumeric: "tabular-nums" }}>
              {cashUsd(stats.cash)}<span aria-hidden style={{ width: 28, height: 28, borderRadius: "50%", background: "#5FF0A0", color: "#121327", display: "grid", placeItems: "center", fontSize: 20 }}>+</span></button>}
            <Link href="/" aria-label="Leave flight" title="Leave flight" data-testid="flight-leave" style={{ ...sq, width: 40, height: 40 }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#F2F3F7" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg></Link>
          </span>
        </div>
        <div ref={headRef} data-testid="phone-header" style={{ position: "fixed", left: 12, right: 12, top: L.top + 58, height: chartBig ? 200 : 104, zIndex: 34, transition: "height .25s ease" }}>
          <PhoneChart tf={chartTf} onTf={setChartTf} big={chartBig} onBig={() => setChartBig((b) => !b)} entry={pnl?.entryMcap ?? null} ticker={ticker} badge={badge} />
        </div>
        <nav data-testid="phone-side" aria-label="Flight tools" style={{ position: "fixed", left: 12, top: L.feedTop + 52, zIndex: 35, display: "flex", flexDirection: "column", gap: 8 }}>
          <button type="button" data-testid="phone-handle" aria-label="Open holders and chart" title="Holders · chart"
            onPointerDown={downOpen} onPointerMove={moveOpen} onPointerUp={upOpen} onPointerCancel={() => { g.current = null; }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSheet(lastTab.current); } }} style={{ ...sq, touchAction: "none" }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#F2F3F7" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20c.8-3 3.2-5 6-5s5.2 2 6 5M14 15.3c.6-.2 1.3-.3 2-.3 2.8 0 5.2 2 6 5" /></svg>
            {count > 0 && <span aria-hidden style={{ position: "absolute", right: -5, top: -5, minWidth: 20, height: 20, padding: "0 5px", boxSizing: "border-box", borderRadius: 999, background: "#F2C14E", color: "#121327", font: `800 13px/20px ${G}`, textAlign: "center", border: "2px solid #121327" }}>{count >= 50 ? "50+" : count}</span>}
          </button>
          <button type="button" data-testid="phone-gear" aria-label="Boost amounts and trade settings" onClick={() => dispatchEvent(new CustomEvent("disciple:swapsettings", { detail: { open: true } }))} style={sq}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#F2F3F7" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg></button>
          <Link href="/achievements" data-testid="phone-missions" aria-label="Missions and trophies" style={sq}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#F2F3F7" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z" /></svg></Link>
          <button type="button" aria-label="Menu" data-testid="phone-menu" onClick={openMenu} style={sq}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F2F3F7" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M4 7h16M4 12h16M4 17h16" /></svg></button>
        </nav>
        {!(cta && !sim) && <PhoneBag value={bagUsd} cost={basis} pnl={pnl?.uPnl ?? 0} pct={pnl?.pnlPct ?? 0} room={stats.room} banked={banked} holding={bagUsd > 0} />}
        {steerHint && <div data-testid="steer-hint" aria-hidden className="ph-steer">⟵ DRAG THE SKY TO STEER ⟶</div>}
        {floats.map((f) => <span key={f.id} aria-hidden className={`ph-float ${f.k}`}>{f.t}</span>)}
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
        /* throttle layout: crew feed next to the icon column, its chat button at the top of the column */
        html.ap-phone [data-testid="chat-dock"]:not([data-open]) { left: 72px !important; }
        /* Free play's timer chip: right side under the chart card (the chat button moved to the icon column) */
        html.ap-phone [data-testid="sim-chip"] { top: var(--ph-feed-top) !important; }
        html.ap-phone [data-testid="chat-dock"]:not([data-open]) [data-testid="chat-open"] { position: fixed !important; left: 12px !important; right: auto !important; top: var(--ph-feed-top) !important; }
        html.ap-phone [data-testid="chat-dock"]:not([data-open]) [data-testid="chat-list"] { width: min(220px, calc(100vw - 230px)) !important; }
        .pc { position: absolute; inset: 0; border-radius: 16px; background: rgba(12,13,28,.78); border: 2px solid rgba(255,255,255,.16); overflow: hidden; cursor: pointer; box-sizing: border-box; }
        .pc canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
        .pc-lab { position: absolute; left: 10px; top: 8px; display: flex; gap: 8px; align-items: baseline; font: 700 12px/1 ${G}; letter-spacing: .8px; color: rgba(215,217,228,.85); pointer-events: none; }
        .pc-lab b { font-weight: 800; color: #F2F3F7; letter-spacing: .3px; }
        .pc-badge { position: absolute; left: 8px; bottom: 7px; display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px; border-radius: 6px; border: 1px solid; background: rgba(12,13,28,.85);
          font: 700 11px/1.3 ${G}; letter-spacing: .4px; color: #F2F3F7; pointer-events: none; white-space: nowrap; }
        .pc-badge i { width: 5px; height: 5px; border-radius: 50%; }
        .pc-tf { position: absolute; right: 4px; top: 3px; display: flex; gap: 2px; }
        .pc-tf button { all: unset; box-sizing: border-box; min-width: 36px; height: 32px; padding: 0 8px; border-radius: 9px; text-align: center; background: rgba(255,255,255,.08); color: rgba(215,217,228,.85); font: 800 14px/32px ${G}; letter-spacing: .4px; cursor: pointer; }
        .pc-tf button.on { background: #F2F3F7; color: #121327; }
        .pc-tf button:focus-visible { outline: 2px solid #F2C14E; }
        .ph-bag { position: fixed; left: 12px; right: calc(146px + env(safe-area-inset-right, 0px)); bottom: var(--ph-bar-bottom, 24px); z-index: 36; box-sizing: border-box; border-radius: 18px;
          padding: 10px 10px 10px 13px; background: rgba(12,13,28,.94); border: 2px solid rgba(255,255,255,.22); display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px 8px; align-items: center;
          box-shadow: 0 10px 26px rgba(0,0,0,.45); color: #F2F3F7; transition: border-color .2s, box-shadow .2s; }
        .ph-bag > small { font: 700 12px/1 ${G}; letter-spacing: .9px; color: rgba(215,217,228,.85); }
        .ph-bagv { font: 800 clamp(28px, 8.6vw, 38px)/1 ${G}; font-variant-numeric: tabular-nums; white-space: nowrap; display: inline-block; transform-origin: left center; }
        .ph-bagsub { grid-column: 1 / -1; font-size: 12px; color: rgba(215,217,228,.85); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .ph-bagsub b { color: #F2F3F7; font-weight: 600; }
        .ph-pnl { grid-row: 1 / 3; grid-column: 2; align-self: stretch; min-width: 70px; border-radius: 13px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; padding: 0 9px;
          background: #23262F; color: rgba(215,217,228,.85); }
        .ph-pnl b { font: 800 24px/1 ${G}; font-variant-numeric: tabular-nums; }
        .ph-pnl small { font-size: 12px; opacity: .9; }
        .ph-bag.up { border-color: #5FF0A0; box-shadow: 0 0 0 3px rgba(95,240,160,.18), 0 10px 26px rgba(0,0,0,.45); }
        .ph-bag.up .ph-pnl { background: #5FF0A0; color: #0d2a1b; }
        .ph-bag.dn { border-color: #F0307F; box-shadow: 0 0 0 3px rgba(240,48,127,.2), 0 10px 26px rgba(0,0,0,.45); }
        .ph-bag.dn .ph-pnl { background: #F0307F; color: #FFFFFF; }
        .ph-bank { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px; padding: 6px 10px; border-radius: 11px;
          background: rgba(95,240,160,.16); border: 1.5px solid rgba(95,240,160,.55); }
        .ph-bank small { color: #5FF0A0; font: 800 15px/1 ${G}; letter-spacing: .6px; }
        .ph-bank b { font: 800 24px/1 ${G}; font-variant-numeric: tabular-nums; color: #5FF0A0; display: inline-block; transform-origin: right center; }
        .ph-bank.neg { background: rgba(240,48,127,.16); border-color: rgba(240,48,127,.6); }
        .ph-bank.neg small, .ph-bank.neg b { color: #FF8FBD; }
        .ph-bump { animation: ph-bump .35s ease-out; }
        @keyframes ph-bump { 30% { transform: scale(1.16); } }
        .ph-steer { position: fixed; left: 12px; right: 146px; bottom: calc(var(--ph-bar-bottom, 24px) + 150px); z-index: 33; text-align: center; font: 800 16px/1 ${G}; letter-spacing: .6px; color: #F2F3F7;
          text-shadow: 0 2px 4px rgba(0,0,0,.9); pointer-events: none; animation: ph-hint 1.6s ease-in-out infinite; }
        @keyframes ph-hint { 50% { transform: translateX(10px); } }
        .ph-float { position: fixed; left: 50%; top: 46%; z-index: 37; transform: translate(-50%, 0); pointer-events: none; white-space: nowrap; font: 800 40px/1 ${G}; text-shadow: 0 3px 0 #121327, 0 0 18px rgba(0,0,0,.6);
          animation: ph-float 1.4s ease-out forwards; }
        .ph-float.bank { color: #5FF0A0; font-size: 34px; top: 52%; }
        .ph-float.loss { color: #FF8FBD; font-size: 34px; top: 52%; }
        @keyframes ph-float { 0% { opacity: 0; transform: translate(-50%, 10px) scale(.6); } 15% { opacity: 1; transform: translate(-50%, 0) scale(1.15); } 30% { transform: translate(-50%, -6px) scale(1); } 100% { opacity: 0; transform: translate(-50%, -80px) scale(1); } }
        @media (prefers-reduced-motion: reduce) { .ph-steer, .ph-float, .ph-bump { animation: none; } }
        /* anti-snipe chip (#133): stays visible, just above the HOLDERS · CHART pill */
        html.ap-phone .ap-bc[data-testid="snipe-chip"],
        html.ap-phone .ap-bc:has(> [data-testid="snipe-chip"]) { bottom: calc(100dvh - var(--ph-pill-top) + 8px) !important; top: auto !important; z-index: 33 !important; }
      `}</style>
    </>
  );
}

/** YOUR BAG card (throttle prototype v3-v5, maker: the bag and PnL are "the whole point"): the bag's value big, a PnL chip that
 *  turns green / pink, what you put in and the Room left, and a BANKED row once you've sold some. */
function PhoneBag({ value, cost, pnl, pct, room, banked, holding }: { value: number; cost: number; pnl: number; pct: number; room: number | null; banked: number; holding: boolean }) {
  const up = holding && pnl >= 0, dn = holding && pnl < 0;
  const vref = useRef<HTMLSpanElement>(null), bref = useRef<HTMLElement>(null);
  const bump = (el: HTMLElement | null) => { if (!el) return; el.classList.remove("ph-bump"); void el.offsetWidth; el.classList.add("ph-bump"); };
  const vTxt = value < 1000 ? `$${value.toFixed(2)}` : `$${Math.round(value).toLocaleString("en-US")}`;
  const bTxt = `${banked >= 0 ? "+" : "-"}$${Math.abs(banked).toFixed(2)}`;
  const lastV = useRef(vTxt), lastB = useRef(bTxt);
  useEffect(() => { if (lastV.current !== vTxt && Math.abs(value - parseFloat(lastV.current.replace(/[$,]/g, ""))) > Math.max(0.5, value * 0.03)) bump(vref.current); lastV.current = vTxt; }, [vTxt, value]);
  useEffect(() => { if (lastB.current !== bTxt) bump(bref.current); lastB.current = bTxt; }, [bTxt]);
  return (
    <div data-testid="phone-bag" className={`ph-bag${up ? " up" : dn ? " dn" : ""}`} aria-live="polite">
      <small>YOUR BAG</small>
      <div className="ph-pnl" data-testid="phone-bag-chip"><b>{holding ? `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%` : "--"}</b><small>{holding ? `${pnl >= 0 ? "+$" : "-$"}${Math.abs(pnl).toFixed(2)}` : "no bag"}</small></div>
      <div style={{ minWidth: 0, overflow: "hidden" }}><span ref={vref} className="ph-bagv" data-testid="phone-bag-value">{vTxt}</span></div>
      <div className="ph-bagsub">{holding && cost > 0 ? <>Put in <b>{cashUsdBag(cost)}</b></> : <>Slide up to board</>}{room != null ? <> · Room <b>{shortUsd(room)}</b></> : null}</div>
      {Math.abs(banked) >= 0.01 && <div className={`ph-bank${banked < 0 ? " neg" : ""}`} data-testid="phone-banked"><small>BANKED</small><b ref={bref}>{bTxt}</b></div>}
    </div>
  );
}
const cashUsdBag = (v: number) => (v >= 100 ? `$${Math.round(v).toLocaleString("en-US")}` : `$${v.toFixed(2)}`);

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
