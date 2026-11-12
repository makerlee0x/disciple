/**
 * Mounts the 3D flight view under the engine's 2D canvas (#c) and exposes window.__flight3d for the engine:
 *
 *   #wrap
 *     canvas.f3d-bg   — the tier sky plates (the engine's own drawBg, drawn into this context)      z 0
 *     canvas.f3d-gl   — Three.js: rocket, flame, contrail, explosions, clouds, stars                 z 1
 *     canvas#c        — the engine's 2D canvas, now transparent: HUD panels, orbs, labels, chart      z 2
 *   HTML HUD, trade bar, radio, settings — unchanged, above all of it.
 *
 * The engine calls __flight3d.frame(snapshot) at the end of its own render and __flight3d.ev(event) when something
 * already happened (a blast, a new tier, an ascension). Both are fire-and-forget: errors here switch the 3D layer off
 * and the engine goes back to drawing its 2D sky and rocket on the next frame. Trades never pass through this code.
 */
import { hasWebGPU, pickQuality, forcedBackend, PRESETS, type View3DBackend, type Preset } from "./detect";
import type { FlightView3D, Snap, Ev, PmremLike } from "./scene";

export type Flight3DHandle = {
  ready: boolean;
  backend: View3DBackend | null;
  quality: Preset["quality"];
  bg: CanvasRenderingContext2D | null;
  /** the sky backdrop context, sized for this frame (engine draws its tier sky plates into it) */
  bgFor: (W: number, H: number) => CanvasRenderingContext2D | null;
  frame: (v: Snap) => void;
  ev: (e: Ev) => void;
  idle: () => void;
  stats: () => unknown;
  failed?: string;
};

declare global { interface Window { __flight3d?: Flight3DHandle; __flight3dWant?: boolean } }

const layer = (cls: string, z: number) => {
  const c = document.createElement("canvas");
  c.className = cls;
  c.setAttribute("aria-hidden", "true");
  Object.assign(c.style, { position: "absolute", inset: "0", width: "100%", height: "100%", zIndex: String(z), pointerEvents: "none", display: "block" });
  return c;
};

export async function startView3D(wrap: HTMLElement, search: string): Promise<() => void> {
  const quality = pickQuality({
    search, innerWidth: innerWidth, innerHeight: innerHeight,
    coarsePointer: typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches,
    uaMobile: (navigator as unknown as { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile,
    userAgent: navigator.userAgent,
    deviceMemory: (navigator as unknown as { deviceMemory?: number }).deviceMemory,
    hardwareConcurrency: navigator.hardwareConcurrency,
  });
  const preset = PRESETS[quality];
  const bgC = layer("f3d-bg", 0), glC = layer("f3d-gl", 1);
  const bg = bgC.getContext("2d", { alpha: false });
  let view: FlightView3D | null = null, stopped = false, shown = false;
  const handle: Flight3DHandle = {
    ready: false, backend: null, quality, bg,
    bgFor: (W, H) => {
      const w = Math.max(1, Math.round(W * preset.bgScale)), h = Math.max(1, Math.round(H * preset.bgScale));
      if (bgC.width !== w || bgC.height !== h) { bgC.width = w; bgC.height = h; }
      return bg;
    },
    frame: () => {}, ev: () => {}, idle: () => {}, stats: () => (view ? { backend: handle.backend, quality, world: view.world?.id ?? null, ...view.stats } : null),
  };
  window.__flight3d = handle;
  const show = (on: boolean) => { if (on === shown) return; shown = on; bgC.style.display = glC.style.display = on ? "block" : "none"; };
  const fail = (why: unknown) => {
    console.warn("[flight 3d] off, using the 2D flight:", why);
    handle.ready = false; handle.failed = String((why as Error)?.message || why);
    show(false);
    try { view?.dispose(); } catch { /* ignore */ }
    view = null;
  };
  show(false);
  wrap.insertBefore(glC, wrap.firstChild); wrap.insertBefore(bgC, glC);

  try {
    // the ship (r5 GLB, ~7.7 MB) starts downloading right away, alongside the renderer start-up
    const shipP = import("./rocket").then((m) => m.loadShip());
    shipP.catch(() => {});
    const forced = forcedBackend(search);
    const gpu = (navigator as unknown as { gpu?: { requestAdapter: (o?: unknown) => Promise<unknown> } }).gpu;
    const dpr = devicePixelRatio || 1;
    let backend: View3DBackend = "webgl";
    let renderer: unknown = null;
    type PmremCtor = new (r: never) => unknown;
    let Pmrem: PmremCtor | null = null;
    if (forced !== "webgl" && (await hasWebGPU(gpu))) {
      try {
        const { WebGPURenderer, PMREMGenerator } = await import("three/webgpu");
        const r = new WebGPURenderer({ canvas: glC, antialias: preset.antialias, alpha: true });
        await r.init();
        const isGPU = !!(r as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend?.isWebGPUBackend;
        if (!isGPU) { r.dispose(); throw new Error("WebGPU backend did not start"); }
        renderer = r; backend = "webgpu"; Pmrem = PMREMGenerator as unknown as PmremCtor;
      } catch (e) {
        console.warn("[flight 3d] WebGPU failed, falling back to WebGL 2:", e);
        renderer = null;
      }
    }
    if (!renderer) {
      const { WebGLRenderer, PMREMGenerator } = await import("three");
      Pmrem = PMREMGenerator as unknown as PmremCtor;
      // WebGLRenderer needs WebGL 2; throws when it is missing → caught below → 2D flight
      renderer = new WebGLRenderer({ canvas: glC, antialias: preset.antialias, alpha: true, powerPreference: quality === "lite" ? "low-power" : "high-performance" });
      backend = "webgl";
    }
    if (stopped) { (renderer as { dispose: () => void }).dispose(); return () => {}; }
    const { FlightView3D } = await import("./scene");
    let pmrem: PmremLike | null = null;
    try { pmrem = Pmrem ? (new Pmrem(renderer as never) as PmremLike) : null; } catch { pmrem = null; }
    const ship = await shipP;
    if (stopped) { (renderer as { dispose: () => void }).dispose(); return () => {}; }
    view = new FlightView3D(renderer as ConstructorParameters<typeof FlightView3D>[0], backend, preset, dpr, pmrem, ship);
    // BRAND review stills only: ?f3dcam=front|three-quarter|underside (&f3droll=deg). Play never sets this.
    const qs = new URLSearchParams(search), cam = qs.get("f3dcam");
    if (cam) view.review = { view: cam, roll: ((+(qs.get("f3droll") ?? (cam === "three-quarter" ? 35 : 0)) || 0) * Math.PI) / 180 };
    // Launch Pad as a real 3D world (launchpad.ts); ?f3dworld=plate keeps the painted plate (A/B, or a fallback)
    if (qs.get("f3dworld") !== "plate") view.enableLaunchPad();
    // the world for the tier the flight is in, on the hull before the 3D layer shows (until then the 2D flight draws)
    const fl = (window as unknown as { __flight?: { S?: { bgU?: number } } }).__flight;
    await view.wantWorld(fl?.S?.bgU ?? 0);
    if (stopped) { view.dispose(); view = null; return () => {}; }
    if (!view.world) throw new Error("no world plate for the hull");
    // STEP 3 post stack (post.ts). If it cannot start, the view renders without it — never fails the flight.
    try {
      const { makePost, pickPost } = await import("./post");
      const R = view.rocket;
      view.post = await makePost({ renderer, backend, kind: pickPost(search, quality), scene: view.scene, camera: view.camera,
        ship: [R.hull], width: innerWidth, height: innerHeight, world: view.lp ? { scene: view.lp.scene, camera: view.lp.camera } : null,
        ratio: (renderer as { getPixelRatio?: () => number }).getPixelRatio?.() || 1 });
      view.post?.setPunch(view.world.punch);
    } catch (e) { console.warn("[flight 3d] post stack off:", e); view.post = null; }
    if (stopped) { view.dispose(); view = null; return () => {}; }
    handle.backend = backend;
    Object.defineProperty(handle, "_view", { value: view, enumerable: false, configurable: true });   // for the screenshot / debug scripts
    (renderer as { domElement?: HTMLCanvasElement }).domElement?.addEventListener?.("webglcontextlost", (e) => { e.preventDefault(); fail("WebGL context lost"); });
    const dl = (renderer as { onDeviceLost?: unknown });
    if (backend === "webgpu") dl.onDeviceLost = (info: unknown) => fail({ message: "WebGPU device lost: " + JSON.stringify(info) });
    glC.dataset.backend = backend; glC.dataset.quality = quality;
    wrap.dataset.view = "3d"; wrap.dataset.backend = backend; wrap.dataset.quality = quality;
    handle.frame = (v) => {
      if (!view) return;
      view.visible = true;
      try { view.frame(v); show(true); } catch (e) { fail(e); }
    };
    handle.ev = (e) => { if (view) try { view.ev(e); } catch (err) { fail(err); } };
    handle.idle = () => { show(false); if (view) view.visible = false; };
    handle.ready = true;
  } catch (e) {
    fail(e);
  }

  return () => {
    stopped = true;
    if (window.__flight3d === handle) delete window.__flight3d;
    try { view?.dispose(); } catch { /* ignore */ }
    view = null;
    bgC.remove(); glC.remove();
    delete wrap.dataset.view;
  };
}
