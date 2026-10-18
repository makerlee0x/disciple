/**
 * GAME settings store (ESC menu, components/flight/SettingsMenu.tsx): hotkeys, audio, language.
 * One localStorage key (SETTINGS_KEY), sanitized on load, broadcast to the flight engine as `disciple:hotkeys`
 * (public/flight/engine.js also reads SETTINGS_KEY at boot, so the bindings hold before React pushes them).
 *
 * Amounts are NOT stored here: the $ per buy preset and the % per sell size stay in Swap settings
 * (lib/trade/swapSettings.ts, per scope paper/live/sim) so the trade bar, the ammo panel and the settings menu share one book.
 *
 * Audio: the game has no audio engine yet. `sfx` / `music` are persisted and exposed via audioLevel() + the
 * `disciple:audio` event so a future sound system can plug in without new UI (see lib/game/audio.ts).
 */
import { useSyncExternalStore } from "react";

export const SETTINGS_KEY = "disciple.game.settings.v1";
export type Locale = "en" | "zh" | "ko" | "ja" | "es";
export const LOCALE_IDS: Locale[] = ["en", "zh", "ko", "ja", "es"];
export interface AudioChannel { on: boolean; vol: number }
export interface GameSettings {
  v: 1;
  /** KeyboardEvent.code per slot: 6 buy presets (select only) + 4 sell sizes (select only) */
  keys: { buy: string[]; sell: string[] };
  sfx: AudioChannel;
  music: AudioChannel;
  lang: Locale;
}
export const DEFAULT_BUY_KEYS = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6"];
export const DEFAULT_SELL_KEYS = ["KeyZ", "KeyX", "KeyC", "KeyV"];
export const DEFAULT_GAME_SETTINGS: GameSettings = {
  v: 1, keys: { buy: DEFAULT_BUY_KEYS, sell: DEFAULT_SELL_KEYS },
  sfx: { on: true, vol: 0.7 }, music: { on: true, vol: 0.5 }, lang: "en",
};
/** Keys the game already uses for something else (SPACE boost, SHIFT dump, steering, toggles, chat, menu). Not bindable. */
export const RESERVED_CODES = new Set([
  "Space", "ShiftLeft", "ShiftRight", "Escape", "Enter", "NumpadEnter", "Tab", "Backspace", "CapsLock",
  "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight", "ContextMenu",
  "KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "KeyG", "KeyO", "KeyP", "KeyB", "KeyM", "KeyF", "KeyT", "KeyH", "Slash", "F1",
  "Equal", "Minus", "BracketLeft", "BracketRight",
]);
const BINDABLE = /^(Digit\d|Key[A-Z]|Numpad\d|F([2-9]|1[0-2])|Comma|Period|Semicolon|Quote|Backquote|Backslash)$/;
export const isBindable = (code: string) => BINDABLE.test(code) && !RESERVED_CODES.has(code);

/** Short label for a KeyboardEvent.code: Digit1 → "1", KeyZ → "Z", Numpad3 → "Num3". */
export function keyLabel(code: string): string {
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Numpad\d$/.test(code)) return "Num" + code.slice(6);
  return ({ Comma: ",", Period: ".", Semicolon: ";", Quote: "'", Backquote: "`", Backslash: "\\" } as Record<string, string>)[code] || code;
}

const clamp01 = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d);
const chan = (x: unknown, d: AudioChannel): AudioChannel => {
  const o = (x && typeof x === "object" ? x : {}) as Partial<AudioChannel>;
  return { on: typeof o.on === "boolean" ? o.on : d.on, vol: clamp01(o.vol, d.vol) };
};
function keyList(x: unknown, d: string[], taken: Set<string>): string[] {
  const a = Array.isArray(x) && x.length === d.length ? x : d;
  return a.map((c, i) => {
    const k = typeof c === "string" && isBindable(c) && !taken.has(c) ? c : !taken.has(d[i]) ? d[i] : "";
    if (k) taken.add(k);
    return k;
  });
}
export function sanitizeGameSettings(x: unknown): GameSettings {
  const o = (x && typeof x === "object" ? x : {}) as Partial<GameSettings>;
  const k = (o.keys && typeof o.keys === "object" ? o.keys : {}) as Partial<GameSettings["keys"]>;
  const taken = new Set<string>();
  const buy = keyList(k.buy, DEFAULT_BUY_KEYS, taken), sell = keyList(k.sell, DEFAULT_SELL_KEYS, taken);
  return {
    v: 1, keys: { buy, sell },
    sfx: chan(o.sfx, DEFAULT_GAME_SETTINGS.sfx), music: chan(o.music, DEFAULT_GAME_SETTINGS.music),
    lang: LOCALE_IDS.includes(o.lang as Locale) ? (o.lang as Locale) : "en",
  };
}

/** Bind `code` to a slot; a key already used by another slot is swapped onto the slot's old key (no duplicates). */
export function bindKey(s: GameSettings, slot: { kind: "buy" | "sell"; i: number }, code: string): GameSettings {
  if (!isBindable(code)) return s;
  const buy = [...s.keys.buy], sell = [...s.keys.sell];
  const list = slot.kind === "buy" ? buy : sell, old = list[slot.i];
  const bi = buy.indexOf(code), si = sell.indexOf(code);
  if (bi >= 0) buy[bi] = old; else if (si >= 0) sell[si] = old;
  list[slot.i] = code;
  return { ...s, keys: { buy, sell } };
}

// ---- store (localStorage + in-tab subscribers + cross-tab storage events)
let cur: GameSettings = DEFAULT_GAME_SETTINGS;
let loaded = false;
const subs = new Set<() => void>();
function load(): GameSettings {
  if (!loaded && typeof window !== "undefined") {
    loaded = true;
    try { cur = sanitizeGameSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null")); } catch { cur = DEFAULT_GAME_SETTINGS; }
    addEventListener("storage", (e) => { if (e.key === SETTINGS_KEY) { loaded = false; load(); broadcast(); subs.forEach((f) => f()); } });
  }
  return cur;
}
export function getGameSettings(): GameSettings { return load(); }
/** Push the engine-facing parts (hotkeys, audio) as events; safe to call repeatedly (e.g. after the engine boots). */
export function broadcast(s: GameSettings = load()) {
  if (typeof window === "undefined") return;
  dispatchEvent(new CustomEvent("disciple:hotkeys", { detail: { buy: s.keys.buy, sell: s.keys.sell } }));
  dispatchEvent(new CustomEvent("disciple:audio", { detail: { sfx: audioLevel("sfx", s), music: audioLevel("music", s) } }));
}
export function setGameSettings(next: GameSettings | ((s: GameSettings) => GameSettings)) {
  const n = sanitizeGameSettings(typeof next === "function" ? next(load()) : next);
  cur = n;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(n)); } catch { /* private mode */ }
  broadcast(n);
  subs.forEach((f) => f());
}
function subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; }
export function useGameSettings(): GameSettings {
  return useSyncExternalStore(subscribe, load, () => DEFAULT_GAME_SETTINGS);
}
/** Effective 0..1 gain for a channel (0 when muted). */
export function audioLevel(ch: "sfx" | "music", s: GameSettings = load()): number {
  const c = s[ch];
  return c.on ? c.vol : 0;
}
