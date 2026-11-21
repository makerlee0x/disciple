/**
 * The DISCIPLE iPhone app (native app plan, maker 2026-11-14: Capacitor wrap, Apple App Store only).
 *
 * The app (mobile/) is a native shell that loads this site. Capacitor injects `window.Capacitor` into the page, with the
 * native plugins the shell ships (Haptics, PushNotifications, App, StatusBar, SplashScreen, Browser) reachable through
 * `Capacitor.Plugins`, so the site needs no Capacitor npm packages. The shell also adds "DiscipleApp/1" to the user agent,
 * which the server can read (isNativeAppUa).
 *
 * Everything here is a no-op in a normal browser.
 */

export const NATIVE_UA_TAG = "DiscipleApp/";

/** Server or client: does this user agent belong to the DISCIPLE app? */
export const isNativeAppUa = (ua: string | null | undefined) => !!ua && ua.includes(NATIVE_UA_TAG);

type Listener = { remove(): Promise<void> | void };
type Plugin = Record<string, (...a: never[]) => unknown> & { addListener?: (ev: string, cb: (d: never) => void) => Promise<Listener> | Listener };
type Cap = { DEBUG?: boolean; isNativePlatform?: () => boolean; getPlatform?: () => string; Plugins?: Record<string, Plugin | undefined> };

function cap(): Cap | null {
  if (typeof window === "undefined") return null;
  return ((window as unknown as { Capacitor?: Cap }).Capacitor) ?? null;
}

/** True inside the DISCIPLE iPhone app. */
export function isNativeApp(): boolean {
  const c = cap();
  if (c?.isNativePlatform?.()) return true;
  return typeof navigator !== "undefined" && isNativeAppUa(navigator.userAgent);
}

/** Xcode debug build (CAPACITOR_DEBUG in mobile/ios/debug.xcconfig): its push tokens belong to Apple's sandbox. */
export function nativeDebugBuild(): boolean { return isNativeApp() && cap()?.DEBUG === true; }

export function nativePlugin<T = Plugin>(name: string): T | null {
  if (!isNativeApp()) return null;
  return (cap()?.Plugins?.[name] as T | undefined) ?? null;
}

// ---------------------------------------------------------------- haptics

type ImpactStyle = "LIGHT" | "MEDIUM" | "HEAVY";
type NoteType = "SUCCESS" | "WARNING" | "ERROR";
type NativeBuzz = { impact: ImpactStyle } | { note: NoteType } | { select: true } | { seq: ImpactStyle[]; gap: number };

/** lib/game/haptics kinds → the iPhone's Taptic Engine (same vocabulary as the web patterns). */
export const NATIVE_HAPTICS: Record<string, NativeBuzz> = {
  tap: { impact: "LIGHT" },
  select: { select: true },
  hold: { select: true },
  boost: { impact: "MEDIUM" },
  dump: { seq: ["MEDIUM", "LIGHT"], gap: 40 },
  fill: { note: "SUCCESS" },
  fail: { note: "ERROR" },
  zone: { impact: "MEDIUM" },
  hit: { impact: "HEAVY" },
  orbit: { seq: ["MEDIUM", "HEAVY", "HEAVY"], gap: 70 },
  celebrate: { note: "SUCCESS" },
  trick: { seq: ["LIGHT", "MEDIUM"], gap: 60 },
};

type HapticsPlugin = {
  impact(o: { style: ImpactStyle }): Promise<void>;
  notification(o: { type: NoteType }): Promise<void>;
  selectionStart(): Promise<void>; selectionChanged(): Promise<void>; selectionEnd(): Promise<void>;
};

/** Play one haptic kind on the native Taptic Engine. Returns false outside the app (callers fall back to the web path). */
export function nativeHaptic(kind: string): boolean {
  const h = nativePlugin<HapticsPlugin>("Haptics");
  const b = NATIVE_HAPTICS[kind];
  if (!h || !b) return false;
  try {
    if ("impact" in b) void h.impact({ style: b.impact }).catch(() => {});
    else if ("note" in b) void h.notification({ type: b.note }).catch(() => {});
    else if ("select" in b) void h.selectionStart().then(() => h.selectionChanged()).then(() => h.selectionEnd()).catch(() => {});
    else b.seq.forEach((s, i) => setTimeout(() => void h.impact({ style: s }).catch(() => {}), i * b.gap));
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------- engine rumble (Core Haptics, mobile/ios/App/App/DiscipleNative.swift)

type RumblePlugin = { rumble(o: { intensity: number; sharpness: number }): Promise<{ supported?: boolean }>; stop(): Promise<void>; play(o: { pattern: string }): Promise<{ supported?: boolean }>; supported(): Promise<{ supported: boolean }> };
const rumbleP = () => nativePlugin<RumblePlugin>("DiscipleHaptics");
/** true inside an app build that ships the DiscipleHaptics plugin and a phone with a Taptic Engine. */
export async function nativeRumbleSupported(): Promise<boolean> {
  const p = rumbleP(); if (!p) return false;
  try { return (await p.supported()).supported === true; } catch { return false; }
}
/** Continuous engine rumble level (0 = silent; the loop keeps running until nativeRumbleStop). */
export function nativeRumble(intensity: number, sharpness: number): void { void rumbleP()?.rumble({ intensity, sharpness }).catch(() => {}); }
export function nativeRumbleStop(): void { void rumbleP()?.stop().catch(() => {}); }
/** One-shot Core Haptics pattern: bomb · zone · orbit · trick · fill · stylefill. false outside the app. */
export function nativePattern(pattern: string): boolean { const p = rumbleP(); if (!p) return false; void p.play({ pattern }).catch(() => {}); return true; }

// ---------------------------------------------------------------- Live Activity (lock screen + Dynamic Island)

export type LiveFlightState = { mcap: number; valueUsd: number; pnlUsd: number; pnlPct: number; zone: string; nextZone: string; zoneProgress: number; closed?: boolean };
export type LiveFlightStart = LiveFlightState & { coin: string; ticker: string; investedUsd: number; entryMcap: number; url: string };
type LivePlugin = {
  supported(): Promise<{ supported: boolean }>;
  start(o: LiveFlightStart): Promise<{ id: string }>;
  update(o: LiveFlightState & { coin?: string }): Promise<{ running: boolean }>;
  end(o: LiveFlightState & { coin?: string }): Promise<void>;
  addListener?: Plugin["addListener"];
};
const liveP = () => nativePlugin<LivePlugin>("LiveFlight");
export async function liveFlightSupported(): Promise<boolean> { const p = liveP(); if (!p) return false; try { return (await p.supported()).supported === true; } catch { return false; } }
export async function liveFlightStart(o: LiveFlightStart): Promise<string | null> { const p = liveP(); if (!p) return null; try { return (await p.start(o)).id; } catch { return null; } }
export function liveFlightUpdate(o: LiveFlightState & { coin?: string }): void { void liveP()?.update(o).catch(() => {}); }
export function liveFlightEnd(o: LiveFlightState & { coin?: string }): void { void liveP()?.end(o).catch(() => {}); }
/** Apple's push token for the running activity (hex), so the server can keep it fresh while the app is closed. */
export function onLiveFlightToken(cb: (d: { id: string; coin: string; token: string }) => void): () => void {
  const p = liveP(); if (!p?.addListener) return () => {};
  const l = p.addListener("pushToken", cb as never);
  return () => { void Promise.resolve(l).then((x) => x.remove()).catch(() => {}); };
}

// ---------------------------------------------------------------- deep links

/** An in-site path, never another site: "//evil.com" or "/\\evil.com" would leave the app's site. */
export function safeInSitePath(p: unknown): string | null {
  if (typeof p !== "string" || !p.startsWith("/")) return null;
  const clean = p.replace(/^[/\\]+/, "/");
  if (/[\u0000-\u001f]/.test(clean)) return null;
  return clean;
}

/**
 * A link that opened the app (universal link https://disciple.vip/... or disciple://...) → the in-site path to show,
 * or null when it isn't ours. Pure (scripts/test-native.mts).
 */
export function deepLinkPath(url: string, hosts: string[] = ["disciple.vip", "www.disciple.vip"]): string | null {
  try {
    const u = new URL(url);
    if (u.protocol === "disciple:") {
      // disciple://coin/0x… → /coin/0x…
      const p = `/${u.host}${u.pathname}`.replace(/\/+$/, "") || "/";
      return safeInSitePath(`${p}${u.search}${u.hash}`);
    }
    if (u.protocol !== "https:" || !hosts.includes(u.hostname)) return null;
    return safeInSitePath(`${u.pathname || "/"}${u.search}${u.hash}`);
  } catch { return null; }
}

// ---------------------------------------------------------------- push

type PushPlugin = {
  checkPermissions(): Promise<{ receive: string }>;
  requestPermissions(): Promise<{ receive: string }>;
  register(): Promise<void>;
  unregister?(): Promise<void>;
  addListener(ev: string, cb: (d: never) => void): Promise<Listener>;
};

export type NativePushState = "granted" | "denied" | "prompt" | "unsupported";

export async function nativePushPermission(): Promise<NativePushState> {
  const p = nativePlugin<PushPlugin>("PushNotifications");
  if (!p) return "unsupported";
  try { const r = await p.checkPermissions(); return r.receive === "granted" ? "granted" : r.receive === "denied" ? "denied" : "prompt"; } catch { return "unsupported"; }
}

/** Ask for permission and register with Apple; resolves the APNs device token (hex). */
export async function nativePushRegister(timeoutMs = 15_000): Promise<{ token: string } | { error: "denied" | "unsupported" | "failed" }> {
  const p = nativePlugin<PushPlugin>("PushNotifications");
  if (!p) return { error: "unsupported" };
  try {
    let perm = await p.checkPermissions();
    if (perm.receive !== "granted") perm = await p.requestPermissions();
    if (perm.receive !== "granted") return { error: "denied" };
    const subs: Listener[] = [];
    const done = new Promise<{ token: string } | { error: "failed" }>((resolve) => {
      const t = setTimeout(() => resolve({ error: "failed" }), timeoutMs);
      void p.addListener("registration", ((d: { value: string }) => { clearTimeout(t); resolve({ token: String(d.value) }); }) as never).then((l) => subs.push(l));
      void p.addListener("registrationError", (() => { clearTimeout(t); resolve({ error: "failed" }); }) as never).then((l) => subs.push(l));
    });
    await p.register();
    const r = await done;
    subs.forEach((l) => void l.remove());
    return r;
  } catch { return { error: "failed" }; }
}

/** Saved on this device so Settings knows which token to remove when alerts are turned off. */
export const NATIVE_PUSH_TOKEN_KEY = "disciple.native.apns.v1";

// ---------------------------------------------------------------- keep the screen on mid-flight

type KeepAwakePlugin = { keepAwake(): Promise<void>; allowSleep(): Promise<void> };
/** iPhone app: stop the screen dimming while a flight is open (the web wake lock isn't reliable in the app's web view). */
export function nativeKeepAwake(on: boolean): boolean {
  const k = nativePlugin<KeepAwakePlugin>("KeepAwake");
  if (!k) return false;
  void (on ? k.keepAwake() : k.allowSleep()).catch(() => {});
  return true;
}

// ---------------------------------------------------------------- shell wiring

const LAST_LINK_KEY = "disciple.lastLink.v1";
/** The last link this app session opened (sessionStorage survives a reload), so the launch link isn't opened twice. */
function lastLink(): string | null { try { return sessionStorage.getItem(LAST_LINK_KEY); } catch { return null; } }
function markLink(url: string) { try { sessionStorage.setItem(LAST_LINK_KEY, url); } catch { /* ignore */ } }

let installed = false;

/**
 * Called once from the app shell. Inside the app: dark status bar, universal links and push taps route inside the site,
 * and the html element gets `data-native="ios"` so CSS can hide web-only bits (Add to Home Screen, Open in Safari).
 */
export function installNativeShell(navigate: (path: string) => void): () => void {
  if (installed || !isNativeApp()) return () => {};
  installed = true;
  const subs: Listener[] = [];
  const keep = (l: Promise<Listener> | Listener | undefined) => { if (l) void Promise.resolve(l).then((x) => subs.push(x)).catch(() => {}); };
  try { document.documentElement.dataset.native = cap()?.getPlatform?.() || "ios"; } catch { /* ignore */ }

  // the launch screen (moon) covers the load; drop it once the page has painted
  const splash = nativePlugin<{ hide(o?: { fadeOutDuration?: number }): Promise<void> }>("SplashScreen");
  requestAnimationFrame(() => requestAnimationFrame(() => void splash?.hide({ fadeOutDuration: 250 }).catch(() => {})));

  const bar = nativePlugin<{ setStyle(o: { style: string }): Promise<void> }>("StatusBar");
  void bar?.setStyle({ style: "DARK" }).catch(() => {});

  const app = nativePlugin("App");
  const t0 = Date.now();
  const openLink = (url: string, from: "launch" | "event") => {
    // the shell can hand over the launch link twice (getLaunchUrl and a replayed appUrlOpen), and getLaunchUrl keeps
    // answering with the last link after a reload: open each one once
    if (url === lastLink() && (from === "launch" || Date.now() - t0 < 10_000)) return;
    markLink(url);
    // sign-in coming back on disciple://oauth?privy_oauth_… outside the system sheet: finish it on the current page
    if (/^disciple:\/\/oauth\b/i.test(url)) {
      if (from === "launch") return;
      try { const q = new URL(url).searchParams, u = new URL(location.href); q.forEach((v, k) => u.searchParams.set(k, v)); location.replace(u.toString()); } catch { /* ignore */ }
      return;
    }
    const p = deepLinkPath(url);
    // Xcode debug builds: a link with liveDemo=1 shows the sample Live Activity on the next flight (components/flight/LiveFlight)
    if (p && nativeDebugBuild() && /[?&]liveDemo=1\b/.test(p)) { try { sessionStorage.setItem("disciple.liveDemo", "1"); } catch { /* ignore */ } }
    if (p) navigate(p);
  };
  keep(app?.addListener?.("appUrlOpen", ((d: { url: string }) => openLink(d.url, "event")) as never));
  // Cold start from a link (a challenge tapped in Messages while the app was closed): the app boots on the home page, so
  // ask for the link that launched it and open that page
  void (async () => {
    try {
      const r = await (app?.getLaunchUrl as (() => Promise<{ url?: string } | undefined>) | undefined)?.();
      if (r?.url) openLink(r.url, "launch");
    } catch { /* appUrlOpen still covers links that arrive while the app is open */ }
  })();

  const push = nativePlugin("PushNotifications");
  keep(push?.addListener?.("pushNotificationActionPerformed", ((d: { notification?: { data?: { url?: string } } }) => {
    const p = safeInSitePath(d.notification?.data?.url);
    if (p) navigate(p);
  }) as never));

  return () => { installed = false; subs.forEach((l) => void l.remove()); };
}
