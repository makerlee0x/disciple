/** Procedural canvas textures for the 3D flight view (built once, no image downloads). */
import {
  CanvasTexture, SRGBColorSpace, EquirectangularReflectionMapping, DataTexture, RGBAFormat, HalfFloatType, LinearFilter,
  LinearSRGBColorSpace, NoColorSpace, RepeatWrapping, DataUtils, type Texture,
} from "three";

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

// ---- tiny value-noise fbm for the procedural textures (seeded, no deps)
function noise2(seed: number) {
  const P = new Uint8Array(512); let s = (seed * 2654435761) >>> 0;
  for (let i = 0; i < 256; i++) P[i] = i;
  for (let i = 255; i > 0; i--) { s = (s * 1664525 + 1013904223) >>> 0; const j = s % (i + 1); const t = P[i]; P[i] = P[j]; P[j] = t; }
  for (let i = 0; i < 256; i++) P[i + 256] = P[i];
  const f = (t: number) => t * t * (3 - 2 * t);
  const n = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, X = xi & 255, Y = yi & 255;
    const a = P[P[X] + Y] / 255, b = P[P[X + 1] + Y] / 255, c = P[P[X] + Y + 1] / 255, d = P[P[X + 1] + Y + 1] / 255;
    const u = f(xf), v = f(yf);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  return (x: number, y: number, oct = 4) => { let v = 0, amp = 0.5, fr = 1, tot = 0; for (let o = 0; o < oct; o++) { v += amp * n(x * fr, y * fr); tot += amp; amp *= 0.5; fr *= 2.03; } return v / tot; };
}

/** Cumulus cloud: lobed density field with fbm-eroded edges, lit from above (moonlit tops, cool dark bases). */
export function cloudTex(seed: number, w = 256, h = 160): Texture {
  const c = cnv(w, h), g = c.getContext("2d")!, img = g.createImageData(w, h), d = img.data;
  let s = seed * 7919 + 104729; const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const nz = noise2(seed * 31 + 7);
  const lobes: [number, number, number][] = [];
  const nl = 6 + Math.floor(rnd() * 4);
  for (let i = 0; i < nl; i++) {
    const u = (i + 0.5) / nl, top = 1 - Math.abs(u - 0.5) * 1.7;
    const r = 0.16 + 0.17 * top + rnd() * 0.06;
    lobes.push([0.12 + 0.76 * u + (rnd() - 0.5) * 0.06, 0.7 - r * 0.75 - top * 0.12, r]);
  }
  const dens = (x: number, y: number) => {
    let v = 0;
    for (const [lx, ly, r] of lobes) { const dx = (x - lx) / r, dy = (y - ly) / (r * 1.25); const q = 1 - (dx * dx + dy * dy); if (q > v) v = q; }
    v *= 1 - Math.max(0, (y - 0.72) / 0.1);                    // flat-ish base
    return v + (nz(x * 6, y * 6, 4) - 0.5) * 0.5 * Math.min(1, Math.max(0, v + 0.15) * 2.5);
  };
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const x = i / w, y = j / h * (h / w) * 1.6, k = (j * w + i) * 4;
    const edge = Math.min(1, i / (w * 0.06), (w - 1 - i) / (w * 0.06), j / (h * 0.08), (h - 1 - j) / (h * 0.08));
    const v = dens(x, y), a = Math.max(0, Math.min(1, (v - 0.1) / 0.25)) * Math.max(0, edge);
    if (a <= 0) { d[k + 3] = 0; continue; }
    // light from above: how much cloud sits above this pixel (cheap self-shadow) + height in the cloud
    const up = dens(x - 0.015, y - 0.05), lit = Math.max(0, Math.min(1, 1 - up * 0.9)) * 0.55 + (1 - j / h) * 0.45;
    const L = 0.34 + 0.66 * lit, detail = 0.94 + 0.12 * nz(x * 14 + 3, y * 14, 2);
    d[k] = Math.min(255, 255 * L * 0.94 * detail); d[k + 1] = Math.min(255, 255 * L * 0.93 * detail); d[k + 2] = Math.min(255, 255 * (0.12 + L * 0.9) * detail);
    d[k + 3] = 255 * a * (0.55 + 0.45 * Math.min(1, v * 2));
  }
  g.putImageData(img, 0, 0);
  return tex(c);
}

/** Soft streak for hyperspeed (a long blurred dash, bright head). */
export function streakTex(): Texture {
  const c = cnv(32, 256), g = c.getContext("2d")!, img = g.createImageData(32, 256), d = img.data;
  for (let j = 0; j < 256; j++) for (let i = 0; i < 32; i++) {
    const v = j / 255, x = (i - 15.5) / 16, k = (j * 32 + i) * 4;
    const along = Math.pow(Math.sin(Math.PI * Math.min(1, v * 1.05)), 0.8) * (0.35 + 0.65 * v), across = Math.exp(-x * x * 6);
    const a = along * across; d[k] = d[k + 1] = d[k + 2] = 255; d[k + 3] = 255 * a;
  }
  g.putImageData(img, 0, 0); return tex(c);
}

/** Flame card (camera-facing): teardrop with soft edges. v = 0 at the nozzle (top of the canvas) → tip. */
export function flameTex(core: boolean): Texture {
  const W = 64, H = 256, c = cnv(W, H), g = c.getContext("2d")!, img = g.createImageData(W, H), d = img.data;
  const nz = noise2(core ? 5 : 9);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const v = j / (H - 1), x = (i - (W - 1) / 2) / ((W - 1) / 2), k = (j * W + i) * 4;
    // width profile: full at the nozzle, swelling slightly, then tapering to the tip
    const wv = (core ? 0.55 : 0.92) * Math.pow(1 - v, core ? 1.1 : 0.7) * (0.85 + 0.35 * Math.sin(Math.min(1, v * 3) * Math.PI / 2));
    const e = Math.abs(x) / Math.max(0.02, wv), edge = Math.max(0, 1 - e * e);
    const turb = core ? 1 : 0.75 + 0.5 * nz(x * 3, v * 14, 3);
    const a = Math.pow(edge, core ? 0.7 : 1.3) * Math.pow(1 - v, core ? 1.6 : 1.2) * turb;
    let r: number, gg: number, b: number;
    if (core) { r = 1; gg = 0.95 - 0.25 * v; b = 0.85 - 0.6 * v; }
    else { r = 1; gg = Math.max(0.18, 0.78 - 0.9 * v); b = Math.max(0.05, 0.42 - 0.8 * v); }
    d[k] = 255 * r; d[k + 1] = 255 * gg; d[k + 2] = 255 * b; d[k + 3] = 255 * Math.min(1, a);
  }
  g.putImageData(img, 0, 0); return tex(c);
}

/** Fine vertical flutes for the lower hull (normal map; u wraps round the lathe, v runs along it). */
export function fluteNormalTex(): Texture {
  const W = 256, H = 8, data = new Uint8Array(W * H * 4), N = 28;
  for (let i = 0; i < W; i++) {
    const ph = (i / W) * N * Math.PI * 2, nx = Math.sin(ph) * 0.35;
    const nzv = Math.sqrt(1 - nx * nx);
    for (let j = 0; j < H; j++) { const k = (j * W + i) * 4; data[k] = (nx * 0.5 + 0.5) * 255; data[k + 1] = 128; data[k + 2] = nzv * 255; data[k + 3] = 255; }
  }
  const t = new DataTexture(data, W, H, RGBAFormat); t.wrapS = t.wrapT = RepeatWrapping; t.colorSpace = NoColorSpace;
  t.magFilter = LinearFilter; t.minFilter = LinearFilter; t.needsUpdate = true; return t;
}

/**
 * HDR environment for the chrome (the three.js "sky → PMREM → scene.environment" path, built procedurally so it is
 * identical on WebGPU and WebGL and costs no download). Equirect, half-float, linear:
 *  - night sky: deep zenith → lavender glow at the horizon (tinted by the tier sky colour), a hot moon/sun disc;
 *  - tall soft-box panels with near-black gaps around the horizon → the hard black / white vertical banding of the
 *    official chrome rocket art as the hull rolls;
 *  - a razor-bright horizon line over a dark ground with warm city-light speckle.
 * PMREM-filtered by the renderer's PMREMGenerator before it is set as scene.environment.
 */
export function envHDR(sky: [number, number, number], w = 512, h = 256): DataTexture {
  const [sr, sg, sb] = sky.map((v) => v / 255) as [number, number, number];
  const data = new Uint16Array(w * h * 4), H16 = DataUtils.toHalfFloat;
  const nz = noise2(17);
  // soft-box panels: [azimuth u centre, half width u, gain, top elev, bottom elev]   (u = .75 faces the camera)
  const boxes: [number, number, number, number, number][] = [
    [0.81, 0.03, 3.4, 0.6, -0.12], [0.6, 0.022, 2.4, 0.7, -0.1], [0.27, 0.035, 2.8, 0.6, -0.1], [0.04, 0.018, 3.2, 0.55, -0.1],
  ];
  const sun = { u: 0.68, el: 0.62, r: 0.03, gain: 30 };
  for (let j = 0; j < h; j++) {
    const el = ((j + 0.5) / h) * Math.PI - Math.PI / 2;            // row 0 = straight down
    const sy = Math.sin(el);
    for (let i = 0; i < w; i++) {
      const u = (i + 0.5) / w, k = (j * w + i) * 4;
      let r: number, g: number, b: number;
      if (sy >= 0) {
        // sky: zenith navy → violet → bright lavender at the horizon
        const t = Math.pow(1 - sy, 3.2);
        r = 0.008 + 0.02 * sr + t * (0.05 + 0.05 * sr); g = 0.01 + 0.02 * sg + t * (0.045 + 0.04 * sg); b = 0.03 + 0.04 * sb + t * (0.1 + 0.06 * sb);
        // a broad brighter sky dome higher up (what the nose cone and shoulders pick up)
        const dome = Math.exp(-Math.pow((sy - 0.55) / 0.22, 2)) * 0.9; r += dome * 0.55; g += dome * 0.55; b += dome * 0.8;
        // dark sectors between the panels (chrome needs blacks)
        const dark = 0.03 + 0.97 * Math.pow(0.5 + 0.5 * Math.cos(u * Math.PI * 2 * 3 + 0.6), 3);
        r *= dark; g *= dark; b *= dark;
        // clouds near the horizon
        const cl = Math.max(0, nz(u * 18, sy * 7, 4) - 0.52) * 2.2 * Math.max(0, 1 - sy / 0.35);
        r += cl * 0.22; g += cl * 0.2; b += cl * 0.3;
      } else {
        // ground: very dark, with a warm city glow band and speckles of light
        const t = Math.pow(1 + sy, 8);
        r = 0.004 + t * 0.05; g = 0.004 + t * 0.035; b = 0.008 + t * 0.05;
        const sp = nz(u * 220, sy * 90, 2); if (sp > 0.8 && sy > -0.5) { const q = (sp - 0.8) * 25 * (1 + sy * 1.4); r += q * 1.0; g += q * 0.7; b += q * 0.35; }
      }
      // no bright line AT the horizon: the camera is level with the rocket, so the whole hull reflects the band within
      // a few degrees of it — that band stays dark (with the panels' vertical streaks); thin rim lines sit above / below
      const hz = (Math.exp(-Math.pow((sy - 0.2) / 0.012, 2)) * 1.2 + Math.exp(-Math.pow((sy + 0.18) / 0.01, 2)) * 0.6) - 0.0;
      r += hz * 0.95; g += hz * 0.92; b += hz;
      // soft boxes (bright vertical panels, soft edges)
      for (const [cu, hw, gain, top, bot] of boxes) {
        let du = Math.abs(u - cu); if (du > 0.5) du = 1 - du;
        if (du < hw * 1.6 && sy < top && sy > bot) {
          const e = Math.max(0, Math.min(1, (hw * 1.6 - du) / (hw * 0.6))) * Math.max(0, Math.min(1, (top - sy) / 0.06)) * Math.max(0, Math.min(1, (sy - bot) / 0.04));
          r += e * gain * 0.95; g += e * gain * 0.97; b += e * gain;
        }
      }
      // moon / key light disc + halo
      let du = Math.abs(u - sun.u); if (du > 0.5) du = 1 - du;
      const dd = Math.hypot(du * 2 * Math.cos(el), el / Math.PI - sun.el / Math.PI);
      if (dd < sun.r * 6) { const core = dd < sun.r ? sun.gain : 0, halo = Math.exp(-dd / (sun.r * 1.5)) * 1.2; r += core + halo; g += core + halo * 0.95; b += core * 0.95 + halo * 0.9; }
      data[k] = H16(r); data[k + 1] = H16(g); data[k + 2] = H16(b); data[k + 3] = H16(1);
    }
  }
  const t = new DataTexture(data, w, h, RGBAFormat, HalfFloatType);
  t.mapping = EquirectangularReflectionMapping; t.colorSpace = LinearSRGBColorSpace;
  t.magFilter = LinearFilter; t.minFilter = LinearFilter; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}
