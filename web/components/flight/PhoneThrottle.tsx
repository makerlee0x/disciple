"use client";

import type React from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { WALLET_CTA_EVENT, walletCtaLabel } from "@/lib/walletCta";
import { haptic } from "@/lib/game/haptics";
import PhoneTradeBar, { type PhoneTradeBarProps } from "./PhoneTradeBar";

/**
 * Phone throttle (flight direction D, maker 2026-11-14: "build the prototype" into the real phone flight). One lever on the
 * right edge replaces the BOOST / DUMP bar. Same props and the same TradeBridge actions as PhoneTradeBar, layout only.
 *   Slide UP through the boost notches ($10 · $25 · $50 · $100, the player's own presets), DOWN through the dump notches
 *   (10% · 25% · half · ALL). Each notch clicks (haptic). Let go on a notch = that trade fires and that amount becomes the
 *   selected one. Let go between notches = nothing. A quick tap on the handle repeats the selected boost.
 *   ALL sits at the very bottom, so emptying the bag takes a long deliberate drag (no extra hold needed).
 *   A boost notch over the wallet cap's room is struck through; letting go there still goes to TradeBridge, whose wallet-limit
 *   card offers Boost max (same as a dashed chip on the bar).
 * Steering is the engine's own drag-the-sky (engine.js @drag-steer), so the left of the screen stays free for it.
 * Signed out, and while the Holders · Chart sheet is open, this falls back to PhoneTradeBar (sign-in button / compact buttons
 * under the sheet).
 */
export type PhoneThrottleProps = PhoneTradeBarProps & {
  /** fire the boost at preset i (the amount is passed with the shot, so it never waits for the selection to re-render) */
  onBoostAt: (i: number) => void;
  /** fire the dump at size i */
  onDumpAt: (i: number) => void;
};

/** Notch positions as a share of each half of the track, bottom of the half → far end. Pure, tested. */
export const THR_UP = [0.24, 0.46, 0.68, 0.9] as const;
export const THR_SNAP = 14;   // px either side of a notch that still counts as on it

export type ThrNotch = { side: "buy" | "sell"; i: number } | null;
/** Which notch the handle sits on. p = px from the rest point (negative = up), up/down = usable px each way. Pure, tested. */
export function notchAt(p: number, up: number, down: number, nBuy: number, nSell: number): ThrNotch {
  let hit: ThrNotch = null;
  if (p < 0) { for (let i = 0; i < Math.min(nBuy, THR_UP.length); i++) if (-p >= THR_UP[i] * up - THR_SNAP) hit = { side: "buy", i }; }
  else if (p > 0) { const f = sellFracs(nSell); for (let i = 0; i < f.length; i++) if (p >= f[i] * down - THR_SNAP) hit = { side: "sell", i }; }
  return hit;
}
/** Dump notches spread evenly from 30% to 94% of the lower half, ALL always last. Pure. */
export function sellFracs(n: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [0.94];
  return Array.from({ length: n }, (_, i) => +(0.3 + (0.64 * i) / (n - 1)).toFixed(3));
}

const REST = 0.5;   // rest point: half way down the track
const TAP_MS = 300, TAP_PX = 6;

export default function PhoneThrottle(p: PhoneThrottleProps) {
  const [cta, setCta] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  useEffect(() => { setCta(walletCtaLabel()); const c = (e: Event) => setCta((e as CustomEvent<{ label: string | null }>).detail?.label ?? null);
    addEventListener(WALLET_CTA_EVENT, c); return () => removeEventListener(WALLET_CTA_EVENT, c); }, []);
  useEffect(() => {
    const de = document.documentElement, f = () => setSheet(!!de.dataset.phSheet);
    f(); const mo = new MutationObserver(f); mo.observe(de, { attributes: true, attributeFilter: ["data-ph-sheet"] }); return () => mo.disconnect();
  }, []);

  const track = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(0);
  const [pos, setPos] = useState(0);
  const [drag, setDrag] = useState(false);
  const d = useRef<{ id: number; y0: number; p0: number; t0: number; moved: boolean } | null>(null);
  const spring = useRef<number | null>(null);
  const lastNotch = useRef("");
  useLayoutEffect(() => {
    const el = track.current; if (!el) return;
    const f = () => setH(el.clientHeight); f();
    const ro = new ResizeObserver(f); ro.observe(el); return () => ro.disconnect();
  }, [cta, sheet]);
  useEffect(() => () => { if (spring.current) cancelAnimationFrame(spring.current); }, []);
  const on = !((cta && !p.noSignIn) || sheet);
  useEffect(() => { const de = document.documentElement; de.classList.toggle("ph-thr", on); return () => de.classList.remove("ph-thr"); }, [on]);

  if (!on) return <PhoneTradeBar {...p} />;

  const mid = h * REST, up = mid - 30, down = h - mid - 30;
  const nBuy = Math.min(4, p.buyOpts.length), nSell = p.sellOpts.length, sf = sellFracs(nSell);
  const clampP = (v: number) => Math.max(-mid + 26, Math.min(h - mid - 26, v));
  const n = notchAt(pos, up, down, nBuy, nSell);
  const nKey = n ? `${n.side}${n.i}` : "";
  const full = !!p.inFlightFull;

  const move = (v: number) => {
    const c = clampP(v); setPos(c);
    const k = notchAt(c, up, down, nBuy, nSell), key = k ? `${k.side}${k.i}` : "";
    if (key !== lastNotch.current) {
      lastNotch.current = key;
      if (k) { p.onSide?.(k.side); haptic(k.side === "sell" && p.sellFracs[k.i] >= 0.999 ? "hold" : "select"); }
    }
  };
  const back = () => {
    if (spring.current) cancelAnimationFrame(spring.current);
    const from = pos, t0 = performance.now();
    const st = (t: number) => { const k = Math.min(1, (t - t0) / 180), e = 1 - Math.pow(1 - k, 3); setPos(from * (1 - e)); spring.current = k < 1 ? requestAnimationFrame(st) : null; };
    spring.current = requestAnimationFrame(st); lastNotch.current = "";
  };
  const fire = (k: Exclude<ThrNotch, null>) => {
    if (k.side === "buy") { if (p.boostDisabled) return; p.onPickBuy(k.i); p.onBoostAt(k.i); haptic("boost", true); }
    else { if (p.dumpDisabled) return; p.onPickSell(k.i); p.onDumpAt(k.i); haptic("dump", true); }
  };
  const onDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* old WebView */ }
    if (spring.current) { cancelAnimationFrame(spring.current); spring.current = null; }
    d.current = { id: e.pointerId, y0: e.clientY, p0: pos, t0: performance.now(), moved: false }; setDrag(true);
  };
  const onMove = (e: React.PointerEvent) => {
    const g = d.current; if (!g || g.id !== e.pointerId) return;
    const dy = e.clientY - g.y0; if (Math.abs(dy) > TAP_PX) g.moved = true;
    move(g.p0 + dy);
  };
  const onUp = (e: React.PointerEvent) => {
    const g = d.current; if (!g || g.id !== e.pointerId) return;
    d.current = null; setDrag(false);
    const tap = !g.moved && performance.now() - g.t0 < TAP_MS;
    if (tap) { if (!p.boostDisabled) { p.onBoost(); haptic("boost", true); } }
    else { const k = notchAt(pos, up, down, nBuy, nSell); if (k) fire(k); }
    back();
  };
  const onCancel = () => { d.current = null; setDrag(false); back(); };
  // keyboard: ↑/↓ walk the notches, Enter/Space fires the one you're on (or the selected boost at rest)
  const stops = [...THR_UP.slice(0, nBuy).map((f) => -f * up).reverse(), 0, ...sf.map((f) => f * down)];
  const onKey = (e: React.KeyboardEvent) => {
    let i = stops.findIndex((s) => Math.abs(s - pos) < 2); if (i < 0) i = stops.indexOf(0);
    if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); move(stops[Math.max(0, Math.min(stops.length - 1, i + (e.key === "ArrowUp" ? -1 : 1)))]); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (n) fire(n); else if (!p.boostDisabled) p.onBoost(); setPos(0); lastNotch.current = ""; }
    else if (e.key === "Escape") { setPos(0); lastNotch.current = ""; }
  };

  const tipText = full ? "3 IN FLIGHT"
    : !n ? (drag ? (pos < 0 ? "Keep going up" : pos > 0 ? "Keep going down" : "") : `Tap: boost ${p.buyLabel}`)
    : n.side === "buy" ? (p.boostDisabled ? p.boostTitle || "Can't boost" : p.buyOver?.[n.i] ? "WALLET LIMIT: LET GO FOR MAX" : `LET GO TO BUY ${p.buyOpts[n.i]}`)
    : p.dumpDisabled ? "NO BAG YET" : `LET GO TO SELL ${p.sellFracs[n.i] >= 0.999 ? "ALL" : p.sellOpts[n.i]}`;
  const line = p.hint || p.warn || "";

  return (
    <div className="thr" data-testid="trade-bar" data-throttle="1" aria-label="throttle">
      {line ? <div className={`thr-line${p.warn && !p.hint ? " warn" : ""}${p.warnOver ? " over" : ""}`} data-testid={p.hint ? "trade-hint" : "trade-warn"}>{line}</div> : null}
      <div className="thr-track" ref={track}>
        <div className="thr-up" style={{ height: mid }} />
        <div className="thr-dn" style={{ height: h - mid }} />
      </div>
      {h > 0 && THR_UP.slice(0, nBuy).map((f, i) => {
        const y = mid - f * up;
        return (<span key={`b${i}`}>
          <i className="thr-tick" style={{ top: y }} />
          <span className={`thr-det${nKey === `buy${i}` ? " on" : ""}${p.buySel === i ? " sel" : ""}${p.buyOver?.[i] ? " over" : ""}`} style={{ top: y }} data-testid={`thr-buy-${i}`}>{p.buyOpts[i]}</span>
        </span>);
      })}
      {h > 0 && sf.map((f, i) => {
        const y = mid + f * down, all = p.sellFracs[i] >= 0.999;
        return (<span key={`s${i}`}>
          <i className="thr-tick dn" style={{ top: y }} />
          <span className={`thr-det dn${nKey === `sell${i}` ? " on" : ""}${p.dumpDisabled ? " off" : ""}`} style={{ top: y }} data-testid={`thr-sell-${i}`}>{all ? "ALL" : p.sellOpts[i]}</span>
        </span>);
      })}
      {tipText && h > 0 && <div className={`thr-tip${n ? (n.side === "buy" ? " b" : " d") : ""}`} style={{ top: mid + pos }} aria-live="polite">{tipText}</div>}
      <button type="button" className={`thr-handle${n ? (n.side === "buy" ? " b" : " d") : ""}${full ? " full" : ""}`} data-testid="thr-handle"
        aria-label={`Throttle. Slide up to boost, down to dump. Tap to boost ${p.buyLabel}. Arrow keys pick, Enter fires.`}
        style={{ top: mid + pos }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel}
        onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}>
        <svg width="26" height="14" viewBox="0 0 26 14" fill="none" stroke="#121327" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="M3 3h20M3 7h20M3 11h20" /></svg>
      </button>
      <style jsx global>{`
        .thr { position: fixed; right: max(8px, env(safe-area-inset-right, 0px)); bottom: var(--ph-bar-bottom, 24px); z-index: 40; width: 128px;
          height: clamp(280px, calc(100dvh - var(--ph-radio-top, 330px) - var(--ph-bar-bottom, 24px) - 60px), 440px);
          font-family: var(--dsc-font-game, var(--font-barlow-condensed), 'Barlow Condensed', 'Arial Narrow', sans-serif); touch-action: none; pointer-events: none; }
        .thr-track { position: absolute; right: 14px; top: 0; bottom: 0; width: 38px; border-radius: 19px; background: rgba(10,12,24,.72); border: 2px solid rgba(255,255,255,.3); overflow: hidden; box-sizing: border-box; }
        .thr-up, .thr-dn { position: absolute; left: 0; right: 0; }
        .thr-up { top: 0; background: linear-gradient(180deg, rgba(242,193,78,.45), rgba(242,193,78,.04)); }
        .thr-dn { bottom: 0; background: linear-gradient(180deg, rgba(240,48,127,.04), rgba(240,48,127,.45)); }
        .thr-tick { position: absolute; right: 54px; width: 12px; height: 2px; background: rgba(243,223,168,.85); transform: translateY(-1px); }
        .thr-tick.dn { background: rgba(255,143,189,.85); }
        .thr-det { position: absolute; right: 70px; transform: translateY(-50%); font-weight: 800; font-size: 17px; line-height: 1; padding: 3px 7px; border-radius: 6px; color: #F3DFA8;
          text-shadow: 0 1px 2px rgba(0,0,0,.9); white-space: nowrap; transition: background .1s, color .1s, transform .1s; }
        .thr-det.sel { color: #FFFFFF; }
        .thr-det.dn { color: #FF9CC4; }
        .thr-det.over { opacity: .5; text-decoration: line-through; }
        .thr-det.off { opacity: .45; }
        .thr-det.on { background: #F2C14E; color: #121327; text-shadow: none; transform: translateY(-50%) scale(1.15); opacity: 1; }
        .thr-det.dn.on { background: #F0307F; color: #FFFFFF; }
        .thr-handle { all: unset; box-sizing: border-box; position: absolute; right: 2px; width: 62px; height: 54px; margin-top: -27px; border-radius: 15px; background: #FFFFFF; border: 3px solid #FFFFFF;
          box-shadow: 0 6px 16px rgba(0,0,0,.55); display: grid; place-items: center; cursor: grab; touch-action: none; pointer-events: auto; -webkit-tap-highlight-color: transparent;
          -webkit-touch-callout: none; user-select: none; -webkit-user-select: none; transition: background .12s; }
        .thr-handle.b { background: #F2C14E; border-color: #F2C14E; }
        .thr-handle.d { background: #F0307F; border-color: #F0307F; }
        .thr-handle.full { opacity: .6; }
        .thr-handle:active { cursor: grabbing; }
        .thr-handle:focus-visible { outline: 3px solid #F3DFA8; outline-offset: 3px; }
        .thr-tip { position: absolute; right: 136px; transform: translateY(-50%); width: max-content; max-width: min(200px, calc(100vw - 160px)); padding: 8px 11px; border-radius: 12px;
          font-weight: 800; font-size: 16px; line-height: 1.1; letter-spacing: .3px; text-align: center; background: rgba(18,19,39,.85); border: 1px solid #2E323A; color: #C9CED6; pointer-events: none; }
        .thr-tip.b { background: #F2C14E; color: #121327; border-color: #F2C14E; }
        .thr-tip.d { background: #F0307F; color: #FFFFFF; border-color: #F0307F; }
        .thr-line { position: absolute; right: 0; bottom: calc(100% + 8px); width: max-content; max-width: calc(100vw - 24px); box-sizing: border-box; padding: 6px 12px; border-radius: 12px;
          font: 500 12px/1.3 var(--dsc-font-ui, system-ui, sans-serif); color: #FFB0C8; background: rgba(18,19,39,.9); border: 1px solid rgba(240,48,127,.35); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .thr-line.warn { color: #FFE7A3; border-color: rgba(255,231,163,.35); }
        .thr-line.warn.over { color: #FFB0C8; border-color: rgba(255,61,127,.3); }
        @media (prefers-reduced-motion: reduce) { .thr-det, .thr-handle { transition: none; } }
      `}</style>
    </div>
  );
}
