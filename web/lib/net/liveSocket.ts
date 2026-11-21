/**
 * A WebSocket that stays up on a phone (perf pass, 2026-11-21). Games only play while a price feed is live, and phone
 * networks break sockets in ways that never fire `close`: a Wi-Fi to 5G hand-off, a tunnel, the app coming back from the
 * background. So this one:
 *  - counts any frame (prices, pongs) as proof of life, and drops a socket that has gone quiet for `staleMs`;
 *  - retries with jittered backoff (0.5 s doubling, capped at 8 s, so a lost price feed is back within seconds);
 *  - reconnects at once, backoff reset, when the phone comes back online or the app/tab comes back to the front;
 *  - doesn't spin while the phone is offline or the page is hidden (slow retries only), which saves battery.
 * Every stream in lib/turbo builds on it. Nothing here invents a price: callers still emit only what the venue sent.
 */

export interface LiveSocketOpts {
  /** the URL to open, or null when not ready yet (e.g. a market id still loading): retried on the backoff */
  url: () => string | null;
  /** subscribe here; called on every (re)connect */
  onOpen?: (ws: WebSocket) => void;
  onMessage: (data: string) => void;
  /** the socket went away (or never opened): start any HTTP fallback here */
  onDown?: () => void;
  /** keep-alive frame; any reply counts as a frame. Default none. */
  ping?: string;
  pingMs?: number;
  /** no frame for this long while open = dead socket. Default 15 s. 0 = never. */
  staleMs?: number;
  WebSocketImpl?: typeof WebSocket;
}

export interface LiveSocket {
  stop(): void;
  /** open now if not open (backoff reset) */
  kick(): void;
  open(): boolean;
  /** ms since the last frame (Infinity before the first) */
  quietMs(): number;
}

const BASE_MS = 500;
const CAP_MS = 8_000;
const IDLE_CAP_MS = 30_000; // offline or hidden: try now and then, no faster

const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/** Calls `cb` when the phone comes back online or the page comes back to the front. Returns unsubscribe. */
export function onNetWake(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const vis = () => { if (!hidden()) cb(); };
  const show = (e: PageTransitionEvent) => { if (e.persisted) cb(); };
  window.addEventListener("online", cb);
  window.addEventListener("pageshow", show);
  document.addEventListener("visibilitychange", vis);
  // Capacitor fires `resume` on the document when the app returns from the background
  document.addEventListener("resume", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("pageshow", show);
    document.removeEventListener("visibilitychange", vis);
    document.removeEventListener("resume", cb);
  };
}

/** next wait for attempt `n` (0-based): doubling from 0.5 s, capped, ±25 % jitter so a crowd doesn't reconnect in step */
export function backoffMs(n: number, cap = CAP_MS, rand = Math.random): number {
  const base = Math.min(cap, BASE_MS * 2 ** Math.min(n, 10));
  return Math.round(base * (0.75 + rand() * 0.5));
}

export function liveSocket(o: LiveSocketOpts): LiveSocket {
  const Impl = o.WebSocketImpl ?? (typeof WebSocket !== "undefined" ? WebSocket : undefined);
  const staleMs = o.staleMs ?? 15_000;
  let ws: WebSocket | null = null, stopped = false, tries = 0, lastFrame = 0;
  let retry: ReturnType<typeof setTimeout> | null = null, beat: ReturnType<typeof setInterval> | null = null;

  const drop = () => {
    if (beat) { clearInterval(beat); beat = null; }
    const s = ws; ws = null;
    if (s) { s.onopen = s.onmessage = s.onerror = s.onclose = null; try { s.close(); } catch { /* already gone */ } }
  };
  const down = () => { drop(); if (stopped) return; try { o.onDown?.(); } catch { /* caller */ } schedule(); };
  const schedule = (now = false) => {
    if (stopped || retry) return;
    const idle = offline() || hidden();
    const wait = now ? 0 : backoffMs(tries++, idle ? IDLE_CAP_MS : CAP_MS);
    retry = setTimeout(() => { retry = null; connect(); }, wait);
  };
  const connect = () => {
    if (stopped || ws) return;
    const url = o.url();
    if (!Impl || !url) { schedule(); return; }
    let s: WebSocket;
    try { s = new Impl(url); } catch { down(); return; }
    ws = s;
    s.onopen = () => {
      tries = 0; lastFrame = Date.now();
      try { o.onOpen?.(s); } catch { /* caller */ }
      const every = Math.min(o.pingMs ?? 20_000, staleMs ? Math.max(1_000, staleMs / 2) : Infinity);
      beat = setInterval(() => {
        if (ws !== s) return;
        // dead socket that never fired close (network hand-off): drop it and dial again
        if (staleMs && Date.now() - lastFrame > staleMs) { down(); return; }
        if (o.ping) try { s.send(o.ping); } catch { /* closing */ }
      }, every);
    };
    s.onmessage = (ev: MessageEvent) => {
      lastFrame = Date.now();
      if (typeof ev.data === "string") try { o.onMessage(ev.data); } catch { /* caller */ }
    };
    s.onerror = () => { /* onclose follows */ };
    s.onclose = () => { if (ws === s) down(); };
  };
  const isOpen = () => !!ws && ws.readyState === 1;
  const wake = () => {
    if (stopped) return;
    // back to the front or back online: a socket that has been quiet is probably dead, so don't wait for the watchdog
    if (ws && isOpen() && (!staleMs || Date.now() - lastFrame < Math.min(staleMs, 4_000))) return;
    if (ws && ws.readyState === 0) return; // still dialing
    drop(); tries = 0;
    if (retry) { clearTimeout(retry); retry = null; }
    schedule(true);
  };
  const offWake = onNetWake(wake);
  connect();
  return {
    stop() { stopped = true; offWake(); if (retry) clearTimeout(retry); retry = null; drop(); },
    kick: wake,
    open: isOpen,
    quietMs: () => (lastFrame ? Date.now() - lastFrame : Infinity),
  };
}
