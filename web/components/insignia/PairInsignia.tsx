"use client";
/**
 * PairInsignia — head-to-head "WITH" matchup card: coin art on the left, base pair on the right,
 * meeting on a jagged gold seam with a beveled WITH wordmark in the centre (fighting-game select
 * screen, Disciple palette). Name plates sit below the art and are length-fitted so they never clip.
 *
 * Pure SVG + memo. Only async work: one dominant-colour probe per unique image URL, cached module-wide.
 */
import { memo, useEffect, useId, useState } from "react";
import { PairMark, pairInfo } from "./pairs";

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export const hsl = (h: number, s: number, l: number) => `hsl(${((h % 360) + 360) % 360} ${s}% ${l}%)`;

export type Emblem = { hue: number; hi: string; mid: string; lo: string; mono: string; angle: number };
const EMBLEMS = new Map<string, Emblem>();
/** Deterministic metallic monogram field from id + ticker (fallback when a coin has no image). */
export function emblemFor(key: string, sym: string): Emblem {
  const k = key + "|" + sym;
  let e = EMBLEMS.get(k);
  if (!e) {
    const h = hash(k);
    const hue = h % 360;
    const clean = sym.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    e = { hue, hi: hsl(hue, 45, 72), mid: hsl(hue, 55, 38), lo: hsl(hue + 20, 60, 12), mono: clean.slice(0, clean.length <= 3 ? 3 : 2) || "?", angle: 20 + ((h >>> 8) % 50) };
    EMBLEMS.set(k, e);
  }
  return e;
}

// ---------- dominant colour (cached per URL) ----------
const DOM = new Map<string, string | null>();
const DOM_WAIT = new Map<string, Promise<string | null>>();
function probe(url: string): Promise<string | null> {
  let p = DOM_WAIT.get(url);
  if (p) return p;
  p = new Promise((res) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const c = document.createElement("canvas"); c.width = c.height = 16;
        const g = c.getContext("2d")!; g.drawImage(img, 0, 0, 16, 16);
        const d = g.getImageData(0, 0, 16, 16).data;
        let r = 0, gg = 0, b = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 128) continue;
          const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
          const w = 1 + (mx - mn) / 32;
          r += d[i] * w; gg += d[i + 1] * w; b += d[i + 2] * w; n += w;
        }
        res(n ? `rgb(${(r / n) | 0} ${(gg / n) | 0} ${(b / n) | 0})` : null);
      } catch { res(null); }
    };
    img.onerror = () => res(null);
    img.src = url;
  });
  p.then((v) => DOM.set(url, v));
  DOM_WAIT.set(url, p);
  return p;
}
export function useDominant(url?: string | null): string | null {
  const [c, setC] = useState<string | null>(() => (url ? DOM.get(url) ?? null : null));
  useEffect(() => {
    if (!url) { setC(null); return; }
    if (DOM.has(url)) { setC(DOM.get(url)!); return; }
    let alive = true;
    probe(url).then((v) => { if (alive) setC(v); });
    return () => { alive = false; };
  }, [url]);
  return c;
}

// ---------- geometry ----------
const W = 160, H = 100;
// Diagonal seam from (96,0) to (64,100) with a jagged lightning edge.
const SEAM: [number, number][] = [[96, 0], [88, 18], [95, 22], [82, 44], [90, 48], [75, 72], [82, 75], [64, 100]];
const seamPts = SEAM.map(([x, y]) => `${x},${y}`).join(" ");
const LEFT = `0,0 ${seamPts} 0,100`;
const RIGHT = `${W},0 ${seamPts} ${W},100`;
const VS_FONT = "var(--font-vs), 'Anton', 'Arial Narrow', Impact, sans-serif";

/** Original portrait-style silhouette (no real likeness): head + shoulders in a suit, glinting eyes. */
function Portrait({ x, y, w, h, em }: { x: number; y: number; w: number; h: number; em: Emblem }) {
  const s = Math.min(w, h) / 100;
  return (
    <g transform={`translate(${x + w / 2 - 50 * s} ${y + h - 100 * s}) scale(${s})`}>
      <path d="M50 18c13 0 21 10 21 24 0 9-4 17-9 21l2 7c14 3 26 10 30 30H6c4-20 16-27 30-30l2-7c-5-4-9-12-9-21 0-14 8-24 21-24Z" fill="#05060f" opacity=".92" />
      <path d="M38 70l12 30 12-30-12 6Z" fill={em.hi} opacity=".55" />
      <path d="M38 44h9M53 44h9" stroke="#ffcf6a" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M38 44h9M53 44h9" stroke="#fff6d8" strokeWidth=".9" strokeLinecap="round" />
    </g>
  );
}

/** Coin side: image if any, else a brushed-metal monogram field. */
function CoinField({ uid, image, em, portrait, x, y, w, h, monoX }: { uid: string; image?: string | null; em: Emblem; portrait?: boolean; x: number; y: number; w: number; h: number; monoX: number }) {
  if (image) return <><rect x={x} y={y} width={w} height={h} fill={em.lo} /><image href={image} x={x} y={y} width={w} height={h} preserveAspectRatio="xMidYMid slice" /></>;
  const fs = em.mono.length > 2 ? h * 0.3 : h * 0.4;
  return (
    <>
      <rect x={x} y={y} width={w} height={h} fill={`url(#m${uid})`} />
      <rect x={x} y={y} width={w} height={h} fill={`url(#b${uid})`} opacity=".35" />
      {portrait
        ? <Portrait x={x} y={y + h * 0.1} w={w * 0.7} h={h * 0.9} em={em} />
        : <text x={monoX} y={y + h * 0.5 + fs * 0.36} textAnchor="middle" fontFamily={VS_FONT} fontSize={fs} fontStyle="italic"
            fill={`url(#c${uid})`} stroke="#05060f" strokeWidth={h * 0.012} paintOrder="stroke">{em.mono}</text>}
    </>
  );
}

function Defs({ uid, em, coinCol, pc, pc2 }: { uid: string; em: Emblem; coinCol: string; pc: string; pc2: string }) {
  return (
    <defs>
      <linearGradient id={`m${uid}`} gradientTransform={`rotate(${em.angle} .5 .5)`}>
        <stop offset="0" stopColor={em.lo} /><stop offset=".45" stopColor={em.mid} /><stop offset=".55" stopColor={em.hi} /><stop offset="1" stopColor={em.lo} />
      </linearGradient>
      <pattern id={`b${uid}`} width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(-25)">
        <rect width="3" height="1" fill="#fff" opacity=".18" />
      </pattern>
      <linearGradient id={`c${uid}`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#ffffff" /><stop offset=".48" stopColor="#c9d2e6" /><stop offset=".52" stopColor="#7d879e" /><stop offset="1" stopColor="#eef2fb" />
      </linearGradient>
      <linearGradient id={`g${uid}`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#fff7d6" /><stop offset=".42" stopColor="#ffd25e" /><stop offset=".55" stopColor="#c98a1c" /><stop offset="1" stopColor="#ffe08a" />
      </linearGradient>
      <linearGradient id={`lt${uid}`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor={coinCol} stopOpacity=".55" /><stop offset="1" stopColor={coinCol} stopOpacity="0" /></linearGradient>
      <linearGradient id={`rt${uid}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={pc} /><stop offset="1" stopColor={pc2} /></linearGradient>
      <radialGradient id={`v${uid}`} cx=".5" cy=".5" r=".75"><stop offset=".55" stopColor="#000" stopOpacity="0" /><stop offset="1" stopColor="#02030a" stopOpacity=".75" /></radialGradient>
      <clipPath id={`L${uid}`}><polygon points={LEFT} /></clipPath>
      <clipPath id={`R${uid}`}><polygon points={RIGHT} /></clipPath>
      <filter id={`gl${uid}`} x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.6" /></filter>
    </defs>
  );
}

/** Speed lines radiating from the seam centre. */
const SPEED = Array.from({ length: 14 }, (_, i) => {
  const a = (i / 14) * Math.PI * 2 + 0.2;
  const r1 = 30 + (i % 3) * 6, r2 = 120;
  return `M${80 + Math.cos(a) * r1} ${50 + Math.sin(a) * r1 * 0.7}L${80 + Math.cos(a) * r2} ${50 + Math.sin(a) * r2 * 0.7}`;
}).join("");

/** Fit a name plate inside `max` user units: shrink font first, then squeeze glyphs; never clip. */
function Plate({ x, y, text, max, anchor, size, fill }: { x: number; y: number; text: string; max: number; anchor: "start" | "middle" | "end"; size: number; fill: string }) {
  const t = text.length > 10 ? text.slice(0, 9) + "…" : text;
  const est = (fs: number) => t.length * fs * 0.52; // Anton ≈ 0.5em per cap
  const fs = Math.max(size * 0.6, Math.min(size, max / (t.length * 0.52)));
  // Always pin the rendered width (≤ max) so a wider-than-estimated fallback font can never overflow.
  return (
    <text x={x} y={y} textAnchor={anchor} fontFamily={VS_FONT} fontSize={fs} fill={fill}
      textLength={Math.min(max, est(fs))} lengthAdjust="spacingAndGlyphs">{t}</text>
  );
}

type Props = {
  id: string;
  sym: string;
  image?: string | null;
  pairSym?: string;
  /** "crest" = full WITH matchup card; "badge" = compact diagonal split tile (rows, rails). */
  variant?: "crest" | "badge";
  /** Use the original portrait silhouette instead of a monogram (no-image coins only). */
  portrait?: boolean;
  /** Hide the name plates under the card (e.g. when the caller renders its own). */
  plates?: boolean;
  size?: number;
  className?: string;
  title?: string;
};

function PairInsigniaImpl({ id, sym, image, pairSym = "STRATEGY", variant = "crest", portrait, plates = true, size = 160, className, title }: Props) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const em = emblemFor(id, sym);
  const dom = useDominant(image);
  const pi = pairInfo(pairSym);
  const coinCol = dom ?? em.mid;
  const label = title ?? `$${sym} with ${pi.label}`;

  if (variant === "badge") {
    return (
      <svg width={size} height={size} viewBox="0 0 40 40" className={className} role="img" aria-label={label}>
        <defs>
          <clipPath id={`k${uid}`}><rect x="1" y="1" width="38" height="38" rx="8" /></clipPath>
          <clipPath id={`L${uid}`}><polygon points="0,0 26,0 14,40 0,40" /></clipPath>
          <linearGradient id={`m${uid}`} gradientTransform={`rotate(${em.angle} .5 .5)`}><stop offset="0" stopColor={em.lo} /><stop offset=".5" stopColor={em.hi} /><stop offset="1" stopColor={em.lo} /></linearGradient>
          <linearGradient id={`b${uid}`}><stop stopColor="#000" stopOpacity="0" /></linearGradient>
          <linearGradient id={`c${uid}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" /><stop offset="1" stopColor="#c9d2e6" /></linearGradient>
        </defs>
        <g clipPath={`url(#k${uid})`}>
          <rect width="40" height="40" fill={pi.color} />
          <rect width="40" height="40" fill="#000" opacity=".18" />
          <g transform="translate(23 11)"><PairMark sym={pairSym} size={15} bare /></g>
          <g clipPath={`url(#L${uid})`}><CoinField uid={uid} image={image} em={em} portrait={portrait} x={0} y={0} w={28} h={40} monoX={11} /></g>
          <path d="M26 0L14 40" stroke="#ffd25e" strokeWidth="1.6" />
        </g>
        <rect x="1" y="1" width="38" height="38" rx="8" fill="none" stroke="#ffe7a3" strokeOpacity=".55" strokeWidth="1" />
        <circle cx="20" cy="20" r="5" fill="#0b0f22" stroke="#ffd25e" strokeWidth="1.2" />
        <path d="M20 17.2v5.6M17.2 20h5.6" stroke="#ffd25e" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }

  const ph = plates ? 22 : 0;
  return (
    <svg width={size} height={(size * (H + ph)) / W} viewBox={`0 0 ${W} ${H + ph}`} className={className} role="img" aria-label={label}>
      <Defs uid={uid} em={em} coinCol={coinCol} pc={pi.color} pc2={pi.color2} />
      <rect width={W} height={H} rx="6" fill="#070a1a" />
      {/* coin half */}
      <g clipPath={`url(#L${uid})`}>
        <CoinField uid={uid} image={image} em={em} portrait={portrait} x={0} y={0} w={100} h={H} monoX={27} />
        <rect width="100" height={H} fill={`url(#lt${uid})`} style={{ mixBlendMode: "overlay" }} />
      </g>
      {/* pair half */}
      <g clipPath={`url(#R${uid})`}>
        <rect x="60" width="100" height={H} fill={`url(#rt${uid})`} />
        <g transform="translate(106 24) rotate(-8 26 26)" opacity=".98"><PairMark sym={pairSym} size={52} bare /></g>
      </g>
      <path d={SPEED} stroke="#fff" strokeOpacity=".09" strokeWidth=".8" />
      <rect width={W} height={H} fill={`url(#v${uid})`} />
      {/* seam */}
      <polyline points={seamPts} fill="none" stroke="#ffb627" strokeWidth="4" opacity=".7" filter={`url(#gl${uid})`} />
      <polyline points={seamPts} fill="none" stroke={`url(#g${uid})`} strokeWidth="1.8" strokeLinejoin="miter" />
      <polyline points={seamPts} fill="none" stroke="#fffbe8" strokeWidth=".5" />
      {/* WITH wordmark: shadow, dark rim, gold face, highlight */}
      <g transform="translate(80 57) skewX(-10)" fontFamily={VS_FONT} fontSize="21" textAnchor="middle" letterSpacing="-.2">
        <text x="1.4" y="2.2" fill="#000" opacity=".6">WITH</text>
        <text x="0" y="0" fill="none" stroke="#2a1604" strokeWidth="3.4" strokeLinejoin="round">WITH</text>
        <text x="0" y="0" fill={`url(#g${uid})`} stroke="#fff3c4" strokeWidth=".5">WITH</text>
      </g>
      <rect x=".5" y=".5" width={W - 1} height={H - 1} rx="6" fill="none" stroke="#ffe7a3" strokeOpacity=".35" />
      {plates && (
        <g>
          <Plate x={4} y={H + 17} text={sym.toUpperCase()} max={60} anchor="start" size={15} fill="#f4f6ff" />
          <text x={80} y={H + 15} textAnchor="middle" fontFamily={VS_FONT} fontSize="7" fill="#ffd25e" letterSpacing="1">WITH</text>
          <Plate x={W - 4} y={H + 17} text={pi.label} max={60} anchor="end" size={15} fill={pi.color} />
        </g>
      )}
    </svg>
  );
}

const PairInsignia = memo(PairInsigniaImpl);
export default PairInsignia;
