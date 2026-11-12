"use client";
/**
 * FLIGHT TOP BAR (desktop; approved mockup boards "Desktop · Pilot HUD" / "Desktop · Pro HUD", maker Nov 12):
 * PILOT / PRO switch + ☰ menu (Esc) + ✕ leave flight, top right. There is no sidebar rail and no wallet strip on the
 * flight screen: sign in / your account, Settings, Tramp / Wall and the simulated market all live in the ☰ menu.
 * Phones stay on Pilot with their own HUD (components/flight/PhoneHud), so this renders nothing there.
 *
 * Sign in runs the wallet pill's own action (lib/walletCta WALLET_CTA_CLICK_EVENT); its login popover still portals from the
 * (hidden) wallet strip, which globals.css parks under this bar. ✕ is a plain link to the lobby, so ExitConfirm guards it.
 */
import { useEffect, useRef, useState } from "react";
import { isPhoneUI } from "@/lib/game/cardLayoutStore";
import { setHudMode, useHudMode, type HudMode } from "@/lib/game/hudMode";
import { HUD } from "@/lib/game/hudStyle";
import { SETTINGS_OPEN_EVENT, WALLET_CTA_CLICK_EVENT, WALLET_CTA_EVENT, WALLET_ID_EVENT, walletCtaLabel, walletId, type WalletId } from "@/lib/walletCta";
import { disconnect } from "@/lib/wallet";

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
  const [cta, setCta] = useState<string | null>(null);
  const [me, setMe] = useState<WalletId | null>(null);
  const [tw, setTw] = useState<TwState | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const f = () => setDesk(!isPhoneUI()); f(); addEventListener("resize", f); return () => removeEventListener("resize", f); }, []);
  useEffect(() => {
    setCta(walletCtaLabel()); setMe(walletId());
    const c = (e: Event) => setCta((e as CustomEvent<{ label: string | null }>).detail?.label ?? null);
    const i = (e: Event) => setMe((e as CustomEvent<WalletId | null>).detail ?? null);
    const t = (e: Event) => setTw((e as CustomEvent<TwState>).detail ?? null);
    addEventListener(WALLET_CTA_EVENT, c); addEventListener(WALLET_ID_EVENT, i); addEventListener(TW_STATE_EVENT, t);
    return () => { removeEventListener(WALLET_CTA_EVENT, c); removeEventListener(WALLET_ID_EVENT, i); removeEventListener(TW_STATE_EVENT, t); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.code === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); setOpen(false); } };
    addEventListener("pointerdown", down, true); addEventListener("keydown", key, true);
    return () => { removeEventListener("pointerdown", down, true); removeEventListener("keydown", key, true); };
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
      <div role="radiogroup" aria-label="HUD layout" data-testid="hud-mode" style={{ display: "flex", padding: 3, borderRadius: 999, background: HUD.glass, border: `1px solid ${HUD.border}` }}>
        {opt("pilot", "PILOT", "Pilot: one trade bar, one crew feed, big bombs only")}
        {opt("pro", "PRO", "Pro: loadout, chart, full position and every bomb")}
      </div>
      <button type="button" aria-label="Menu (Esc)" aria-haspopup="menu" aria-expanded={open} data-testid="flight-menu-btn" onClick={() => setOpen((v) => !v)}
        style={{ ...sq, background: open ? "#F2F3F7" : HUD.glass, color: open ? HUD.ink : "#F2F3F7" }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M4 7h16M4 12h16M4 17h16" /></svg>
      </button>
      <a href="/" aria-label="Leave flight" title="Leave flight" data-testid="flight-leave" style={sq}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
      </a>
      {open && (
        <div role="menu" aria-label="Flight menu" data-testid="flight-menu" style={{ position: "absolute", right: 0, top: 52, width: 300, boxSizing: "border-box", padding: 6,
          borderRadius: HUD.radius, background: "rgba(18,19,39,.94)", border: `1px solid ${HUD.border}`, boxShadow: "0 16px 40px rgba(0,0,0,.45)", backdropFilter: "blur(8px)" }}>
          <div style={head}>PILOT</div>
          {cta ? (
            <button type="button" role="menuitem" data-testid="flight-menu-signin" onClick={() => { dispatchEvent(new Event(WALLET_CTA_CLICK_EVENT)); setOpen(false); }}
              style={{ ...row, background: "#F2C14E", color: HUD.ink, justifyContent: "center", font: `700 16px/1 ${HUD.game}`, letterSpacing: ".04em" }}>{cta.toUpperCase()}</button>
          ) : me ? (<>
            <a role="menuitem" href="/profile" data-testid="flight-menu-hangar" style={row}><span>{me.name ? `@${me.name}` : `${me.address.slice(0, 6)}…${me.address.slice(-4)}`}</span><span style={{ color: HUD.dim, fontSize: 12 }}>Hangar</span></a>
            <button type="button" role="menuitem" data-testid="flight-menu-signout" onClick={go(() => { void disconnect(); })} style={{ ...row, color: HUD.dim }}>Sign out</button>
          </>) : <div style={{ ...row, cursor: "default", color: HUD.dim }}>Playing on paper</div>}
          {(tw?.on || (sim && sim.available)) && <div style={head}>FLIGHT</div>}
          {tw?.on && <>
            <button type="button" role="menuitem" data-testid="flight-menu-tw" onClick={go(() => dispatchEvent(new CustomEvent(TW_OPEN_EVENT, { detail: { open: "place" } })))} style={row}>
              <span>Place a tramp or wall</span>{tw.sample && <span style={{ ...tag, color: "#FF9FB8", border: "1px solid rgba(255,159,184,.5)" }}>SAMPLE</span>}</button>
            <button type="button" role="menuitem" data-testid="flight-menu-tw-mine" onClick={go(() => dispatchEvent(new CustomEvent(TW_OPEN_EVENT, { detail: { open: "list" } })))} style={row}>
              <span>My tramps and walls</span><span style={{ ...tag, color: HUD.champagne, background: "rgba(255,255,255,.08)" }}>{tw.active}</span></button>
          </>}
          {sim && sim.available && <button type="button" role="menuitemcheckbox" aria-checked={sim.on} data-testid="flight-menu-sim" onClick={() => onSim?.()} style={row}
            title="Random buys and sells keep the rocket moving when the pool is quiet. Visual only: never touches balances or PnL.">
            <span>Simulated market</span><span style={{ ...tag, color: sim.on ? HUD.ink : HUD.dim, background: sim.on ? "#5FF0A0" : "rgba(255,255,255,.08)" }}>{sim.on ? (sim.mode === "auto" ? "AUTO" : "ON") : "OFF"}</span></button>}
          <div style={{ height: 1, background: HUD.border, margin: "6px 8px" }} />
          <button type="button" role="menuitem" data-testid="flight-menu-settings" onClick={go(() => dispatchEvent(new Event(SETTINGS_OPEN_EVENT)))} style={row}>
            <span>Settings</span><span style={{ ...tag, color: HUD.dim, background: "rgba(255,255,255,.08)" }}>ESC</span></button>
          <a role="menuitem" href="/" data-testid="flight-menu-lobby" style={row}>Back to the lobby</a>
        </div>
      )}
    </div>
  );
}
