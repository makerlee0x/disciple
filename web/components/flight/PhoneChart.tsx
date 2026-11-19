"use client";
/**
 * Flight chart card, phones and desktop Pilot (throttle prototype v3, maker 2026-11-14: "the chart is fantastic"; "otherwise it feels like
 * you're trading blind"). Market-cap CANDLES under the top row: 1M · 5M · 1H · 1D = how much time the card shows (30 candles each:
 * 2 s, 10 s, 2 min, 48 min) plus a pause, the live price tag on the right and a dashed YOU BOARDED line at your entry.
 *
 * Fixes from maker's live play-test (2026-11-14 8:15 PM CT):
 *  - "the chart took forever to load" / "I can't see the history": a live coin's card is seeded from its full fill history
 *    (/api/trades, lib/chart/history, the same feed as the Pro chart), not only marks seen since the page opened.
 *  - "the chart went away": marks only arrive when the price moves, so a quiet minute emptied the 1M window ("Reading the
 *    market…"). The last price now carries forward: a quiet stretch draws flat candles instead of nothing.
 *  - "what are the yellow dots?": the per-fill dots (placed at the pre-trade mark, so they floated off the line) are gone.
 *  - line → candles ("see candles").
 * The series is kept in a module store while the flight is open (a re-render or a sheet open never loses it). Drawn at
 * ~4 fps on a small canvas, paused while the tab is hidden.
 */
import { useEffect, useRef, useState } from "react";
import { fetchHistory } from "@/lib/chart/history";

export const CHART_TFS = [{ k: "1M", ms: 60_000 }, { k: "5M", ms: 300_000 }, { k: "1H", ms: 3_600_000 }, { k: "1D", ms: 86_400_000 }] as const;
const KEEP_MS = 25 * 3_600_000, MIN_GAP_MS = 250, BARS = 30;

type Pt = { t: number; m: number };
const store: { key: string; pts: Pt[]; hist: Pt[]; histFor: string; last: number } = { key: "", pts: [], hist: [], histFor: "", last: 0 };

/** Push a mark, thinning to one point per MIN_GAP_MS and keeping KEEP_MS. Pure on the arrays passed in; tested. */
export function pushMark(pts: Pt[], t: number, m: number): Pt[] {
  if (!(m > 0)) return pts;
  const prev = pts[pts.length - 1];
  if (prev && t - prev.t < MIN_GAP_MS) { prev.m = m; return pts; }
  pts.push({ t, m });
  let cut = 0; while (cut < pts.length && pts[cut].t < t - KEEP_MS) cut++;
  return cut ? pts.splice(0, cut) && pts : pts;
}
/** The window's % change: the price at the window's start (carried forward from before it) → the last price. Pure, tested. */
export function windowChange(pts: Pt[], now: number, ms: number): number | null {
  if (!pts.length) return null;
  let first: number | null = null;
  for (const p of pts) { if (p.t <= now - ms) first = p.m; else { if (first == null) first = p.m; break; } }
  const last = pts[pts.length - 1].m;
  if (first == null || !(first > 0) || pts.length < 2) return null;
  return (last / first - 1) * 100;
}
export type Bar = { o: number; h: number; l: number; c: number; empty: boolean };
/**
 * `n` candles covering [now − ms, now] from a time-sorted series. Each opens at the previous close; a bucket with no point
 * is a flat bar at the carried-forward price (empty: true); buckets before the first known price are null (not drawn).
 * Pure, tested.
 */
export function windowBars(pts: Pt[], now: number, ms: number, n = BARS): (Bar | null)[] {
  const out: (Bar | null)[] = [], step = ms / n, t0 = now - ms;
  let i = 0, prev: number | null = null;
  while (i < pts.length && pts[i].t < t0) { prev = pts[i].m; i++; }
  for (let b = 0; b < n; b++) {
    const end = t0 + (b + 1) * step;
    let bar: Bar | null = prev != null ? { o: prev, h: prev, l: prev, c: prev, empty: true } : null;
    while (i < pts.length && pts[i].t < end) {
      const m = pts[i].m;
      if (!bar) bar = { o: m, h: m, l: m, c: m, empty: false };
      bar.h = Math.max(bar.h, m); bar.l = Math.min(bar.l, m); bar.c = m; bar.empty = false; i++;
    }
    out.push(bar); if (bar) prev = bar.c;
  }
  return out;
}
/** history fills + live marks as one time-sorted series (marks after the last fill win for the live price) */
function series(): Pt[] {
  if (!store.hist.length) return store.pts;
  const lastH = store.hist[store.hist.length - 1].t;
  return [...store.hist, ...store.pts.filter((p) => p.t > lastH)];
}
const coinOfPath = () => (/^\/coin\/(0x[0-9a-fA-F]{40})/.exec(location.pathname)?.[1] ?? "").toLowerCase();

const money = (v: number) => (!(v > 0) ? "$0" : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(2)}K` : `$${v.toFixed(0)}`);
const G = "800 13px 'Barlow Condensed', 'Arial Narrow', sans-serif";

export default function PhoneChart({ tf, onTf, big, onBig, entry, ticker, badge, bottom = 0, children }: {
  tf: number; onTf: (i: number) => void; big: boolean;
  /** tap the card to make it taller; left out (live coin flight on desktop) the card stays its normal size */
  onBig?: () => void; entry: number | null; ticker: string;
  badge: { t: string; c: string } | null;
  /** px kept clear at the bottom of the plot (desktop: the stats pills sit there) */
  bottom?: number; children?: React.ReactNode;
}) {
  const cv = useRef<HTMLCanvasElement>(null);
  const lab = useRef<HTMLSpanElement>(null);
  const tfRef = useRef(tf); tfRef.current = tf;
  const entryRef = useRef(entry); entryRef.current = entry;
  const bottomRef = useRef(bottom); bottomRef.current = bottom;
  // pause (maker 2026-11-18: "it autoscrolls and now its just flat"): the window stops at the moment you paused, new
  // prices still arrive underneath and show again on play
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const pausedRef = useRef(pausedAt); pausedRef.current = pausedAt;

  useEffect(() => {
    const key = location.pathname + location.search;
    if (store.key !== key) { store.key = key; store.pts = []; store.last = 0; }
    const coin = coinOfPath();
    if (coin && store.histFor !== coin) {
      store.histFor = coin; store.hist = [];
      // a live coin: seed the card with the coin's whole flight (indexed fills), so history is there at once
      fetchHistory(coin, (u) => fetch(u, { cache: "no-store" })).then(({ ticks }) => {
        if (store.histFor !== coin) return;
        store.hist = ticks.filter((t) => t.mcapUsd > 0).map((t) => ({ t: t.ts, m: t.mcapUsd })).sort((a, b) => a.t - b.t);
        if (!store.last && store.hist.length) store.last = store.hist[store.hist.length - 1].m;
      }).catch((e) => { console.warn("[chart] card history failed", e); if (store.histFor === coin) store.histFor = ""; });
    }
    const onMark = (e: Event) => { const m = (e as CustomEvent<{ mcap?: number }>).detail?.mcap; if (m && m > 0) { store.last = m; pushMark(store.pts, Date.now(), m); } };
    addEventListener("disciple:mark", onMark);
    return () => { removeEventListener("disciple:mark", onMark); };
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
      const now = pausedRef.current ?? Date.now(), ms = CHART_TFS[tfRef.current].ms;
      const all = series();
      const upto = pausedRef.current != null ? all.filter((p) => p.t <= now) : all;
      const ch = windowChange(upto, now, ms);
      if (lab.current) { const t = `MARKET CAP${ch == null ? "" : ` ${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%`}`; if (lab.current.textContent !== t) lab.current.textContent = t; lab.current.style.color = ch == null ? "" : ch >= 0 ? "#5FF0A0" : "#FF8FBD"; }
      const T = 38, B = 8 + bottomRef.current, L0 = 8, Rr = 66, w = r.width - L0 - Rr, h = r.height - T - B;
      const bars = windowBars(upto, now, ms);
      const shown = bars.filter((x): x is Bar => !!x);
      if (!shown.length || w <= 0 || h <= 0) {
        // no loading sentence (copy rule): a soft pulse until the first price lands
        const a = 0.25 + 0.2 * Math.sin(now / 160); x.fillStyle = `rgba(243,223,168,${a.toFixed(3)})`;
        x.beginPath(); x.arc(r.width / 2, T + h / 2, 4, 0, Math.PI * 2); x.fill(); return;
      }
      const ent = entryRef.current && entryRef.current > 0 ? entryRef.current : null;
      let lo = Infinity, hi = -Infinity; for (const c of shown) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; }
      if (ent && ent > lo * 0.7 && ent < hi * 1.3) { lo = Math.min(lo, ent); hi = Math.max(hi, ent); }
      const pad = Math.max((hi - lo) * 0.12, hi * 0.01); lo -= pad; hi += pad;
      const Y = (m: number) => T + (1 - (m - lo) / (hi - lo)) * h;
      const slot = w / bars.length, bw = Math.max(2, Math.min(14, slot * 0.66));
      const lastBar = shown[shown.length - 1], up = ch == null ? true : ch >= 0, col = up ? "95,240,160" : "240,48,127";
      // you boarded
      if (ent && ent >= lo && ent <= hi) {
        const ey = Y(ent); x.setLineDash([5, 4]); x.strokeStyle = "rgba(243,223,168,.85)"; x.lineWidth = 1.4;
        x.beginPath(); x.moveTo(L0, ey); x.lineTo(L0 + w, ey); x.stroke(); x.setLineDash([]);
        x.font = "700 11px 'Barlow Condensed', 'Arial Narrow', sans-serif"; x.fillStyle = "rgba(243,223,168,.8)"; x.textAlign = "left"; x.fillText("YOU BOARDED", L0 + 2, ey + 12);
      }
      // candles (green up, pink down; a quiet stretch is a thin flat tick at the carried price)
      bars.forEach((c, i) => {
        if (!c) return;
        const cx = L0 + slot * (i + 0.5), g = c.c >= c.o;
        x.strokeStyle = x.fillStyle = c.empty ? "rgba(215,217,228,.35)" : g ? "#5FF0A0" : "#F0307F";
        x.lineWidth = 1.2; x.beginPath(); x.moveTo(cx, Y(c.h)); x.lineTo(cx, Y(c.l)); x.stroke();
        const y1 = Y(Math.max(c.o, c.c)), y2 = Y(Math.min(c.o, c.c));
        x.fillRect(cx - bw / 2, y1, bw, Math.max(1.5, y2 - y1));
      });
      const lx = L0 + slot * (bars.length - 0.5), ly = Y(lastBar.c);
      x.setLineDash([2, 3]); x.strokeStyle = `rgba(${col},.55)`; x.lineWidth = 1; x.beginPath(); x.moveTo(L0, ly); x.lineTo(L0 + w, ly); x.stroke(); x.setLineDash([]);
      // live dot + price tag
      void lx;
      const tag = money(lastBar.c); x.font = "800 15px 'Barlow Condensed', 'Arial Narrow', sans-serif";
      const tw = x.measureText(tag).width + 12, tx = r.width - tw - 6, ty = Math.max(T, Math.min(T + h - 20, ly - 10));
      x.fillStyle = `rgb(${col})`; x.beginPath(); x.roundRect(tx, ty, tw, 20, 6); x.fill();
      x.fillStyle = up ? "#0d2a1b" : "#FFFFFF"; x.textAlign = "left"; x.fillText(tag, tx + 6, ty + 15);
    };
    const kick = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); };
    // speed (maker 2026-11-18: "the delay on the chart … is horrendous"): a new price draws on the next frame, not the next 250 ms tick
    const id = setInterval(kick, 250);
    addEventListener("disciple:mark", kick);
    draw();
    return () => { clearInterval(id); cancelAnimationFrame(raf); removeEventListener("disciple:mark", kick); };
  }, [big, tf, pausedAt]);

  return (
    <div className="pc" data-testid="phone-chart" data-big={big ? "1" : "0"} data-grow={onBig ? "1" : "0"} role="group" aria-label={onBig ? "Market cap chart. Tap to make it bigger." : "Market cap chart"} onClick={onBig}>
      <canvas ref={cv} aria-hidden />
      <span className="pc-lab"><span ref={lab}>MARKET CAP</span>{ticker ? <b>{ticker}</b> : null}</span>
      {badge && <span className="pc-badge" data-testid="phone-mode" style={{ borderColor: badge.c }}><i style={{ background: badge.c }} />{badge.t}</span>}
      <div className="pc-tf" role="tablist" aria-label="Chart time">
        {CHART_TFS.map((t, i) => <button key={t.k} type="button" role="tab" aria-selected={tf === i} className={tf === i ? "on" : ""} data-testid={`chart-tf-${t.k}`}
          onClick={(e) => { e.stopPropagation(); onTf(i); }}>{t.k}</button>)}
        <button type="button" className={pausedAt != null ? "on" : ""} data-testid="chart-pause" aria-pressed={pausedAt != null}
          aria-label={pausedAt != null ? "Play chart" : "Pause chart"} title={pausedAt != null ? "Play" : "Pause"}
          onClick={(e) => { e.stopPropagation(); setPausedAt((p) => (p != null ? null : Date.now())); }}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden style={{ verticalAlign: "-1px" }}>
            {pausedAt != null ? <path d="M3 1.5v9l7.5-4.5z" fill="currentColor" /> : <><rect x="2" y="1.5" width="3" height="9" rx="1" fill="currentColor" /><rect x="7" y="1.5" width="3" height="9" rx="1" fill="currentColor" /></>}
          </svg>
        </button>
      </div>
      {children}
    </div>
  );
}
