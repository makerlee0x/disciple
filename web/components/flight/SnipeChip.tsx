"use client";

import { useEffect } from "react";
import { useT } from "@/lib/game/i18n";
import { SNIPE_CHIP_KEY, SNIPE_STATE_EVENT, snipeChipVars } from "@/lib/game/snipeCountdown";
import type { SnipeState } from "@/lib/snipe";

/**
 * SNIPER TAX countdown chip (flight HUD, bottom-centre above the trade bar). Presentational: the state comes from
 * SnipeCountdown (live coin) or SimMode (SIMULATOR). Hidden when the tax is over or SHOW_SNIPE_COUNTDOWN is off.
 * Also re-broadcasts the state on window (SNIPE_STATE_EVENT) so public/flight/engine.js can pick it up later.
 */
export default function SnipeChip({ state }: { state: SnipeState | null }) {
  const t = useT();
  const vars = snipeChipVars(state);
  const key = vars ? `${vars.clock}|${vars.pct}` : "off";
  useEffect(() => {
    try { window.dispatchEvent(new CustomEvent(SNIPE_STATE_EVENT, { detail: state && vars ? state : { active: false, secondsLeft: 0, feePct: 0 } })); } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!vars) return null;
  const hot = vars.pct >= 50;
  return (
    <div className="ap-bc" style={{ bottom: 142, zIndex: 26, pointerEvents: "none" }}>
      <div role="status" aria-live="off" data-testid="snipe-chip" className="ap-pill"
        style={{ cursor: "default", display: "inline-flex", alignItems: "center", gap: 6, fontVariantNumeric: "tabular-nums",
          color: hot ? "#ff9fb8" : "#ffd9a0", borderColor: hot ? "rgba(255,120,150,.75)" : "rgba(255,210,74,.7)",
          boxShadow: hot ? "0 0 14px rgba(255,90,130,.35)" : "0 0 12px rgba(255,210,74,.25)", animation: "apSnipeIn .3s ease-out" }}>
        <span aria-hidden style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: "currentColor", animation: "apSnipePulse 1s ease-in-out infinite" }} />
        {t(SNIPE_CHIP_KEY, vars)}
      </div>
      <style>{`@keyframes apSnipeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@keyframes apSnipePulse{0%,100%{opacity:1}50%{opacity:.35}}`}</style>
    </div>
  );
}
