/**
 * Token-icon decals on the chrome rocket (runtime canvas compositing).
 * Composite once into an offscreen canvas → zero per-frame cost.
 */
import { IS_STATIC_PREVIEW, withBase } from "./base-path";

export const BASE_ROCKET_SRC = withBase("/assets/rocket.png"); // locked chrome sprite
export const DECAL_SCALE = 4; // composite at 4× sprite resolution

/** Roundel geometry as fractions of the sprite (tuned to /assets/rocket.png, 73×200). */
const MID = { x: 0.5, y: 0.47, r: 0.2 };
const FINS = [
  { x: 0.2, y: 0.83, r: 0.085 },
  { x: 0.8, y: 0.83, r: 0.085 },
];

function loadImg(src: string, cors: boolean, timeoutMs: number): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image();
    if (cors) im.crossOrigin = "anonymous";
    const t = setTimeout(() => rej(new Error("timeout")), timeoutMs);
    im.onload = () => { clearTimeout(t); res(im); };
    im.onerror = () => { clearTimeout(t); rej(new Error("load failed")); };
    im.src = src;
  });
}

let baseP: Promise<HTMLImageElement> | null = null;
export function loadBaseRocket() {
  return (baseP ||= loadImg(BASE_ROCKET_SRC, false, 10000));
}

const isLocal = (u: string) =>
  u.startsWith("blob:") || u.startsWith("data:") || u.startsWith("/") ||
  (typeof location !== "undefined" && u.startsWith(location.origin));

/** True when img pixels are readable (CORS actually granted). */
function canvasSafe(img: CanvasImageSource): boolean {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0, 1, 1);
    g.getImageData(0, 0, 1, 1);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load a token icon. Local/blob/data URLs load directly. Remote URLs go through
 * /api/img first (most token CDNs send no CORS headers, and a failed CORS load
 * logs a console error), then fall back to a direct crossOrigin=anonymous load.
 * Resolves null on failure/timeout → caller uses the halo emblem.
 * Static preview: no proxy — remote CDNs are skipped (halo) to avoid CORS console noise
 * and tainted-canvas crashes; local/public assets still load.
 */
export async function loadIcon(url: string | undefined | null, timeoutMs = 4000): Promise<CanvasImageSource | null> {
  if (!url) return null;
  if (!isLocal(url) && IS_STATIC_PREVIEW) return null; // no /api/img → halo emblem
  const tries = isLocal(url)
    ? [() => loadImg(url.startsWith("/") ? withBase(url) : url, true, timeoutMs)]
    : [() => loadImg(withBase("/api/img?url=" + encodeURIComponent(url)), false, timeoutMs), () => loadImg(url, true, timeoutMs)];
  for (const t of tries) {
    try {
      const img = await t();
      if (canvasSafe(img)) return img;
    } catch { /* next */ }
  }
  return null;
}

/** Default DISCIPLE halo emblem (fallback decal). */
export function haloEmblem(size = 128): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const bg = g.createRadialGradient(size * 0.4, size * 0.35, 0, size / 2, size / 2, size / 2);
  bg.addColorStop(0, "#fffbe8"); bg.addColorStop(1, "#d9b65a");
  g.fillStyle = bg; g.fillRect(0, 0, size, size);
  g.strokeStyle = "#7a5a10"; g.lineWidth = size * 0.07;
  g.beginPath(); g.ellipse(size / 2, size * 0.3, size * 0.28, size * 0.09, 0, 0, 7); g.stroke();
  g.fillStyle = "#3b2a08"; g.font = `bold ${size * 0.42}px Georgia,serif`; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText("D", size / 2, size * 0.64);
  return c;
}

function srcSize(s: CanvasImageSource): [number, number] {
  const a = s as HTMLImageElement & HTMLCanvasElement;
  return [a.naturalWidth || a.width, a.naturalHeight || a.height];
}

/** Paint one roundel: cover-fit icon, circle clip, horizontal squash (cylinder skew), gold rim. */
export interface DecalOpts {
  /** 1 = cover-fit; >1 zooms in (crop). */
  zoom?: number;
  /** Offset as fraction of roundel radius (−1…1). */
  ox?: number;
  oy?: number;
}

function roundel(o: CanvasRenderingContext2D, icon: CanvasImageSource, cx: number, cy: number, r: number, skew: number, opt: DecalOpts = {}) {
  const [iw, ih] = srcSize(icon);
  const s = Math.max((2 * r) / iw, (2 * r) / ih) * (opt.zoom ?? 1); // cover-fit handles non-square
  o.save();
  o.translate(cx, cy);
  o.transform(skew, 0, 0, 1, 0, 0); // squash X → wraps around the hull
  o.beginPath(); o.arc(0, 0, r, 0, Math.PI * 2); o.closePath();
  o.save(); o.clip();
  o.fillStyle = "#f4f1e6"; o.fill(); // backing so transparent icons read on chrome
  o.drawImage(icon, -iw * s / 2 + (opt.ox ?? 0) * r, -ih * s / 2 + (opt.oy ?? 0) * r, iw * s, ih * s);
  o.restore();
  o.lineWidth = Math.max(1.5, r * 0.12); o.strokeStyle = "#f2d48a"; o.stroke();
  o.restore();
}

/**
 * Compose base chrome + decal. Painted-on look: decal is drawn source-atop (only on hull
 * pixels), then the base is multiplied back (picks up shading) and screen-blended
 * highlights restore chrome specular on top.
 */
export function composeRocket(base: HTMLImageElement, icon: CanvasImageSource | null, scale = DECAL_SCALE, opt: DecalOpts = {}): HTMLCanvasElement {
  const w = base.naturalWidth * scale, h = base.naturalHeight * scale;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const o = c.getContext("2d")!;
  o.drawImage(base, 0, 0, w, h);
  const ic = icon || haloEmblem(256);
  // decal layer (separate so blend passes only touch decal area)
  const d = document.createElement("canvas"); d.width = w; d.height = h;
  const dx = d.getContext("2d")!;
  roundel(dx, ic, MID.x * w, MID.y * h, MID.r * w, 0.88, opt);
  for (const f of FINS) roundel(dx, ic, f.x * w, f.y * h, f.r * w, 0.7, opt);
  o.globalCompositeOperation = "source-atop"; o.globalAlpha = 0.92; o.drawImage(d, 0, 0);
  o.globalAlpha = 1;
  // shading pass: multiply base, masked to decal
  const sh = document.createElement("canvas"); sh.width = w; sh.height = h;
  const sx = sh.getContext("2d")!;
  sx.drawImage(base, 0, 0, w, h);
  sx.globalCompositeOperation = "destination-in"; sx.drawImage(d, 0, 0);
  o.globalCompositeOperation = "multiply"; o.globalAlpha = 0.45; o.drawImage(sh, 0, 0);
  // chrome highlights on top
  o.globalCompositeOperation = "screen"; o.globalAlpha = 0.35; o.drawImage(sh, 0, 0);
  o.globalAlpha = 1; o.globalCompositeOperation = "source-atop";
  const g = o.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0.3, "rgba(255,255,255,0)"); g.addColorStop(0.42, "rgba(255,255,255,.22)"); g.addColorStop(0.5, "rgba(255,255,255,0)");
  o.fillStyle = g; o.fillRect(0, 0, w, h);
  o.globalCompositeOperation = "source-over";
  return c;
}

/** Convenience: load base + icon (never throws) and compose. */
export async function brandedRocket(iconUrl?: string | null, timeoutMs = 4000, opt: DecalOpts = {}) {
  const [base, icon] = await Promise.all([loadBaseRocket(), loadIcon(iconUrl, timeoutMs)]);
  return { canvas: composeRocket(base, icon, DECAL_SCALE, opt), fallback: !icon, icon };
}

/**
 * Contrast check vs chrome: chrome is near-neutral mid/light grey. Warn when the icon is
 * low-saturation AND its mean luminance is close to chrome, or it has very little tonal range.
 */
export function contrastWarning(icon: CanvasImageSource): string | null {
  const c = document.createElement("canvas"); c.width = c.height = 32;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f4f1e6"; g.fillRect(0, 0, 32, 32); // same backing as roundel
  g.drawImage(icon, 0, 0, 32, 32);
  let px: Uint8ClampedArray;
  try { px = g.getImageData(0, 0, 32, 32).data; } catch { return null; }
  let L = 0, L2 = 0, sat = 0; const n = px.length / 4;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] / 255, gg = px[i + 1] / 255, b = px[i + 2] / 255;
    const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b; L += l; L2 += l * l;
    sat += Math.max(r, gg, b) - Math.min(r, gg, b);
  }
  L /= n; sat /= n; const sd = Math.sqrt(Math.max(0, L2 / n - L * L));
  if (sat < 0.12 && Math.abs(L - 0.72) < 0.2) return "Low contrast: this icon is grey/silver and may disappear on the chrome hull. Try a bolder colour.";
  if (sd < 0.06) return "Low detail: the icon is almost one flat tone and won't read at small sizes.";
  return null;
}
