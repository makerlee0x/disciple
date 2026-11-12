"use client";
/**
 * PILOT / PRO switch (desktop flight screen, top right, just left of the wallet strip). Pilot is the default.
 * Phones stay on Pilot: their HUD is its own layout (components/flight/PhoneHud).
 */
import { useEffect, useState } from "react";
import { isPhoneUI } from "@/lib/game/cardLayoutStore";
import { setHudMode, useHudMode, type HudMode } from "@/lib/game/hudMode";
import { HUD } from "@/lib/game/hudStyle";

export default function HudModeToggle() {
  const mode = useHudMode();
  const [pos, setPos] = useState<{ right: number; top: number } | null>(null);
  useEffect(() => {
    const fit = () => {
      if (isPhoneUI()) { setPos(null); return; }
      const w = document.querySelector('[aria-label="wallet"]')?.getBoundingClientRect();
      const next = w && w.width > 0 ? { right: Math.round(innerWidth - w.left + 10), top: Math.round(w.top) } : { right: 20, top: 16 };
      setPos((p) => (p && p.right === next.right && p.top === next.top ? p : next));
    };
    fit(); const iv = setInterval(fit, 700); addEventListener("resize", fit);
    return () => { clearInterval(iv); removeEventListener("resize", fit); };
  }, []);
  if (!pos) return null;
  const opt = (m: HudMode, label: string, hint: string) => (
    <button type="button" role="radio" aria-checked={mode === m} data-testid={`hud-mode-${m}`} title={hint} onClick={() => setHudMode(m)}
      style={{ all: "unset", cursor: "pointer", padding: "0 14px", minHeight: 30, display: "inline-flex", alignItems: "center", borderRadius: 999,
        font: `700 15px/1 ${HUD.game}`, letterSpacing: ".04em", color: mode === m ? HUD.ink : "rgba(242,243,247,.75)", background: mode === m ? "#F2F3F7" : "transparent" }}>
      {label}</button>);
  return (
    <div role="radiogroup" aria-label="HUD layout" data-testid="hud-mode"
      style={{ position: "fixed", right: pos.right, top: pos.top, zIndex: 62, display: "flex", padding: 3, borderRadius: 999, background: HUD.glass, border: `1px solid ${HUD.border}` }}>
      {opt("pilot", "PILOT", "Pilot: one trade bar, one crew feed, big bombs only")}
      {opt("pro", "PRO", "Pro: loadout, chart, full position and every bomb")}
    </div>
  );
}
