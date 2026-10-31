"use client";
/**
 * Overlay-sidebar signal (SITE #222, PR #221): when the desktop sidebar OVERLAYS the game (canvas stays full width) the HUD
 * blocks the left `width` px while it is open. Read from either:
 *   1. <html data-sidebar-overlay="open">  (document.documentElement.dataset.sidebarOverlay === "open"; removed on close)
 *   2. window event "disciple:sidebar-overlay" { open: boolean, width: 248 }
 * width: the event's width, else the CSS var --ap-side-w, else 248. Published as window.__hudLeft (px blocked from the
 * viewport's left edge; engine hudTopLayout + worker GLOBALS) and the "disciple:hudarea" event. Push mode (no overlay): 0.
 */
type Win = { __hudLeft?: number };
let open = false, evWidth = 0, started = false;
const cssW = () => { const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ap-side-w")); return Number.isFinite(v) && v > 0 ? v : 248; };
export function overlayBlocked(): number { return open ? Math.round(evWidth > 0 ? evWidth : cssW()) : 0; }
function emit() {
  const px = overlayBlocked(), w = window as unknown as Win;
  if (w.__hudLeft === px) return;
  w.__hudLeft = px; dispatchEvent(new CustomEvent("disciple:hudarea", { detail: { blockedLeft: px } }));
}
export function startSidebarOverlay() {
  if (started || typeof window === "undefined") return; started = true;
  const fromAttr = () => { const a = document.documentElement.dataset.sidebarOverlay === "open"; if (a !== open) { open = a; if (!a) evWidth = 0; } emit(); };
  new MutationObserver(fromAttr).observe(document.documentElement, { attributes: true, attributeFilter: ["data-sidebar-overlay"] });
  addEventListener("disciple:sidebar-overlay", (e) => { const d = (e as CustomEvent<{ open?: boolean; width?: number }>).detail || {};
    open = !!d.open; evWidth = Number(d.width) > 0 ? Number(d.width) : 0; emit(); });
  fromAttr();
}
