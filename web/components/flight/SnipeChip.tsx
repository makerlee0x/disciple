"use client";

import { useEffect } from "react";
import { SNIPE_STATE_EVENT, snipeChipText } from "@/lib/game/snipeCountdown";
import type { SnipeState } from "@/lib/snipe";

/**
 * SNIPER TAX countdown chip (flight HUD, bottom-centre above the trade bar). Text = SITE's formatSnipeChip (same as the
 * BOOST panel; no separate i18n string). Presentational: the state comes from
 * SnipeCountdown (live coin) or SimMode (SIMULATOR). Hidden when the tax is over or SHOW_SNIPE_COUNTDOWN is off.
 * Also re-broadcasts the state on window (SNIPE_STATE_EVENT) so public/flight/engine.js can pick it up later.
 */
export default function SnipeChip({ state }: { state: SnipeState | null }) {
  const text = snipeChipText(state);
  const key = text ?? "off";
  useEffect(() => {
    try { window.dispatchEvent(new CustomEvent(SNIPE_STATE_EVENT, { detail: state && text ? state : { active: false, secondsLeft: 0, feePct: 0, feePctRaw: 0 } })); } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!text || !state) return null;
  const hot = state.feePct >= 50;
  return (
    <div className="ap-bc" style={{ bottom: 142, zIndex: 26, pointerEvents: "none" }}>
      <div role="status" aria-live="off" data-testid="snipe-chip" className="ap-pill"
        style={{ cursor: "default", display: "inline-flex", alignItems: "center", gap: 6, fontVariantNumeric: "tabular-nums",
          color: hot ? "#ff9fb8" : "#ffd9a0", borderColor: hot ? "rgba(255,120,150,.75)" : "rgba(255,210,74,.7)",
          boxShadow: hot ? "0 0 14px rgba(255,90,130,.35)" : "0 0 12px rgba(255,210,74,.25)", animation: "apSnipeIn .3s ease-out" }}>
        <span aria-hidden style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: "currentColor", animation: "apSnipePulse 1s ease-in-out infinite" }} />
        {text}
      </div>
      <style>{`@keyframes apSnipeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@keyframes apSnipePulse{0%,100%{opacity:1}50%{opacity:.35}}`}</style>
    </div>
  );
}
