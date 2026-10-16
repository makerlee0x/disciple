/**
 * Main-thread side of the worker renderer (public/flight/worker.js).
 * The engine (sim + Canvas2D) runs in a Dedicated Worker on an OffscreenCanvas; this bridge forwards input,
 * React→engine events, window globals and wallet trades in, and engine→React events, DOM writes and a ≤10 Hz
 * HUD/tooling snapshot out. window.__flight on the main thread becomes a read-only snapshot + call proxy.
 */
type Snap = { S: Record<string, unknown>; supply?: number; ys: [number, number][]; perf: Record<string, number> };
type Msg =
  | { k: "ready"; raf: boolean }
  | { k: "err"; msg: string }
  | { k: "evt"; type: string; detail: unknown; custom: boolean }
  | { k: "dom"; id: string; op: string; a: unknown; b: unknown }
  | { k: "ls"; key: string; v: string | null }
  | { k: "trade"; id: number; side: "buy" | "sell"; usd: number; o?: { frac?: number } }
  | ({ k: "snap" } & Snap);

type Win = Window & Record<string, unknown> & {
  __discipleTrade?: (side: "buy" | "sell", usd: number, o?: { frac?: number }) => Promise<unknown>;
  __rocketDecal?: { canvas: HTMLCanvasElement; t0: number; fallback: boolean };
};

/** OffscreenCanvas 2D + transferControlToOffscreen + createImageBitmap + Worker. */
export function workerRenderSupported(): boolean {
  try {
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") return false;
    if (!("transferControlToOffscreen" in HTMLCanvasElement.prototype)) return false;
    return !!new OffscreenCanvas(1, 1).getContext("2d");
  } catch {
    return false;
  }
}

/** ?render=main|worker forces a path; otherwise worker when supported. */
export function chooseRenderMode(search: string): "main" | "worker" {
  const want = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("render");
  // Main thread is the default (worker idled ~44 fps vs ~59 in headless benches); the worker is opt-in via
  // ?render=worker until it's checked on real hardware. Unsupported/failed worker still falls back to main.
  if (want === "worker") return workerRenderSupported() ? "worker" : "main";
  return "main";
}

const INBOUND = ["disciple:event", "disciple:ammo-upgrade", "disciple:ammo-keep", "disciple:ammo-tier", "disciple:ammo-query", "disciple:shoot", "disciple:sim", "disciple:chatdock", "disciple:controlsdock", "disciple:ammo-override", "disciple:sellpresets", "disciple:pnlview", "disciple:pnltag", "apsidebar"];
const GLOBALS = ["__trampWalls", "__twPreview", "__entryMcap", "__hudRT"];
const LS_KEYS = ["disciple.orbs", "disciple.bombs", "disciple.sim"];

export function startWorkerRender(o: {
  canvas: HTMLCanvasElement; wrap: HTMLElement; basePath: string; globals: Record<string, unknown>;
  onReady?: (info: { raf: boolean }) => void; onError: (msg: string) => void;
}): () => void {
  const w = window as unknown as Win;
  const worker = new Worker(o.basePath + "/flight/worker.js");
  const post = (m: unknown, t?: Transferable[]) => worker.postMessage(m, t || []);
  const offs: (() => void)[] = [];
  const on = <K extends string>(t: EventTarget, type: K, f: (e: Event) => void, opt?: AddEventListenerOptions) => {
    t.addEventListener(type, f, opt); offs.push(() => t.removeEventListener(type, f, opt));
  };
  let alive = true, ready = false;

  // ---- main-thread window.__flight: snapshot + call proxy (sync reads used by HUD components / tooling)
  let snap: Snap = { S: { confirmed: { mcap: null } }, ys: [], perf: {} };
  const screenYToMcap = (y: number) => {
    const ys = snap.ys; if (ys.length < 2) return 0;
    let i = 0; while (i < ys.length - 2 && y > ys[i + 1][0]) i++;
    const [y0, m0] = ys[i], [y1, m1] = ys[i + 1], f = (y - y0) / (y1 - y0 || 1);
    return Math.exp(Math.log(m0) + (Math.log(m1) - Math.log(m0)) * f);
  };
  const api = {
    mode: "worker",
    get S() { return snap.S; },
    get source() { return { supply: snap.supply }; },
    screenYToMcap,
  } as Record<string, unknown>;
  w.__flight = new Proxy(api, {
    get(t, p: string) { if (p in t) return t[p]; if (typeof p !== "string" || p === "then") return undefined; return (...args: unknown[]) => post({ k: "call", name: p, args }); },
  });
  w.__flightPerf = { get n() { return snap.perf.n; }, get long25() { return snap.perf.long25; }, get long50() { return snap.perf.long50; },
    get max() { return snap.perf.max; }, get sum() { return snap.perf.sum; }, reset: () => post({ k: "perfReset" }) };

  // ---- worker → main
  worker.onmessage = async (ev: MessageEvent<Msg>) => {
    const d = ev.data;
    switch (d.k) {
      case "ready": ready = true; o.onReady?.({ raf: d.raf }); break;
      case "err": if (alive) o.onError(d.msg); break;
      case "evt": window.dispatchEvent(d.custom ? new CustomEvent(d.type, { detail: d.detail }) : new Event(d.type)); break;
      case "snap": snap = d; break;
      case "ls": try { if (d.v == null) localStorage.removeItem(d.key); else localStorage.setItem(d.key, d.v); } catch { /* private mode */ } break;
      case "dom": {
        const el = document.getElementById(d.id) as HTMLElement | null; if (!el) break;
        if (d.op === "text") el.textContent = String(d.a);
        else if (d.op === "class") el.classList.toggle(String(d.a), d.b as boolean);
        else if (d.op === "style") {
          // canvas CSS size is owned by layout (100% of wrap) in worker mode; only the cursor is forwarded
          if (d.id === "c" && d.a !== "cursor") break;
          (el.style as unknown as Record<string, string>)[String(d.a)] = String(d.b);
        }
        break;
      }
      case "trade": {
        const b = w.__discipleTrade;
        let result: unknown;
        try { result = b ? await (d.o ? b(d.side, d.usd, d.o) : b(d.side, d.usd)) : { ok: false, reason: "wallet bridge unavailable" }; }
        catch (e) { result = { ok: false, reason: String((e as Error)?.message || e).slice(0, 80) }; }
        post({ k: "tradeRes", id: d.id, result: JSON.parse(JSON.stringify(result ?? null)) });
        break;
      }
    }
  };
  worker.onerror = (e) => { if (alive) o.onError(e.message || "worker error"); };

  // ---- init: transfer the canvas
  const rect = () => { const r = o.canvas.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
  const size = () => ({ w: o.wrap.clientWidth, h: o.wrap.clientHeight, dpr: window.devicePixelRatio || 1, rect: rect() });
  const off = o.canvas.transferControlToOffscreen();
  const ls: Record<string, string> = {};
  for (const k of LS_KEYS) { try { const v = localStorage.getItem(k); if (v != null) ls[k] = v; } catch { /* ignore */ } }
  const globals: Record<string, unknown> = { ...o.globals };
  for (const g of GLOBALS) if (w[g] !== undefined) globals[g] = w[g];
  post({ k: "init", canvas: off, engineUrl: o.basePath + "/flight/engine.js", search: location.search, href: location.href, pathname: location.pathname,
    ls, globals, hidden: document.hidden, tradeAvail: !!w.__discipleTrade, ...size() }, [off]);

  // ---- input
  for (const t of INBOUND) on(window, t, (e) => { const ce = e as CustomEvent; post({ k: "ev", type: t, detail: "detail" in ce ? ce.detail ?? null : null, custom: "detail" in ce }); });
  const typing = (e: Event) => { const el = e.target as HTMLElement | null; return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)); };
  const key = (e: Event) => { const k = e as KeyboardEvent; if (k.type === "keydown" && typing(e)) return;   // typing in chat / inputs: no game hotkeys
    if (k.code === "Space" && k.type === "keydown") k.preventDefault();
    post({ k: "key", type: k.type, code: k.code, key: k.key, repeat: k.repeat, ctrlKey: k.ctrlKey, metaKey: k.metaKey, shiftKey: k.shiftKey }); };
  on(window, "keydown", key); on(window, "keyup", key);
  on(window, "blur", () => post({ k: "blur" }));
  const ptr = (e: Event) => { const p = e as PointerEvent; if (p.type === "pointerdown") p.preventDefault(); post({ k: "ptr", type: p.type, x: p.clientX, y: p.clientY }); };
  for (const t of ["pointermove", "pointerleave", "pointerdown"]) on(o.canvas, t, ptr);
  on(document, "visibilitychange", () => post({ k: "vis", hidden: document.hidden }));
  const orb = document.getElementById("orbBtn");
  if (orb) on(orb, "click", () => { post({ k: "orbClick" }); (orb as HTMLElement).blur(); });
  const ro = new ResizeObserver(() => post({ k: "size", ...size() })); ro.observe(o.wrap); offs.push(() => ro.disconnect());
  on(window, "resize", () => post({ k: "size", ...size() }));

  // ---- globals / wallet availability / decal: polled at 10 Hz, posted only on change
  const last: Record<string, unknown> = {}; let lastTrade = !!w.__discipleTrade, decalT0 = -1;
  for (const g of GLOBALS) last[g] = w[g];
  const poll = window.setInterval(() => {
    for (const g of GLOBALS) if (w[g] !== last[g]) { last[g] = w[g]; try { post({ k: "glob", name: g, value: w[g] ?? null }); } catch { /* uncloneable */ } }
    const t = !!w.__discipleTrade; if (t !== lastTrade) { lastTrade = t; post({ k: "tradeAvail", on: t }); }
    const dc = w.__rocketDecal; if (dc && dc.t0 !== decalT0) { decalT0 = dc.t0;
      createImageBitmap(dc.canvas).then((bm) => post({ k: "decal", bitmap: bm, fallback: dc.fallback }, [bm])).catch(() => {}); }
  }, 100);
  offs.push(() => window.clearInterval(poll));

  return () => {
    alive = false; for (const f of offs) f();
    try { post({ k: "stop" }); } catch { /* gone */ }
    setTimeout(() => worker.terminate(), 50);
    if (w.__flight && (w.__flight as Record<string, unknown>).mode === "worker") delete w.__flight;
    void ready;
  };
}
