"use client";

import { useEffect, useRef, useState } from "react";
import { skinnedRocket } from "@/lib/rocketSkin";
import { withBase } from "@/lib/base-path";

/**
 * The player's real loadout (body skin + nose coin via lib/rocketSkin, hi-res master sprite) lit for the
 * hangar: one hard overhead key (brighter toward the lamp, deep mids, top-facing speculars), a faint cool
 * rim from the shut bay door and the thruster colour wrapping the tail. Port of the approved mock's
 * hangar.py rocket shading. Also paints the wet-floor reflection canvas from the same pixels.
 */
const sm = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const hex = (h: string): [number, number, number] => {
  const m = h.replace("#", "");
  const v = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  return [parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255];
};

export function hangarLight(flame: string) {
  const gc = hex(flame);
  return (c: HTMLCanvasElement) => {
    const w = c.width, h = c.height;
    const g = c.getContext("2d", { willReadFrequently: true });
    if (!g || !w || !h) return;
    let im: ImageData;
    try { im = g.getImageData(0, 0, w, h); } catch { return; }
    const d = im.data;
    const A = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) A[i] = d[i * 4 + 3] / 255;
    // 5px erosion (separable min) → silhouette edge for the rim
    const er = new Float32Array(w * h), tmp = new Float32Array(w * h);
    const R = Math.max(2, Math.round(w / 110));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 1; for (let k = -R; k <= R; k++) { const xx = x + k; m = Math.min(m, xx < 0 || xx >= w ? 0 : A[y * w + xx]); } tmp[y * w + x] = m; }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 1; for (let k = -R; k <= R; k++) { const yy = y + k; m = Math.min(m, yy < 0 || yy >= h ? 0 : tmp[yy * w + x]); } er[y * w + x] = m; }
    const S = Math.max(3, Math.round(h / 300)); // facing-edge probe distance
    const cx0 = w >> 1;
    for (let y = 0; y < h; y++) {
      // body run through the centre column → cylindrical coordinate u
      let l = cx0, r = cx0;
      if (A[y * w + cx0] > 0.5) { while (l > 0 && A[y * w + l - 1] > 0.5) l--; while (r < w - 1 && A[y * w + r + 1] > 0.5) r++; }
      else { l = 0; r = w - 1; }
      const c = (l + r) / 2, hw = Math.max((r - l) / 2, 1);
      const ry = y / h;
      const key = Math.pow(Math.max(0, 1.3 - 0.85 * ry), 1.3);
      const under0 = Math.exp(-(1 - ry) / 0.08) * 0.8;
      const rimY = 0.4 + 0.6 * (1 - ry);
      for (let x = 0; x < w; x++) {
        const i = y * w + x, a = A[i];
        if (a <= 0) continue;
        let R0 = d[i * 4] / 255, G0 = d[i * 4 + 1] / 255, B0 = d[i * 4 + 2] / 255;
        const L0 = 0.3 * R0 + 0.59 * G0 + 0.11 * B0;
        const f = (0.22 + Math.pow(L0, 2.2)) * key;
        R0 *= f; G0 *= f; B0 *= f;
        const Lm = 0.3 * R0 + 0.59 * G0 + 0.11 * B0;
        R0 = R0 * 0.82 + Lm * 0.18; G0 = G0 * 0.82 + Lm * 0.18; B0 = B0 * 0.82 + Lm * 0.18;
        const u = Math.min(1.6, Math.abs((x - c) / hw));
        const up = Math.max(0, a - (y >= S ? A[i - S * w] : 0));
        const dn = Math.max(0, a - (y + S < h ? A[i + S * w] : 0));
        // key-light speculars: top-facing edges, nose cap, already-bright chrome near the lamp
        const spec = Math.min(1, (up * 1.8 + Math.exp(-((ry / 0.06) ** 2)) * (1 - sm(0, 0.7, u)) * 0.9 + sm(0.88, 1, L0) * (1 - ry) * 0.6)) * a;
        R0 = 1 - (1 - R0) * (1 - spec); G0 = 1 - (1 - G0) * (1 - 0.95 * spec); B0 = 1 - (1 - B0) * (1 - 0.85 * spec);
        // faint cool rim (bay door shut)
        const rim = Math.min(1, Math.max(sm(0.6, 1, u) * 0.6, a - er[i]) * 0.35) * a * rimY;
        R0 = 1 - (1 - R0) * (1 - 0.42 * rim); G0 = 1 - (1 - G0) * (1 - 0.54 * rim); B0 = 1 - (1 - B0) * (1 - 0.78 * rim);
        // thruster glow wrapping the tail + fin undersides
        const und = Math.min(1, under0 + dn * Math.exp(-(1 - ry) / 0.25) * 0.9) * a * 0.75 * 0.8;
        R0 = 1 - (1 - R0) * (1 - gc[0] * und); G0 = 1 - (1 - G0) * (1 - gc[1] * und); B0 = 1 - (1 - B0) * (1 - gc[2] * und);
        d[i * 4] = R0 * 255; d[i * 4 + 1] = G0 * 255; d[i * 4 + 2] = B0 * 255;
      }
    }
    g.putImageData(im, 0, 0);
  };
}

export default function HangarRocket({ skin, coin, flame, className, reflClassName }: { skin: string; coin: string; flame: string; className?: string; reflClassName?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const refl = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    skinnedRocket(skin, coin, { hi: true, light: hangarLight(flame) }).then((cv) => {
      if (!alive) return;
      for (const c of [ref.current, refl.current]) {
        if (!c) continue;
        c.width = cv.width; c.height = cv.height;
        const g = c.getContext("2d")!;
        g.clearRect(0, 0, c.width, c.height);
        g.drawImage(cv, 0, 0);
      }
      setReady(true);
    }).catch(() => {});
    return () => { alive = false; };
  }, [skin, coin, flame]);
  return (
    <>
      <span className={reflClassName} aria-hidden><canvas ref={refl} /></span>
      <span className={className}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {!ready && <img src={withBase("/assets/rocket-hi.webp")} alt="" />}
        <canvas ref={ref} aria-label={`${skin} rocket`} style={{ opacity: ready ? 1 : 0 }} />
      </span>
    </>
  );
}
