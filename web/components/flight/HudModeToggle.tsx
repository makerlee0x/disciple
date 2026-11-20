"use client";
/**
 * FLIGHT TOP BAR (desktop; approved mockup boards "Desktop · Pilot HUD" / "Desktop · Pro HUD", maker Nov 12):
 * PILOT / PRO switch + wallet pill + ☰ menu (Esc, Leave flight inside; the ✕ was folded in, maker 2026-11-20), top right. The switch is hidden for launch (lib/features PRO_HUD_ENABLED,
 * maker 2026-11-14): every flight runs Pilot, and ☰ → Trade settings opens the boost amounts + price protection popup. There is no sidebar rail and no wallet strip on the
 * flight screen: sign in / your account, Settings, Tramp / Wall and the simulated market all live in the ☰ menu.
 * Phones stay on Pilot with their own HUD (components/flight/PhoneHud), so this renders nothing there.
 *
 * Sign in runs the wallet pill's own action (lib/walletCta WALLET_CTA_CLICK_EVENT); its login popover still portals from the
 * (hidden) wallet strip, which globals.css parks under this bar. ✕ is a plain link to the lobby, so ExitConfirm guards it.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { isPhoneUI } from "@/lib/game/cardLayoutStore";
import { setHudMode, useHudMode, type HudMode } from "@/lib/game/hudMode";
import { PRO_HUD_ENABLED } from "@/lib/features";
import { HUD } from "@/lib/game/hudStyle";
import { SETTINGS_OPEN_EVENT } from "@/lib/walletCta";

/** Tramp / Wall state published by components/trampwalls/TrampWallPanel (graduated coins only) */
export const TW_STATE_EVENT = "disciple:twstate", TW_OPEN_EVENT = "disciple:tw";
export type TwState = { on: boolean; active: number; sample: boolean };
type Sim = { on: boolean; mode: string; available?: boolean };

const sq: React.CSSProperties = { all: "unset", boxSizing: "border-box", cursor: "pointer", width: 44, height: 44, borderRadius: HUD.control, background: HUD.glass,
  border: `1px solid ${HUD.border}`, color: "#F2F3F7", display: "flex", alignItems: "center", justifyContent: "center" };
const row: React.CSSProperties = { all: "unset", boxSizing: "border-box", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, width: "100%",
  minHeight: 40, padding: "0 12px", borderRadius: 10, font: `500 14px/1.2 ${HUD.ui}`, color: HUD.text };
const head: React.CSSProperties = { font: `600 13px/1 ${HUD.game}`, letterSpacing: "1.5px", color: HUD.dim, padding: "10px 12px 6px" };
const tag: React.CSSProperties = { font: `700 12px/1 ${HUD.game}`, letterSpacing: ".06em", padding: "3px 7px", borderRadius: 6 };

export default function HudModeToggle({ sim, onSim }: { sim?: Sim | null; onSim?: () => void } = {}) {
  const mode = useHudMode();
  const [desk, setDesk] = useState(false);
  const [open, setOpen] = useState(false);
  const [tw, setTw] = useState<TwState | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const f = () => setDesk(!isPhoneUI()); f(); addEventListener("resize", f); return () => removeEventListener("resize", f); }, []);
  useEffect(() => {
    const t = (e: Event) => setTw((e as CustomEvent<TwState>).detail ?? null);
    addEventListener(TW_STATE_EVENT, t); return () => removeEventListener(TW_STATE_EVENT, t);
  }, []);
  // The wallet pill (WalletButton, pfp + balance) sits left of this bar (globals.css body.has-flightbar), the radio left of both:
  // --ap-flightbar-w = this bar, --ap-topbar-w = bar + pill.
  useEffect(() => { const el = boxRef.current; if (!el || typeof ResizeObserver === "undefined") return; const root = document.documentElement;
    document.body.classList.add("has-flightbar");
    const wallet = () => document.querySelector<HTMLElement>('[aria-label="wallet"].wb-root');
    const pub = () => { const own = Math.round(el.getBoundingClientRect().width), w = wallet(), ww = w ? Math.round(w.getBoundingClientRect().width) : 0;
      const sig = `${own}/${ww}`; if (sig === last) return; last = sig;
      root.style.setProperty("--ap-flightbar-w", `${own}px`); root.style.setProperty("--ap-topbar-w", `${own + (ww > 0 ? ww + 8 : 0)}px`); };
    let last = "";
    const ro = new ResizeObserver(pub); ro.observe(el);
    let watched: HTMLElement | null = null;
    const watch = () => { const w = wallet(); if (w && w !== watched) { watched = w; ro.observe(w); } pub(); };
    const iv = window.setInterval(watch, 500); watch();   // the pill mounts (and remounts on sign-in) on its own schedule
    return () => { ro.disconnect(); clearInterval(iv); document.body.classList.remove("has-flightbar"); root.style.removeProperty("--ap-topbar-w"); root.style.removeProperty("--ap-flightbar-w"); }; }, [desk]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.code === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); setOpen(false); } };
    // another overlay took over (the flight log opening from "Back to the lobby", a confirm): close, don't sit behind it
    const other = (e: Event) => { if ((e as CustomEvent<{ open?: boolean }>).detail?.open) setOpen(false); };
    addEventListener("pointerdown", down, true); addEventListener("keydown", key, true); addEventListener("disciple:menu", other);
    return () => { removeEventListener("pointerdown", down, true); removeEventListener("keydown", key, true); removeEventListener("disciple:menu", other); };
  }, [open]);
  if (!desk) return null;
  const opt = (m: HudMode, label: string, hint: string) => (
    <button type="button" role="radio" aria-checked={mode === m} data-testid={`hud-mode-${m}`} title={hint} onClick={() => setHudMode(m)}
      style={{ all: "unset", cursor: "pointer", padding: "0 16px", minHeight: 38, display: "inline-flex", alignItems: "center", borderRadius: 999,
        font: `700 16px/1 ${HUD.game}`, letterSpacing: ".04em", color: mode === m ? HUD.ink : "rgba(242,243,247,.75)", background: mode === m ? "#F2F3F7" : "transparent" }}>
      {label}</button>);
  const go = (f: () => void) => () => { setOpen(false); f(); };
  return (
    <div ref={boxRef} data-testid="flight-topbar" style={{ position: "fixed", right: 20, top: 18, zIndex: 62, display: "flex", gap: 8, alignItems: "center" }}>
      {PRO_HUD_ENABLED && <div role="radiogroup" aria-label="HUD layout" data-testid="hud-mode" style={{ display: "flex", padding: 3, borderRadius: 999, background: HUD.glass, border: `1px solid ${HUD.border}` }}>
        {opt("pilot", "PILOT", "Pilot: one trade bar, one crew feed, big bombs only")}
        {opt("pro", "PRO", "Pro: loadout, chart, full position and every bomb")}
      </div>}
      <button type="button" aria-label="Menu (Esc)" aria-haspopup="menu" aria-expanded={open} data-testid="flight-menu-btn" onClick={() => setOpen((v) => !v)}
        style={{ ...sq, background: open ? "#F2F3F7" : HUD.glass, color: open ? HUD.ink : "#F2F3F7" }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M4 7h16M4 12h16M4 17h16" /></svg>
      </button>
      {open && (
        <div role="menu" aria-label="Flight menu" data-testid="flight-menu" style={{ position: "absolute", right: 0, top: 52, width: 300, boxSizing: "border-box", padding: 6,
          borderRadius: HUD.radius, background: "rgba(18,19,39,.94)", border: `1px solid ${HUD.border}`, boxShadow: "0 16px 40px rgba(0,0,0,.45)", backdropFilter: "blur(8px)" }}>
          <style>{`[data-testid="flight-menu"] [role^="menuitem"]:hover, [data-testid="flight-menu"] [role^="menuitem"]:focus-visible { background-color: rgba(255,255,255,.08) !important; }
            [data-testid="flight-menu"] .fm-btn[data-testid="flight-menu-hangar"]:hover { background-color: rgba(242,193,78,.22) !important; }`}</style>
          {/* who you are / sign in / Hangar / sign out: the wallet pill beside this button (maker 2026-11-20), not repeated here */}
          {(tw?.on || (sim && sim.available)) && <div style={head}>FLIGHT</div>}
          {tw?.on && <>
            <button type="button" role="menuitem" data-testid="flight-menu-tw" onClick={go(() => dispatchEvent(new CustomEvent(TW_OPEN_EVENT, { detail: { open: "place" } })))} style={row}>
              <span>Place a tramp or wall</span>{tw.sample && <span style={{ ...tag, color: "#FF9FB8", border: "1px solid rgba(255,159,184,.5)" }}>SAMPLE</span>}</button>
            <button type="button" role="menuitem" data-testid="flight-menu-tw-mine" onClick={go(() => dispatchEvent(new CustomEvent(TW_OPEN_EVENT, { detail: { open: "list" } })))} style={row}>
              <span>My tramps and walls</span><span style={{ ...tag, color: HUD.champagne, background: "rgba(255,255,255,.08)" }}>{tw.active}</span></button>
          </>}
          {sim && sim.available && <button type="button" role="menuitemcheckbox" aria-checked={sim.on} data-testid="flight-menu-sim" onClick={() => onSim?.()} style={row}
            title="Fake trades when it's quiet. Never touches your balance.">
            <span>Simulated market</span><span style={{ ...tag, color: sim.on ? HUD.ink : HUD.dim, background: sim.on ? "#5FF0A0" : "rgba(255,255,255,.08)" }}>{sim.on ? (sim.mode === "auto" ? "AUTO" : "ON") : "OFF"}</span></button>}
          {(tw?.on || (sim && sim.available)) && <div style={{ height: 1, background: HUD.border, margin: "6px 8px" }} />}
          <button type="button" role="menuitem" data-testid="flight-menu-trade" onClick={go(() => dispatchEvent(new CustomEvent("disciple:swapsettings", { detail: { open: true } })))} style={row}>
            <span>Trade settings</span></button>
          <button type="button" role="menuitem" data-testid="flight-menu-settings" onClick={go(() => dispatchEvent(new Event(SETTINGS_OPEN_EVENT)))} style={row}>
            <span>Settings</span><span style={{ ...tag, color: HUD.dim, background: "rgba(255,255,255,.08)" }}>ESC</span></button>
          {/* maker 2026-11-20: the ✕ is folded into this menu; leaving the flight is here */}
          <Link role="menuitem" href="/" data-testid="flight-menu-lobby" style={row}><span>Leave flight</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg></Link>
        </div>
      )}
    </div>
  );
}
