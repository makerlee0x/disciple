"use client";
/**
 * Full-screen flying on phones (maker 2026-11-14, "the funnest thing"; Settings → Full-screen flying, on by default).
 * After CALM_MS without a tap on the HUD, the chart card, side buttons, crew feed and top buttons fade out, and the engine grows
 * the rocket (disciple:calm {on}, engine.js @calm). The market cap, your bag and the throttle stay. Steering (dragging the sky),
 * tricks and trading on the lever never wake the HUD, so a flight can stay full-screen; a single tap on the sky or a touch
 * anywhere else brings it back. Never while the Holders · Chart sheet or a dialog is open. Desktop: nothing.
 */
import { useEffect } from "react";
import { useGameSettings } from "@/lib/game/settings";
import { calmNow } from "@/lib/flight/feel";

/** what fades (PhoneHud / GameChat test ids) */
const FADE = ["phone-header", "phone-side", "chat-dock", "phone-pilot", "flight-leave", "phone-cash", "snipe-chip", "steer-hint", "sim-chip", "sim-bar"];

export default function FlyCalm() {
  const gs = useGameSettings();
  const on = gs.fullscreen;
  useEffect(() => {
    const de = document.documentElement;
    let last = performance.now(), calm = false, down: { x: number; y: number; t: number; sky: boolean } | null = null;
    const set = (v: boolean) => {
      if (v === calm) return; calm = v;
      if (v) de.dataset.flyCalm = "1"; else delete de.dataset.flyCalm;
      dispatchEvent(new CustomEvent("disciple:calm", { detail: { on: v } }));
    };
    const wake = () => { last = performance.now(); set(false); };
    const isSky = (t: EventTarget | null) => t instanceof HTMLCanvasElement;
    const isLever = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-throttle="1"], [data-testid="trade-bar"]');
    const pd = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now(), sky: isSky(e.target) };
      if (!down.sky && !isLever(e.target)) wake();
      else if (!calm) last = performance.now();   // flying keeps the countdown going from the latest touch
    };
    const pu = (e: PointerEvent) => {
      const d = down; down = null;
      if (d?.sky && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 10 && performance.now() - d.t < 250) wake();   // a plain tap on the sky
    };
    const tick = () => {
      const phone = de.classList.contains("ap-phone");
      const sheetOpen = !!de.dataset.phSheet;
      const dialog = !!document.querySelector('[role="dialog"], [data-testid="swap-settings"]');
      set(calmNow({ on, phone, sheetOpen, dialog, sinceWake: performance.now() - last }));
    };
    addEventListener("pointerdown", pd, true); addEventListener("pointerup", pu, true); addEventListener("keydown", wake, true);
    const iv = setInterval(tick, 400);
    return () => { clearInterval(iv); removeEventListener("pointerdown", pd, true); removeEventListener("pointerup", pu, true); removeEventListener("keydown", wake, true); set(false); };
  }, [on]);
  return (
    <style>{`
      html.ap-phone :is(${FADE.map((t) => `[data-testid="${t}"]`).join(", ")}) { transition: opacity .45s ease; }
      html.ap-phone[data-fly-calm] :is(${FADE.map((t) => `[data-testid="${t}"]`).join(", ")}) { opacity: 0 !important; pointer-events: none !important; }
    `}</style>
  );
}
