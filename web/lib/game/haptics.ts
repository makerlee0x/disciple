/**
 * Haptics: one small vocabulary of buzzes for the whole app (mobile plan, 2026-11-13).
 *
 * - Android Chrome and most Android wallet browsers: navigator.vibrate with the patterns below.
 * - iPhone: Safari has no Vibration API. Toggling a hidden <input type="checkbox" switch> inside a tap plays
 *   the system tick (iOS 18+), so taps get a light tick; non-tap moments (fills, zones, orbit) stay silent there.
 * - DISCIPLE iPhone app (mobile/, Capacitor): the native Taptic Engine plays every kind (lib/native NATIVE_HAPTICS),
 *   on finger down like Android, so trades and engine moments all buzz.
 * - The flight engine fires `disciple:sfx` cues (forwarded to the page in ?render=worker mode too, where navigator.vibrate
 *   does not exist), and the page maps those cues to haptics here, on the main thread, with one dedupe for both modes.
 * - Off when Settings → Sound → Vibration is off (lib/game/settings.ts `haptics`, on by default).
 *
 * - The Duel and Royale engines (public/turbo/…) call window.DiscipleBuzz(kind, pattern) (gameBuzz below; the Royale frame reaches
 *   its parent's), so the iPhone app's Taptic Engine plays them too. They used navigator.vibrate alone, silent on every iPhone.
 *
 * Mark an element with data-haptic="boost" (or any HapticKind) to pick its buzz, or data-haptic="off" to skip it.
 * Any other button, link or toggle gets the light "tap".
 */
import { getGameSettings } from "./settings";
import { isNativeApp, nativeHaptic, nativePattern } from "../native";

export type HapticKind = "tap" | "select" | "boost" | "dump" | "fill" | "fail" | "zone" | "hit" | "orbit" | "celebrate" | "hold" | "trick"
  | "go" | "win" | "lose" | "combo" | "warn" | "count";

export const HAPTIC_PATTERNS: Record<HapticKind, number | number[]> = {
  tap: 6,
  select: 4,
  boost: 14,
  dump: [8, 30, 8],
  fill: [10, 40, 18],
  fail: [40, 60, 40],
  zone: 22,
  hit: 10,
  orbit: [20, 40, 60, 40, 90],
  celebrate: [12, 30, 12, 30, 40],
  hold: 3,
  trick: [10, 30, 16],
  go: 30,
  win: [20, 40, 20, 40, 60],
  lose: 80,
  combo: [12, 24, 12, 24, 30],
  warn: [30, 40, 30],
  count: 8,
};
/** Kinds that come from a finger on the glass (the only ones iPhone can tick for). */
const TAP_KINDS = new Set<HapticKind>(["tap", "select", "boost", "dump", "hold", "trick"]);
/** Engine sound cue → haptic. ignite carries the side; zone only buzzes on the way up. */
export function kindForSfx(k: string, d?: { side?: string; up?: boolean }): HapticKind | null {
  switch (k) {
    case "ignite": return d?.side === "sell" ? "dump" : "boost";
    case "fill": return "fill";
    case "fail": return "fail";
    case "zone": return "zone";
    case "bomb": return "hit";
    case "orbit": return "orbit";
    case "trick": return "trick";
    default: return null;
  }
}

const canVibrate = () => typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
const isIOS = () => typeof navigator !== "undefined"
  && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

let iosSwitch: HTMLLabelElement | null = null;
function iosTick() {
  try {
    if (!iosSwitch) {
      const label = document.createElement("label");
      label.setAttribute("aria-hidden", "true");
      label.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("switch", "");
      input.tabIndex = -1;
      label.appendChild(input);
      document.body.appendChild(label);
      iosSwitch = label;
    }
    iosSwitch.click();
  } catch { /* best effort */ }
}

const lastAt: Partial<Record<HapticKind, number>> = {};
/** Same kind within this window = one buzz (a button tap and the engine's ignite cue for the same BOOST). */
const DEDUPE_MS = 140;

/** NativeRumble (iPhone app, Core Haptics) plays its own richer patterns for these engine moments; skip the plain ones then. */
const RICH_KINDS = new Set<HapticKind>(["hit", "zone", "orbit", "fill", "trick"]);
let rich = false;
export function setRichHaptics(on: boolean) { rich = on; }

export function hapticsEnabled(): boolean {
  try { return getGameSettings().haptics !== false; } catch { return true; }
}

/**
 * Fire one haptic. `fromTap` = called synchronously inside a click/touch handler (needed for the iPhone tick).
 * Returns true if something was played.
 */
/** Dedupe gate shared by haptic() and gameBuzz(): false = this kind just played. */
function fresh(kind: HapticKind): boolean {
  const now = performance.now();
  if (now - (lastAt[kind] ?? -1e9) < DEDUPE_MS) return false;
  // a boost/dump tap already buzzed: the plain tap from the same finger is redundant
  if (kind === "tap" && (now - (lastAt.boost ?? -1e9) < DEDUPE_MS || now - (lastAt.dump ?? -1e9) < DEDUPE_MS)) return false;
  lastAt[kind] = now;
  return true;
}

export function haptic(kind: HapticKind, fromTap = false): boolean {
  if (typeof window === "undefined" || !hapticsEnabled()) return false;
  if (!fresh(kind)) return false;
  if (rich && RICH_KINDS.has(kind)) return true;
  if (nativeHaptic(kind)) return true;
  if (canVibrate()) {
    try { return navigator.vibrate(HAPTIC_PATTERNS[kind]); } catch { return false; }
  }
  if (fromTap && TAP_KINDS.has(kind) && isIOS()) { iosTick(); return true; }
  return false;
}

/** Core Haptics one-shots (NativeRumble's patterns) for engine kinds, while the rumble is running. */
const RICH_PATTERN: Partial<Record<HapticKind, string>> = { hit: "bomb", trick: "trick", fill: "fill", zone: "zone" };
type UserActivationNav = Navigator & { userActivation?: { isActive: boolean } };

/**
 * A Duel / Royale engine moment (window.DiscipleBuzz). `pattern` is the engine's own Android vibration; inside the app the kind
 * picks the Taptic Engine buzz (or the richer Core Haptics pattern while the engine rumble runs). iPhone Safari can only tick,
 * and only inside a tap.
 */
export function gameBuzz(kind: string, pattern?: number | number[]): boolean {
  if (typeof window === "undefined" || !hapticsEnabled()) return false;
  const k = (kind in HAPTIC_PATTERNS ? kind : "tap") as HapticKind;
  if (!fresh(k)) return false;
  const rp = rich ? RICH_PATTERN[k] : undefined;
  if (rp && nativePattern(rp)) return true;
  if (nativeHaptic(k)) return true;
  if (canVibrate()) {
    try { return navigator.vibrate(pattern ?? HAPTIC_PATTERNS[k]); } catch { return false; }
  }
  if (TAP_KINDS.has(k) && isIOS() && (navigator as UserActivationNav).userActivation?.isActive) { iosTick(); return true; }
  return false;
}

const TAPPABLE = 'button, [role="button"], [role="tab"], [role="switch"], [role="menuitem"], a[href], summary, label, input[type="checkbox"], input[type="radio"], [data-haptic]';
function kindFor(el: Element | null): HapticKind | null {
  const t = el?.closest?.(TAPPABLE) as HTMLElement | null;
  if (!t || t.closest('[data-haptic="off"]')) return null;
  if ((t as HTMLButtonElement).disabled || t.getAttribute("aria-disabled") === "true") return null;
  const k = t.closest("[data-haptic]")?.getAttribute("data-haptic");
  return k && k in HAPTIC_PATTERNS ? (k as HapticKind) : "tap";
}

let installed = false;
/** Install once (AppShell): tap buzz on every control, engine cues → haptics, `disciple:haptic` {k} for app moments. */
export function installHaptics(): () => void {
  if (installed || typeof window === "undefined") return () => {};
  installed = true;
  const vib = canVibrate() || isNativeApp();
  // Android: buzz on finger down (same frame as the press visual). iPhone: the tick needs a click to count as a tap.
  const onDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse") return;
    const k = kindFor(e.target as Element);
    if (k) haptic(k, true);
  };
  const onClick = (e: MouseEvent) => {
    if (e.detail === 0) return;   // keyboard "click"
    if (e.target === iosSwitch || (e.target as Element)?.closest?.("label") === iosSwitch) return;
    const k = kindFor(e.target as Element);
    if (k) haptic(k, true);
  };
  const onSfx = (e: Event) => {
    const d = (e as CustomEvent).detail || {};
    const k = kindForSfx(String(d.k || ""), d);
    if (k) haptic(k);
  };
  const onApp = (e: Event) => {
    const k = String((e as CustomEvent).detail?.k || "") as HapticKind;
    if (k in HAPTIC_PATTERNS) haptic(k);
  };
  if (vib) addEventListener("pointerdown", onDown, { capture: true, passive: true });
  else if (isIOS()) addEventListener("click", onClick, { capture: true, passive: true });
  addEventListener("disciple:sfx", onSfx);
  addEventListener("disciple:haptic", onApp);
  const w = window as unknown as { DiscipleBuzz?: typeof gameBuzz };
  w.DiscipleBuzz = gameBuzz;   // the Duel / Royale engines (public/turbo/…)
  return () => {
    installed = false;
    if (w.DiscipleBuzz === gameBuzz) delete w.DiscipleBuzz;
    removeEventListener("pointerdown", onDown, { capture: true } as EventListenerOptions);
    removeEventListener("click", onClick, { capture: true } as EventListenerOptions);
    removeEventListener("disciple:sfx", onSfx);
    removeEventListener("disciple:haptic", onApp);
  };
}
