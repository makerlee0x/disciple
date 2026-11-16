"use client";
/**
 * App-wide sounds (lib/game/sfx), mounted once in the root layout:
 *   - taps: any button or link press plays ui_tap. `data-sfx` on the element (or a parent) picks another sound:
 *     "primary" (PLAY, LAUNCH, FIND A MATCH), "back", "none", or any sound key. Switches toggle on/off, tabs click,
 *     range sliders tick.
 *   - sheets: a dialog (role="dialog") appearing or leaving plays sheet_open / sheet_close.
 *   - money: cash arriving (CASH_ARRIVED_EVENT) plays deposit_done.
 *   - the ambience bed for the screen: wind in a flight (FlightSfx swaps it as you climb), the hangar tone in the Hangar
 *     (app only), none in the Duel and Royale (their engines run their own) and none in the lobby and menus.
 *     The deep space drone used to play on every other screen; its low hum sounded like a broken cable (maker, 2026-11-16).
 *
 * The taps, tab/toggle clicks, slider ticks and sheet sounds play in the iPhone app only (appFeel). The website keeps the
 * game sounds (boosts, cash, level up, crates) but not the clicks.
 */
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { appFeel, playSfx, preloadSfx, setBed } from "@/lib/game/sfx";
import { resumeAudio } from "@/lib/game/audio";
import { CASH_ARRIVED_EVENT } from "@/lib/testCash";

const UI = ["ui_tap", "ui_tap_primary", "ui_back", "sheet_open", "sheet_close", "ui_toggle_on", "ui_toggle_off", "ui_tab", "mode_select"];
const BACK = /^(back|close|cancel|dismiss|not now|done|close settings|close menu)\b/i;

function bedFor(path: string): string | null {
  if (path.startsWith("/turbo/duel") || path.startsWith("/turbo/royale")) return null;
  if (path.startsWith("/coin/") || path.startsWith("/flight") || path.startsWith("/fly") || path === "/turbo") return "amb_wind_high";
  if (path.startsWith("/profile") && appFeel()) return "amb_hangar";   // the Hangar
  return null;
}

function soundFor(el: Element): string | null {
  const tagged = el.closest("[data-sfx]");
  if (tagged) { const v = tagged.getAttribute("data-sfx") || ""; return v === "none" ? null : v === "primary" ? "ui_tap_primary" : v === "back" ? "ui_back" : v; }
  const role = el.getAttribute("role");
  if (role === "switch") return el.getAttribute("aria-checked") === "true" ? "ui_toggle_off" : "ui_toggle_on";   // read before the click flips it
  if (role === "tab" || role === "radio") return "ui_tab";
  const label = (el.getAttribute("aria-label") || el.textContent || "").trim();
  if (BACK.test(label)) return "ui_back";
  return "ui_tap";
}

export default function AppSounds() {
  const path = usePathname() || "/";
  useEffect(() => { setBed(bedFor(path)); }, [path]);

  useEffect(() => {
    const onCash = () => playSfx("deposit_done");
    addEventListener(CASH_ARRIVED_EVENT, onCash);
    if (!appFeel()) {   // website: no clicks, just wake the audio on the first press so game sounds can play
      const wake = () => { void resumeAudio(); };
      addEventListener("pointerdown", wake, true);
      return () => { removeEventListener("pointerdown", wake, true); removeEventListener(CASH_ARRIVED_EVENT, onCash); };
    }
    let primed = false;
    const onDown = (e: PointerEvent) => {
      void resumeAudio();
      if (!primed) { primed = true; preloadSfx(UI); }
      const t = e.target as Element | null;
      const el = t?.closest?.('button, a[href], [role="button"], [role="switch"], [role="tab"], [role="radio"], summary');
      if (!el || (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") return;
      if (el.closest("canvas, .duel-root #launch")) return;   // the Duel race plays its own trade sounds
      const k = soundFor(el);
      if (k) playSfx(k);
    };
    let lastTick = 0;
    const onInput = (e: Event) => {
      const t = e.target as HTMLInputElement | null;
      if (t?.type !== "range") return;
      const n = performance.now(); if (n - lastTick < 70) return; lastTick = n;
      playSfx("ui_slider_tick", { gapMs: 0 });
    };

    // sheets and popups: watch dialogs come and go
    let count = 0, queued = 0;
    const scan = () => {
      queued = 0;
      const n = document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length;
      if (n > count) playSfx("sheet_open"); else if (n < count) playSfx("sheet_close");
      count = n;
    };
    const mo = new MutationObserver(() => { if (!queued) queued = requestAnimationFrame(scan); });   // once a frame at most
    mo.observe(document.body, { childList: true, subtree: true });
    count = document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length;

    addEventListener("pointerdown", onDown, true);
    addEventListener("input", onInput, true);
    return () => {
      removeEventListener("pointerdown", onDown, true);
      removeEventListener("input", onInput, true);
      removeEventListener(CASH_ARRIVED_EVENT, onCash);
      mo.disconnect(); if (queued) cancelAnimationFrame(queued);
    };
  }, []);
  return null;
}
