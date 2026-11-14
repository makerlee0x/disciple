"use client";
/**
 * Phone flight chart card (throttle prototype v3, maker 2026-11-14: "the chart is fantastic"; "otherwise it feels like
 * you're trading blind"). A small market-cap line under the top row: 1M · 5M · 1H tabs, the live price tag on the right,
 * a dashed YOU BOARDED line at your entry, and a dot for each of your fills. Tap the card to make it taller.
 * The series is kept from the engine's disciple:mark while the flight is open (module store, so a re-render or a sheet
 * open never loses it). Drawn at ~4 fps on a small canvas, paused while the tab is hidden.
 */
import { useEffect, useRef } from "react";

export const CHART_TFS = [{ k: "1M", ms: 60_000 }, { k: "5M", ms: 300_000 }, { k: "1H", ms: 3_600_000 }] as const;
const KEEP_MS = 3_600_000, MIN_GAP_MS = 250;

type Pt = { t: number; m: number };
type Dot = { t: number; m: number; buy: boolean };
const store: { key: string; pts: Pt[]; dots: Dot[]; last: number } = { key: "", pts: [], dots: [], last: 0 };

/** Push a mark, thinning to one point per MIN_GAP_MS and keeping an hour. Pure on the arrays passed in; tested. */
export function pushMark(pts: Pt[], t: number, m: number): Pt[] {
  if (!(m > 0)) return pts;
  const prev = pts[pts.length - 1];
  if (prev && t - prev.t < MIN_GAP_MS) { prev.m = m; return pts; }
  pts.push({ t, m });
  let cut = 0; while (cut < pts.length && pts[cut].t < t - KEEP_MS) cut++;
  return cut ? pts.splice(0, cut) && pts : pts;
}
/** The window's % change, first point in the window → last. Pure, tested. */
export function windowChange(pts: Pt[], now: number, ms: number): number | null {
  const w = pts.filter((p) => p.t >= now - ms);
  if (w.length < 2 || !(w[0].m > 0)) return null;
  return (w[w.length - 1].m / w[0].m - 1) * 100;
}

const money = (v: number) => (!(v > 0) ? "$0" : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(2)}K` : `$${v.toFixed(0)}`);
const G = "800 13px 'Barlow Condensed', 'Arial Narrow', sans-serif";

export default function PhoneChart({ tf, onTf, big, onBig, entry, ticker, badge }: {
  tf: number; onTf: (i: number) => void; big: boolean; onBig: () => void; entry: number | null; ticker: string;
  badge: { t: string; c: string } | null;
}) {
  const cv = useRef<HTMLCanvasElement>(null);
  const lab = useRef<HTMLSpanElement>(null);
  const tfRef = useRef(tf); tfRef.current = tf;
  const entryRef = useRef(entry); entryRef.current = entry;

  useEffect(() => {
    const key = location.pathname + location.search;
    if (store.key !== key) { store.key = key; store.pts = []; store.dots = []; store.last = 0; }
    const onMark = (e: Event) => { const m = (e as CustomEvent<{ mcap?: number }>).detail?.mcap; if (m && m > 0) { store.last = m; pushMark(store.pts, Date.now(), m); } };
    const onFill = (e: Event) => { const d = (e as CustomEvent<{ side?: string }>).detail; if (store.last > 0 && (d?.side === "buy" || d?.side === "sell")) store.dots.push({ t: Date.now(), m: store.last, buy: d.side === "buy" }); if (store.dots.length > 60) store.dots.shift(); };
    addEventListener("disciple:mark", onMark); addEventListener("disciple:fillreceipt", onFill);
    return () => { removeEventListener("disciple:mark", onMark); removeEventListener("disciple:fillreceipt", onFill); };
  }, []);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const c = cv.current; if (!c || document.hidden) return;
      const r = c.getBoundingClientRect(); if (!r.width || !r.height) return;
      const dpr = Math.min(2, devicePixelRatio || 1), W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      const x = c.getContext("2d"); if (!x) return;
      x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, r.width, r.height);
      const now = Date.now(), ms = CHART_TFS[tfRef.current].ms;
      const pts = store.pts.filter((p) => p.t >= now - ms);
      const ch = windowChange(store.pts, now, ms);
      if (lab.current) { const t = `MARKET CAP${ch == null ? "" : ` ${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%`}`; if (lab.current.textContent !== t) lab.current.textContent = t; lab.current.style.color = ch == null ? "" : ch >= 0 ? "#5FF0A0" : "#FF8FBD"; }
      const T = 38, B = 8, L0 = 8, Rr = 66, w = r.width - L0 - Rr, h = r.height - T - B;
      if (pts.length < 2 || w <= 0 || h <= 0) {
        x.fillStyle = "rgba(215,217,228,.55)"; x.font = "500 12px system-ui, sans-serif"; x.textAlign = "center";
        x.fillText(store.last > 0 ? "Reading the market…" : "Waiting for the first price…", r.width / 2, T + h / 2 + 4); return;
      }
      const ent = entryRef.current && entryRef.current > 0 ? entryRef.current : null;
      let lo = Infinity, hi = -Infinity; for (const p of pts) { if (p.m < lo) lo = p.m; if (p.m > hi) hi = p.m; }
      if (ent && ent > lo * 0.7 && ent < hi * 1.3) { lo = Math.min(lo, ent); hi = Math.max(hi, ent); }
      const pad = Math.max((hi - lo) * 0.12, hi * 0.002); lo -= pad; hi += pad;
      const X = (t: number) => L0 + ((t - (now - ms)) / ms) * w, Y = (m: number) => T + (1 - (m - lo) / (hi - lo)) * h;
      const up = pts[pts.length - 1].m >= pts[0].m, col = up ? "95,240,160" : "240,48,127";
      // area + line
      x.beginPath(); x.moveTo(X(pts[0].t), Y(pts[0].m)); for (const p of pts) x.lineTo(X(p.t), Y(p.m));
      const lx = X(pts[pts.length - 1].t), ly = Y(pts[pts.length - 1].m);
      x.strokeStyle = `rgb(${col})`; x.lineWidth = 2.2; x.lineJoin = "round"; x.stroke();
      x.lineTo(lx, T + h); x.lineTo(X(pts[0].t), T + h); x.closePath();
      const gr = x.createLinearGradient(0, T, 0, T + h); gr.addColorStop(0, `rgba(${col},.32)`); gr.addColorStop(1, `rgba(${col},0)`); x.fillStyle = gr; x.fill();
      // you boarded
      if (ent && ent >= lo && ent <= hi) {
        const ey = Y(ent); x.setLineDash([5, 4]); x.strokeStyle = "rgba(243,223,168,.85)"; x.lineWidth = 1.4;
        x.beginPath(); x.moveTo(L0, ey); x.lineTo(L0 + w, ey); x.stroke(); x.setLineDash([]);
        x.font = "700 11px 'Barlow Condensed', 'Arial Narrow', sans-serif"; x.fillStyle = "rgba(243,223,168,.8)"; x.textAlign = "left"; x.fillText("YOU BOARDED", L0 + 2, ey + 12);
      }
      // your fills
      for (const d of store.dots) { if (d.t < now - ms) continue; x.beginPath(); x.arc(X(d.t), Y(d.m), 4, 0, Math.PI * 2); x.fillStyle = d.buy ? "#F2C14E" : "#F0307F"; x.fill(); x.lineWidth = 1.5; x.strokeStyle = "#121327"; x.stroke(); }
      // live dot + price tag
      x.beginPath(); x.arc(lx, ly, 3.5, 0, Math.PI * 2); x.fillStyle = `rgb(${col})`; x.fill();
      const tag = money(pts[pts.length - 1].m); x.font = "800 15px 'Barlow Condensed', 'Arial Narrow', sans-serif";
      const tw = x.measureText(tag).width + 12, tx = r.width - tw - 6, ty = Math.max(T, Math.min(T + h - 20, ly - 10));
      x.fillStyle = `rgb(${col})`; x.beginPath(); x.roundRect(tx, ty, tw, 20, 6); x.fill();
      x.fillStyle = up ? "#0d2a1b" : "#FFFFFF"; x.textAlign = "left"; x.fillText(tag, tx + 6, ty + 15);
    };
    const id = setInterval(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }, 250);
    draw();
    return () => { clearInterval(id); cancelAnimationFrame(raf); };
  }, [big, tf]);

  return (
    <div className="pc" data-testid="phone-chart" data-big={big ? "1" : "0"} role="group" aria-label="Market cap chart. Tap to make it bigger." onClick={onBig}>
      <canvas ref={cv} aria-hidden />
      <span className="pc-lab"><span ref={lab}>MARKET CAP</span>{ticker ? <b>{ticker}</b> : null}</span>
      {badge && <span className="pc-badge" data-testid="phone-mode" style={{ borderColor: badge.c }}><i style={{ background: badge.c }} />{badge.t}</span>}
      <div className="pc-tf" role="tablist" aria-label="Chart time">
        {CHART_TFS.map((t, i) => <button key={t.k} type="button" role="tab" aria-selected={tf === i} className={tf === i ? "on" : ""} data-testid={`chart-tf-${t.k}`}
          onClick={(e) => { e.stopPropagation(); onTf(i); }}>{t.k}</button>)}
      </div>
    </div>
  );
}
