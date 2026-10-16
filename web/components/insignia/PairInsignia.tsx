"use client";
/**
 * PairInsignia — squadron-style crest for a Disciple rocket: the coin's shield and its base pair's
 * shield joined under a gold halo ("two shields joining forces"). Original heraldry in the Disciple
 * theme (navy / gold / chrome / halo) — no national or military markings.
 *
 * Pure SVG + memo: no per-row canvas work. The only async step is a dominant-colour probe per unique
 * image URL (cached module-wide, so 600 rows sharing a handful of icons cost a handful of probes).
 */
import { memo, useEffect, useId, useState } from "react";
import { PairMark, pairInfo } from "./pairs";

// ---------- deterministic helpers ----------
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export const hsl = (h: number, s: number, l: number) => `hsl(${h % 360} ${s}% ${l}%)`;

/** Original glyphs (24×24 viewBox) for generated emblems — Disciple/halo motifs, no military marks. */
const GLYPHS: string[] = [
  "M12 3c3 0 5 2 5 4.5S15 12 12 12 7 10 7 7.5 9 3 12 3Zm-8 16c2-4 5-6 8-6s6 2 8 6Z", // cherub bust
  "M2 12c4-1 7-4 10-9 3 5 6 8 10 9-4 1-7 4-10 9-3-5-6-8-10-9Z", // star
  "M12 2c2 4 6 6 6 11a6 6 0 0 1-12 0c0-3 2-4 3-7 1 2 2 3 3 3 0-3-1-5 0-7Z", // flame
  "M3 8l4 3 5-7 5 7 4-3-2 11H5Z", // crown
  "M15 3a9 9 0 1 0 6 15A8 8 0 0 1 15 3Z", // crescent
  "M2 14c3-6 7-9 10-9s7 3 10 9c-4-2-7-3-10-3S6 12 2 14Zm10 0a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z", // wings + orb
  "M12 2l3 7h7l-6 4 2 8-6-5-6 5 2-8-6-4h7Z", // gilded star
  "M5 20V9l7-6 7 6v11h-4v-6h-6v6Z", // chapel
  "M12 4c4 0 8 3 8 8s-4 8-8 8-8-3-8-8 4-8 8-8Zm0 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z", // ring
  "M4 18c2-6 5-11 8-14 3 3 6 8 8 14-3-2-5-3-8-3s-5 1-8 3Z", // rocket nose
  "M6 4h12l-2 7h-8Zm3 8h6l-1 8h-4Z", // chalice
  "M12 3l2 5 5 1-4 3 1 5-4-3-4 3 1-5-4-3 5-1Z", // small star
];

export type Emblem = { bg: string; bg2: string; fg: string; glyph: string; mono: string; hue: number };
const EMBLEMS = new Map<string, Emblem>();
/** Deterministic generated emblem from ticker/address — so SAMPLE coins without art stay distinct. */
export function emblemFor(key: string, sym: string): Emblem {
  const k = key + "|" + sym;
  let e = EMBLEMS.get(k);
  if (!e) {
    const h = hash(k);
    const hue = h % 360;
    e = { hue, bg: hsl(hue, 62, 46), bg2: hsl(hue + 40, 58, 26), fg: hsl(hue + 180, 30, 96), glyph: GLYPHS[(h >>> 9) % GLYPHS.length], mono: sym.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?" };
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
          const w = 1 + (mx - mn) / 32; // favour saturated pixels
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

// ---------- pieces ----------
const SHIELD = "M4 4h40v22c0 13-9 21-20 26C13 47 4 39 4 26Z"; // 48×56 heater shield

/** The coin's own field: image if any, else generated emblem. Drawn into a clip defined by caller. */
function CoinField({ image, em, x, y, w, h }: { image?: string | null; em: Emblem; x: number; y: number; w: number; h: number }) {
  return image ? (
    <>
      <rect x={x} y={y} width={w} height={h} fill={em.bg2} />
      <image href={image} x={x} y={y} width={w} height={h} preserveAspectRatio="xMidYMid slice" />
    </>
  ) : (
    <>
      <rect x={x} y={y} width={w} height={h} fill={em.bg} />
      <path d={`M${x} ${y + h * 0.55}L${x + w} ${y + h * 0.2}V${y + h}H${x}Z`} fill={em.bg2} opacity=".55" />
      <g transform={`translate(${x + w * 0.22} ${y + h * 0.12}) scale(${(w * 0.56) / 24})`}><path d={em.glyph} fill={em.fg} opacity=".95" /></g>
      <text x={x + w / 2} y={y + h * 0.86} textAnchor="middle" fontFamily="Georgia, serif" fontWeight="700" fontSize={h * 0.2} fill={em.fg} letterSpacing=".5">{em.mono}</text>
    </>
  );
}

type Props = {
  /** Unique key for the coin (address/id) — seeds the generated emblem. */
  id: string;
  sym: string;
  image?: string | null;
  pairSym?: string;
  /** "crest" = paired shields (hero / cards); "badge" = coin roundel + pair seal (rows, rails). */
  variant?: "crest" | "badge";
  size?: number;
  className?: string;
  title?: string;
};

function PairInsigniaImpl({ id, sym, image, pairSym = "STRATEGY", variant = "crest", size = 96, className, title }: Props) {
  const uid = useId().replace(/[:]/g, "");
  const em = emblemFor(id, sym);
  const dom = useDominant(image);
  const pi = pairInfo(pairSym);
  const coinCol = dom ?? em.bg;
  const label = title ?? `$${sym} follows ${pi.label}`;

  if (variant === "badge") {
    // Roundel: coin in centre, ring split coin-colour / pair-colour, pair seal at lower right.
    return (
      <svg width={size} height={size} viewBox="0 0 40 40" className={className} role="img" aria-label={label}>
        <defs><clipPath id={`c${uid}`}><circle cx="18" cy="18" r="13" /></clipPath></defs>
        <path d="M18 2a16 16 0 0 0 0 32Z" fill={coinCol} />
        <path d="M18 2a16 16 0 0 1 0 32Z" fill={pi.color} />
        <circle cx="18" cy="18" r="14.6" fill="#0b0f22" />
        <g clipPath={`url(#c${uid})`}><CoinField image={image} em={em} x={5} y={5} w={26} h={26} /></g>
        <circle cx="18" cy="18" r="13" fill="none" stroke="#ffe7a3" strokeOpacity=".7" strokeWidth=".8" />
        <g transform="translate(25 25)"><circle cx="7" cy="7" r="7.6" fill="#0b0f22" /><PairMark sym={pairSym} size={14} /></g>
      </svg>
    );
  }

  // Crest: two heater shields side by side (coin left, pair right), joined by a gold band, under a halo,
  // flanked by chevron bars in the two colours.
  return (
    <svg width={size} height={size * 0.8} viewBox="0 0 120 96" className={className} role="img" aria-label={label}>
      <defs>
        <clipPath id={`l${uid}`}><path d={SHIELD} /></clipPath>
        <linearGradient id={`g${uid}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff6d0" /><stop offset=".5" stopColor="#ffd56a" /><stop offset="1" stopColor="#b8862b" /></linearGradient>
        <linearGradient id={`p${uid}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={pi.color} /><stop offset="1" stopColor={pi.color2} /></linearGradient>
      </defs>
      {/* flanking chevrons */}
      <path d="M2 52 L20 40 L20 58 L2 70Z" fill={coinCol} opacity=".9" />
      <path d="M118 52 L100 40 L100 58 L118 70Z" fill={pi.color} opacity=".9" />
      {/* halo */}
      <ellipse cx="60" cy="13" rx="26" ry="6" fill="none" stroke={`url(#g${uid})`} strokeWidth="3" />
      {/* coin shield */}
      <g transform="translate(13 22) rotate(-5 24 28)">
        <g clipPath={`url(#l${uid})`}><CoinField image={image} em={em} x={4} y={4} w={40} h={48} /></g>
        <path d={SHIELD} fill="none" stroke={`url(#g${uid})`} strokeWidth="2.6" />
      </g>
      {/* pair shield */}
      <g transform="translate(59 22) rotate(5 24 28)">
        <path d={SHIELD} fill={`url(#p${uid})`} />
        <path d="M4 4h40v8H4Z" fill="#0b0f22" opacity=".25" />
        <g transform="translate(8 12)"><PairMark sym={pairSym} size={32} bare /></g>
        <path d={SHIELD} fill="none" stroke={`url(#g${uid})`} strokeWidth="2.6" />
      </g>
      {/* joining band */}
      <path d="M22 70 Q60 84 98 70 L98 80 Q60 94 22 80Z" fill={`url(#g${uid})`} stroke="#5a3d0c" strokeWidth=".6" />
      <text x="60" y="83" textAnchor="middle" fontFamily="Georgia, serif" fontWeight="700" fontSize="7.2" fill="#2a1a04" letterSpacing=".6">${sym.slice(0, 7)} · {pi.short}</text>
    </svg>
  );
}

const PairInsignia = memo(PairInsigniaImpl);
export default PairInsignia;
