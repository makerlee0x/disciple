/**
 * 3D flight view — which drawing path and which quality preset (pure, unit-tested by scripts/test-webgpu-flight-view.mjs).
 *
 * Existing solution this follows: Three.js, with its official WebGPURenderer when the browser has WebGPU and the classic
 * WebGLRenderer (WebGL 2) when it does not — same 3D scene, older drawing path. 3D sits in the page under the HTML HUD.
 *
 * Order of fallbacks (a player never gets a blank flight):
 *   1. WebGPU  — navigator.gpu exists AND requestAdapter() returns an adapter (current Chrome / Edge, Safari on iOS 26+,
 *                most recent Android Chrome).
 *   2. WebGL 2 — no WebGPU (older iOS, some Android GPUs, some Firefox setups, in-app browsers, hardware acceleration off),
 *                or the WebGPU device fails to start.
 *   3. 2D      — neither starts (or ?view=2d): the flight engine keeps drawing its own 2D sky and rocket, as before.
 */

export type View3DBackend = "webgpu" | "webgl";
export type View3DQuality = "full" | "lite";

export type Preset = {
  quality: View3DQuality;
  /** cap on renderer pixel ratio (multiplied into devicePixelRatio) */
  maxPixelRatio: number;
  /** lowest pixel ratio the frame governor may step down to */
  minPixelRatio: number;
  /** resolution of the 2D sky backdrop canvas relative to CSS px */
  bgScale: number;
  antialias: boolean;
  clouds: number;
  stars: number;
  /** particle caps: fire, smoke (per alpha bucket), sparks, debris, exhaust glow, contrail puffs */
  fire: number;
  smoke: number;
  sparks: number;
  debris: number;
  exhaust: number;
  trail: number;
  latheSegments: number;
  /** GPU frame budget in ms before the governor lowers resolution, then skips frames */
  budgetMs: number;
};

export const PRESETS: Record<View3DQuality, Preset> = {
  full: { quality: "full", maxPixelRatio: 2, minPixelRatio: 0.75, bgScale: 1, antialias: true, clouds: 16, stars: 520,
    fire: 160, smoke: 90, sparks: 140, debris: 40, exhaust: 260, trail: 150, latheSegments: 48, budgetMs: 8 },
  // Phones: lower resolution, fewer particles and clouds, no MSAA — stays smooth and does not cook the battery.
  lite: { quality: "lite", maxPixelRatio: 1.25, minPixelRatio: 0.6, bgScale: 0.6, antialias: false, clouds: 8, stars: 200,
    fire: 70, smoke: 40, sparks: 60, debris: 16, exhaust: 120, trail: 80, latheSegments: 28, budgetMs: 6 },
};

export type Env = {
  search?: string;
  innerWidth?: number;
  innerHeight?: number;
  coarsePointer?: boolean;
  /** navigator.userAgentData?.mobile when available */
  uaMobile?: boolean;
  userAgent?: string;
  deviceMemory?: number;
  hardwareConcurrency?: number;
};

/** "?view=2d" turns the 3D layer off (old 2D flight). Worker rendering keeps 2D (the 3D layer needs the page's main thread). */
export function wants3D(search: string, renderMode: "main" | "worker"): boolean {
  if (renderMode !== "main") return false;
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const v = (q.get("view") || "").toLowerCase();
  return v !== "2d" && v !== "off";
}

/** Phone / weak-device detection → the lighter preset. ?gfx=lite|full forces one. */
export function pickQuality(env: Env): View3DQuality {
  const q = new URLSearchParams((env.search || "").replace(/^\?/, ""));
  const f = (q.get("gfx") || "").toLowerCase();
  if (f === "lite" || f === "full") return f;
  const w = env.innerWidth ?? 1440, h = env.innerHeight ?? 900;
  const ua = env.userAgent || "";
  const mobileUA = env.uaMobile === true || /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const small = Math.min(w, h) <= 820;
  if (mobileUA) return "lite";
  if (env.coarsePointer && small) return "lite";
  if (w <= 760) return "lite";
  if ((env.deviceMemory ?? 8) <= 2 || (env.hardwareConcurrency ?? 8) <= 2) return "lite";
  return "full";
}

/** ?renderer=webgl forces the WebGL 2 path (for testing the fallback); ?renderer=webgpu only *prefers* WebGPU (still falls back). */
export function forcedBackend(search: string): View3DBackend | null {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const r = (q.get("renderer") || "").toLowerCase();
  return r === "webgl" ? "webgl" : null;
}

type GPUish = { requestAdapter: (o?: unknown) => Promise<unknown | null> } | undefined;

/**
 * True only when WebGPU can actually give us an adapter. navigator.gpu alone is not enough: some browsers expose it
 * with no usable adapter (blocklisted GPU, hardware acceleration off). Times out → false (use WebGL 2).
 */
export async function hasWebGPU(gpu: GPUish, timeoutMs = 1500): Promise<boolean> {
  if (!gpu || typeof gpu.requestAdapter !== "function") return false;
  try {
    const a = await Promise.race([
      gpu.requestAdapter({ powerPreference: "high-performance" }),
      new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
    ]);
    return !!a;
  } catch {
    return false;
  }
}

/**
 * Frame governor: if the 3D frame costs more than the budget for a while, lower the resolution step by step; at the
 * lowest step, draw the 3D layer only every other frame (dropping 3D frames — never holding up a click or a trade).
 * Recovers slowly when frames are cheap again. Pure state machine so it can be tested.
 */
export type Gov = { ema: number; slow: number; fast: number; ratio: number; skip: number };
export function govInit(p: Preset, dpr: number): Gov {
  return { ema: 0, slow: 0, fast: 0, ratio: Math.min(p.maxPixelRatio, Math.max(1, dpr)), skip: 0 };
}
export function govStep(g: Gov, p: Preset, costMs: number): "down" | "up" | "skip" | "unskip" | null {
  g.ema = g.ema ? g.ema + (costMs - g.ema) * 0.08 : costMs;
  if (g.ema > p.budgetMs) { g.slow++; g.fast = 0; } else if (g.ema < p.budgetMs * 0.45) { g.fast++; g.slow = 0; } else { g.slow = 0; g.fast = 0; }
  if (g.slow > 45) {
    g.slow = 0;
    if (g.ratio > p.minPixelRatio + 1e-6) { g.ratio = Math.max(p.minPixelRatio, +(g.ratio * 0.8).toFixed(3)); return "down"; }
    if (g.skip < 1) { g.skip = 1; return "skip"; }
    return null;
  }
  if (g.fast > 360) {
    g.fast = 0;
    if (g.skip > 0) { g.skip = 0; return "unskip"; }
    if (g.ratio < p.maxPixelRatio - 1e-6) { g.ratio = Math.min(p.maxPixelRatio, +(g.ratio * 1.15).toFixed(3)); return "up"; }
  }
  return null;
}
