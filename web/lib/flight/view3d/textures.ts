/** Procedural canvas textures for the 3D flight view (built once, no image downloads). */
import { CanvasTexture, SRGBColorSpace, EquirectangularReflectionMapping, type Texture } from "three";

const cnv = (w: number, h: number) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const tex = (c: HTMLCanvasElement, srgb = true): Texture => { const t = new CanvasTexture(c); if (srgb) t.colorSpace = SRGBColorSpace; t.needsUpdate = true; return t; };

/** Soft radial dot, used for glow, sparks, exhaust and fire. */
export function radialTex(stops: [number, string][], size = 128): Texture {
  const c = cnv(size, size), g = c.getContext("2d")!, r = size / 2;
  const gr = g.createRadialGradient(r, r, 0, r, r, r);
  for (const [o, col] of stops) gr.addColorStop(o, col);
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  return tex(c);
}

/** Billowy fire / smoke puff: lumpy radial blob so a cluster reads as a volume, not a disc. */
export function puffTex(seed: number, size = 128): Texture {
  const c = cnv(size, size), g = c.getContext("2d")!, r = size / 2;
  let s = seed * 9301 + 49297; const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 9; i++) {
    const a = rnd() * Math.PI * 2, d = rnd() * r * 0.32, rr = r * (0.38 + rnd() * 0.3), x = r + Math.cos(a) * d, y = r + Math.sin(a) * d;
    const gr = g.createRadialGradient(x, y, 0, x, y, rr);
    gr.addColorStop(0, "rgba(255,255,255,0.55)"); gr.addColorStop(0.6, "rgba(255,255,255,0.22)"); gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr; g.fillRect(0, 0, size, size);
  }
  return tex(c);
}

/** Cumulus cloud: union of soft lobes, lit top, cooler shaded base. */
export function cloudTex(seed: number, w = 256, h = 150): Texture {
  const c = cnv(w, h), g = c.getContext("2d")!;
  let s = seed * 7919 + 104729; const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const lobes = 7 + Math.floor(rnd() * 5);
  for (let i = 0; i < lobes; i++) {
    const u = (i + 0.5) / lobes, x = w * (0.14 + 0.72 * u) + (rnd() - 0.5) * w * 0.08;
    const top = 1 - Math.abs(u - 0.5) * 1.6, rr = h * (0.2 + 0.2 * top + rnd() * 0.08), y = h * 0.66 - rr * 0.55 - top * h * 0.1;
    const gr = g.createRadialGradient(x, y, rr * 0.2, x, y, rr);
    gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.82, "rgba(250,252,255,0.92)"); gr.addColorStop(1, "rgba(240,245,255,0)");
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill();
  }
  // flat-ish soft base
  const bg = g.createLinearGradient(0, h * 0.5, 0, h * 0.8);
  bg.addColorStop(0, "rgba(255,255,255,0.0)"); bg.addColorStop(1, "rgba(255,255,255,0)");
  // shade: cooler, darker underside (source-atop keeps the silhouette)
  g.globalCompositeOperation = "source-atop";
  const sh = g.createLinearGradient(0, h * 0.15, 0, h * 0.8);
  sh.addColorStop(0, "rgba(255,255,255,0)"); sh.addColorStop(0.55, "rgba(190,200,228,0.25)"); sh.addColorStop(1, "rgba(120,130,170,0.55)");
  g.fillStyle = sh; g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = "source-over";
  return tex(c);
}

/** Flame cone gradient: v = 0 at the nozzle (white-hot) → 1 at the tip (transparent red). */
export function flameTex(core: boolean): Texture {
  const c = cnv(32, 256), g = c.getContext("2d")!;
  const gr = g.createLinearGradient(0, 0, 0, 256);
  if (core) {
    gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.25, "rgba(220,235,255,0.95)"); gr.addColorStop(0.6, "rgba(160,190,255,0.35)"); gr.addColorStop(1, "rgba(120,150,255,0)");
  } else {
    gr.addColorStop(0, "rgba(255,236,190,1)"); gr.addColorStop(0.12, "rgba(255,190,90,0.95)"); gr.addColorStop(0.4, "rgba(255,120,40,0.65)");
    gr.addColorStop(0.7, "rgba(200,55,25,0.28)"); gr.addColorStop(1, "rgba(120,20,10,0)");
  }
  g.fillStyle = gr; g.fillRect(0, 0, 32, 256);
  // soften the cone edges (u wraps around the cone, so fade in the middle of each side band)
  return tex(c);
}

/** Studio-style environment for the chrome: bright sky, hard horizon, dark ground and soft-box strips → the black/white
 *  chrome banding of the official rocket art. Tinted toward the tier's sky colour. */
export function envTex(sky: [number, number, number]): Texture {
  const w = 512, h = 256, c = cnv(w, h), g = c.getContext("2d")!;
  const [r, gg, b] = sky;
  const top = `rgb(${Math.round(150 + r * 0.4)},${Math.round(160 + gg * 0.4)},${Math.round(185 + b * 0.3)})`;
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, top); gr.addColorStop(0.42, "rgb(235,240,250)"); gr.addColorStop(0.5, "rgb(255,255,255)");
  gr.addColorStop(0.53, "rgb(70,74,86)"); gr.addColorStop(0.75, "rgb(120,124,136)"); gr.addColorStop(1, "rgb(40,42,50)");
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  // soft boxes: vertical bright strips and dark gaps, so the cylinder shows chrome bands as it rolls
  for (let i = 0; i < 7; i++) {
    const x = (i / 7) * w + 20, bw = 14 + (i % 3) * 10;
    g.fillStyle = i % 2 ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.65)";
    g.fillRect(x, h * 0.12, bw, h * 0.36);
    g.fillStyle = i % 2 ? "rgba(0,0,0,0.5)" : "rgba(255,255,255,0.7)";
    g.fillRect(x + w / 14, h * 0.58, bw, h * 0.3);
  }
  g.fillStyle = `rgba(${r},${gg},${b},0.35)`; g.fillRect(0, 0, w, h * 0.5);
  const t = tex(c); t.mapping = EquirectangularReflectionMapping; return t;
}
