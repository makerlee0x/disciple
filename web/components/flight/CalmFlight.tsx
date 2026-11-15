"use client";
/**
 * Full-screen flying (phone, maker 2026-11-14: "do them all", option 4). After CALM_MS with no touch on the HUD, the side tools,
 * chat and the lever's tips fade out, and the engine grows the rocket (disciple:calm {on}).
 * Always kept on screen (maker 2026-11-14 TestFlight: hiding them lost "the chart and all the transactions"): the chart card,
 * your bag card + trades, the market cap headline, ✕ leave and the lever itself. Off by default.
 * Wakes on: a touch anywhere off the sky (HUD, lever), a TAP on the sky (a steering drag or a trick does not wake it),
 * your own fill (so you see the bag change), the Holders · Chart sheet opening. Setting: "Full-screen flying" (game settings calm).
 * Phone only (html.ap-phone); desktop and ?clean=1 never get the attribute.
 */
import { useEffect } from "react";
import { useGameSettings } from "@/lib/game/settings";

export const CALM_MS = 3500;
const ATTR = "data-ph-calm";
const TAP_PX = 8, TAP_MS = 250;

export default function CalmFlight() {
  const { calm } = useGameSettings();
  useEffect(() => {
    const html = document.documentElement;
    let timer = 0, on = false, down: { x: number; y: number; t: number } | null = null;
    const set = (v: boolean) => {
      if (v === on) return; on = v;
      if (v) html.setAttribute(ATTR, ""); else html.removeAttribute(ATTR);
      dispatchEvent(new CustomEvent("disciple:calm", { detail: { on: v } }));
    };
    const eligible = () => calm && html.classList.contains("ap-phone") && (html.getAttribute("data-ph-sheet") ?? "") === "" && !document.querySelector('[role="dialog"]');
    const arm = () => { clearTimeout(timer); timer = window.setTimeout(() => { if (eligible()) set(true); else arm(); }, CALM_MS); };
    const wake = () => { set(false); arm(); };
    const isSky = (t: EventTarget | null) => t instanceof HTMLCanvasElement && t.id === "c";
    const onDown = (e: PointerEvent) => { if (isSky(e.target)) { down = { x: e.clientX, y: e.clientY, t: performance.now() }; return; } wake(); };
    const onUp = (e: PointerEvent) => {
      const d = down; down = null;
      if (d && isSky(e.target) && Math.hypot(e.clientX - d.x, e.clientY - d.y) < TAP_PX && performance.now() - d.t < TAP_MS) wake();
    };
    const onSfx = (e: Event) => { const k = (e as CustomEvent).detail?.k; if (k === "fill" || k === "fail") wake(); };
    const mo = new MutationObserver(() => { if (on && !eligible()) wake(); });
    if (!calm) { set(false); return; }
    mo.observe(html, { attributes: true, attributeFilter: ["data-ph-sheet", "class"] });
    addEventListener("pointerdown", onDown, true); addEventListener("pointerup", onUp, true); addEventListener("disciple:sfx", onSfx);
    arm();
    return () => {
      clearTimeout(timer); mo.disconnect(); set(false);
      removeEventListener("pointerdown", onDown, true); removeEventListener("pointerup", onUp, true); removeEventListener("disciple:sfx", onSfx);
    };
  }, [calm]);
  return (
    <style>{`
      html.ap-phone [data-testid="phone-header"], html.ap-phone [data-testid="phone-side"], html.ap-phone [data-testid="chat-dock"],
      html.ap-phone [data-testid="chat-open"], html.ap-phone [data-testid="phone-bag"], html.ap-phone [data-testid="phone-toprow"],
      html.ap-phone .thr-det, html.ap-phone .thr-tip { transition: opacity .45s ease; }
      html.ap-phone[${ATTR}] [data-testid="phone-side"],
      html.ap-phone[${ATTR}] [data-testid="chat-dock"], html.ap-phone[${ATTR}] [data-testid="chat-open"],
      html.ap-phone[${ATTR}] .thr-tip { opacity: 0 !important; pointer-events: none !important; }
      @media (prefers-reduced-motion: reduce) { html.ap-phone [data-testid] { transition: none !important; } }
    `}</style>
  );
}
