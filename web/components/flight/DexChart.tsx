"use client";
/**
 * Coin page price chart, DEX Screener style (lee, Oct 30 — replaces the engine's hand-drawn canvas chart-map and its
 * A–H / 1–5 grid + pass-3 pan code). TradingView lightweight-charts (Apache-2.0; attribution logo kept on, see
 * NOTICE in its package), loaded client-side only via dynamic import so the coin page's first JS stays small.
 *
 *  - candles = MARKET CAP OHLC from the coin's full indexed history (/api/trades, curve + post-ascension hook fills,
 *    paged by lib/chart/history) built by lib/chart/candles (open = previous close, empty buckets skipped)
 *  - 1m / 5m / 1h / 4h / D (default from the history span; your pick is remembered), USD volume bars (green buys ≥ sells)
 *  - drag / wheel / pinch pans + zooms time; drag the right axis to stretch the mcap range, double-click it to auto-fit
 *  - crosshair readout O/H/L/C · Vol · change % (top-left, like DEX Screener); live last-price line
 *  - live: window "disciple:event" Trade (this coin) adds to the last candle; State / the engine mark (real when trading
 *    live) move its close. A paper (guest) HUD mark that differs is shown as a dotted PAPER line, never folded into candles.
 *  - desktop: a CardChrome card ("chart": drag / minimize / close + M) with a resize handle (size saved in the per-account
 *    layout, clamped to the viewport). Phone: fills the drawer's CHART tab body (touch pan / pinch, chips, volume).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { IChartApi, IPriceLine, ISeriesApi, MouseEventParams, Time, UTCTimestamp } from "lightweight-charts";
import { addTick, bucketOf, buildCandles, cleanTicks, defaultTf, fmtMcap, fmtVol, isTf, markLast, TFS, type Candle, type Tf, type Tick } from "@/lib/chart/candles";
import { fetchHistory } from "@/lib/chart/history";
import { clampOffset, clampSize, RESIZABLE, setCard } from "@/lib/game/cardLayout";
import { getLayout, isPhoneUI, updateLayout, useCardLayout } from "@/lib/game/cardLayoutStore";

/* HUD palette (engine.js CHART_STYLE / PnlHud) */
const C = {
  bg: "rgba(8,10,24,.92)", plot: "#0a0c1c", frame: "rgba(255,231,163,.28)", fg: "rgba(220,228,255,.75)", dim: "rgba(220,228,255,.5)", title: "#f3e6c2",
  grid: "rgba(190,200,255,.06)", up: "#3ddc97", down: "#ff5c7a", volUp: "rgba(61,220,151,.45)", volDown: "rgba(255,92,122,.45)", gold: "#ffe7a3", chipOn: "rgba(255,231,163,.16)",
};
const mono = "ui-monospace, Menlo, monospace";
const TF_KEY = "disciple.dexchart.tf";
const GAP = 8, FEED_ROOM = 172, PNL_FALLBACK = 456;   // = engine chartDeskRect (top under the PnL card, above the trades feed)
type Lc = typeof import("lightweight-charts");
type W = { __domChart?: boolean; __pnlBottom?: number | null; __discipleTrade?: unknown };
/** price-axis / crosshair label: $ mcap, blank below $0 (never a "-$20K" tick) */
const axisMcap = (v: number) => (v < 0 ? "" : fmtMcap(v));
const p2 = (n: number) => String(n).padStart(2, "0");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** local-time labels (lightweight-charts works in UTC seconds) */
const tLabel = (t: number, tf: number) => { const d = new Date(t * 1000);
  return tf >= 86400 ? `${MON[d.getMonth()]} ${d.getDate()}` : `${MON[d.getMonth()]} ${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const tickLabel = (t: number, type: number) => { const d = new Date(t * 1000);   // TickMarkType: 0 Year, 1 Month, 2 DayOfMonth, 3 Time, 4 TimeWithSeconds
  return type === 0 ? String(d.getFullYear()) : type === 1 ? MON[d.getMonth()] : type === 2 ? `${MON[d.getMonth()]} ${d.getDate()}` : `${p2(d.getHours())}:${p2(d.getMinutes())}`; };

export default function DexChart({ coin, ticker }: { coin: string; ticker?: string | null }) {
  const addr = coin.toLowerCase();
  const boxRef = useRef<HTMLDivElement>(null), plotRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<{ lc: Lc; chart: IChartApi; candle: ISeriesApi<"Candlestick">; vol: ISeriesApi<"Histogram">; paper: IPriceLine | null } | null>(null);
  const ticksRef = useRef<Tick[]>([]), candlesRef = useRef<Candle[]>([]), byTime = useRef(new Map<number, Candle>());
  const [tf, setTfState] = useState<Tf | null>(null), tfRef = useRef<Tf>(300);
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [hover, setHover] = useState<Candle | null>(null), [last, setLast] = useState<Candle | null>(null), [mark, setMark] = useState<number | null>(null);
  const [phone, setPhone] = useState(false), [ready, setReady] = useState(false), roRef = useRef<ResizeObserver | null>(null);
  const layout = useCardLayout(), card = layout.chart;

  // ---- mounted ⇒ the engine stops drawing its canvas chart (engine.js @domchart, worker-mirrored global)
  useEffect(() => { const w = window as unknown as W; w.__domChart = true; return () => { w.__domChart = false; }; }, []);
  useEffect(() => { const f = () => setPhone(isPhoneUI()); f(); addEventListener("resize", f);
    const mo = new MutationObserver(f); mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => { removeEventListener("resize", f); mo.disconnect(); }; }, []);

  // ---- desktop placement: base spot under the PnL card (like the old chart), saved size / offset clamped to the viewport
  const [vp, setVp] = useState({ vw: 1280, vh: 800, x: 20, y: PNL_FALLBACK + GAP, floor: 628 });
  useEffect(() => {
    const f = () => { const r = document.getElementById("wrap")?.getBoundingClientRect(), w = window as unknown as W, pb = Number(w.__pnlBottom);
      const ox = r?.left ?? 0, oy = r?.top ?? 0, H = r?.height ?? innerHeight;
      const n = { vw: innerWidth, vh: innerHeight, x: Math.round(ox + 20), y: Math.round(oy + (pb > 0 ? pb : PNL_FALLBACK) + GAP), floor: Math.round(oy + H - FEED_ROOM) };
      setVp((o) => (o.vw === n.vw && o.vh === n.vh && o.x === n.x && o.y === n.y && o.floor === n.floor ? o : n)); };
    f(); const id = window.setInterval(f, 500); addEventListener("resize", f);
    return () => { window.clearInterval(id); removeEventListener("resize", f); };
  }, []);
  const rz = RESIZABLE.chart!;
  const size = useMemo(() => {
    if (card?.w && card?.h) return clampSize("chart", card, vp.vw, vp.vh);
    const room = vp.floor - vp.y;   // default: fit between the PnL card and the trades feed (min height when there is no room)
    return clampSize("chart", { w: rz.defW, h: Math.min(rz.defH, Math.max(rz.minH, room)) }, vp.vw, vp.vh);
  }, [card, vp, rz]);
  const off = useMemo(() => (card ? clampOffset({ x: vp.x, y: vp.y, ...size }, card, vp.vw, vp.vh) : { dx: 0, dy: 0 }), [card, vp, size]);
  const hidden = !phone && !!(card?.min || card?.closed);

  // ---- M key (engine forwards it while the DOM chart is mounted): toggle the card
  useEffect(() => { const h = (e: Event) => { const d = (e as CustomEvent<{ toggle?: boolean; on?: boolean | null }>).detail || {};
      const cur = getLayout().chart, shown = !(cur?.closed || cur?.min), on = d.toggle ? !shown : !!d.on;
      updateLayout((l) => setCard(l, "chart", { closed: !on, min: false })); };
    addEventListener("disciple:chartmap", h); return () => removeEventListener("disciple:chartmap", h); }, []);

  // ---- draw the current timeframe
  /** the latest ≤150 candles (≤60 on a phone), right-aligned; a short history keeps normal candle widths (no 3 giant bars) */
  const fitView = useCallback(() => {
    const h = chartRef.current, n = candlesRef.current.length; if (!h || !n) return;
    const narrow = (plotRef.current?.clientWidth ?? 400) < 480, span = Math.min(narrow ? 60 : 150, Math.max(n, narrow ? 36 : 64));
    h.chart.timeScale().setVisibleLogicalRange({ from: n - span, to: n + (narrow ? 2 : 4) });
  }, []);
  const paint = useCallback((fit: boolean) => {
    const h = chartRef.current; if (!h) return;
    const cs = buildCandles(ticksRef.current, tfRef.current);
    candlesRef.current = cs; byTime.current = new Map(cs.map((c) => [c.time, c]));
    h.candle.setData(cs.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
    h.vol.setData(cs.map((c) => ({ time: c.time as UTCTimestamp, value: c.volume, color: c.buyVol >= c.sellVol ? C.volUp : C.volDown })));
    h.chart.applyOptions({ timeScale: { secondsVisible: false, timeVisible: tfRef.current < 86400 } });
    if (fit) fitView();
    setLast(cs[cs.length - 1] ?? null);
    setStatus(cs.length ? "ready" : "empty");
  }, [fitView]);
  const pushLast = useCallback(() => {
    const h = chartRef.current, c = candlesRef.current[candlesRef.current.length - 1]; if (!h || !c) return;
    byTime.current.set(c.time, c);
    h.candle.update({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close });
    h.vol.update({ time: c.time as UTCTimestamp, value: c.volume, color: c.buyVol >= c.sellVol ? C.volUp : C.volDown });
    setLast({ ...c }); setStatus("ready");
  }, []);
  const setTf = useCallback((s: Tf, remember = true) => { tfRef.current = s; setTfState(s); if (remember) try { localStorage.setItem(TF_KEY, String(s)); } catch { /* */ } paint(true); }, [paint]);

  // ---- create the chart (lightweight-charts loaded on demand)
  useEffect(() => {
    let alive = true, chart: IChartApi | null = null;
    import("lightweight-charts").then((lc) => {
      const el = plotRef.current; if (!alive || !el) return;
      chart = lc.createChart(el, {
        autoSize: true,
        layout: { background: { type: lc.ColorType.Solid, color: C.plot }, textColor: C.fg, fontFamily: mono, fontSize: 10, attributionLogo: true },
        grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
        rightPriceScale: { borderColor: C.frame, scaleMargins: { top: 0.12, bottom: 0.24 } },
        timeScale: { borderColor: C.frame, rightOffset: 4, barSpacing: 9, minBarSpacing: 0.5, timeVisible: true, secondsVisible: false,
          tickMarkFormatter: (t: Time, type: number) => tickLabel(Number(t), type) },
        crosshair: { mode: lc.CrosshairMode.Normal, vertLine: { color: "rgba(255,255,255,.35)", labelBackgroundColor: "#2a2638" }, horzLine: { color: "rgba(255,255,255,.35)", labelBackgroundColor: "#2a2638" } },
        localization: { priceFormatter: axisMcap, timeFormatter: (t: Time) => tLabel(Number(t), tfRef.current) },
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
        handleScale: { axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: { time: true, price: true }, mouseWheel: true, pinch: true },
      });
      const candle = chart.addSeries(lc.CandlestickSeries, {
        upColor: C.up, downColor: C.down, wickUpColor: C.up, wickDownColor: C.down, borderVisible: false,
        priceFormat: { type: "custom", formatter: axisMcap, minMove: 0.01 },
        lastValueVisible: true, priceLineVisible: true, priceLineStyle: lc.LineStyle.Dashed, priceLineColor: C.gold,
      });
      const vol = chart.addSeries(lc.HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      chart.subscribeCrosshairMove((p: MouseEventParams) => { setHover(p.time != null ? byTime.current.get(Number(p.time)) ?? null : null); });
      chartRef.current = { lc, chart, candle, vol, paper: null };
      // created / shown while hidden (phone drawer tab closed ⇒ 0 px): re-fit the view once it gets a real size
      let wasW = el.clientWidth;
      const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { const w = el.clientWidth; if (wasW < 40 && w >= 40) fitView(); wasW = w; }) : null;
      ro?.observe(el); roRef.current = ro;
      setReady(true);
    }).catch((e) => { console.warn("[chart] lightweight-charts failed to load", e); if (alive) setStatus("error"); });
    return () => { alive = false; roRef.current?.disconnect(); chart?.remove(); chartRef.current = null; };
  }, [fitView]);

  // ---- full history (paged), then the default / remembered timeframe
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    fetchHistory(addr, (u) => fetch(u, { cache: "no-store" })).then(({ ticks }) => {
      if (!alive) return;
      ticksRef.current = cleanTicks([...ticks, ...ticksRef.current]);   // indexed fills first: their block time wins over a live tick's
      let s: Tf | null = null; try { const v = Number(localStorage.getItem(TF_KEY)); if (isTf(v)) s = v; } catch { /* */ }
      setTf(s ?? defaultTf(ticksRef.current), false);
    }).catch((e) => { console.warn("[chart] history failed", e); if (alive) { setTf(tfRef.current, false); if (!ticksRef.current.length) setStatus("error"); } });
    return () => { alive = false; };
  }, [ready, addr, setTf]);

  // ---- live: this coin's trades + real mcap reads + the HUD mark
  useEffect(() => {
    const seen = new Set<string>();
    const onEv = (e: Event) => {
      const d = (e as CustomEvent).detail as { type?: string; token?: string; mcapUsd?: number; usd?: number; side?: string; txHash?: string; logIndex?: number; block?: string | number } | null;
      if (!d) return;
      if (d.type === "Trade") {
        if (String(d.token || "").toLowerCase() !== addr || !(Number(d.mcapUsd) > 0)) return;
        const id = d.txHash ? `${d.txHash.toLowerCase()}:${d.logIndex ?? 0}` : undefined;
        if (id && (seen.has(id) || ticksRef.current.some((t) => t.id?.toLowerCase() === id))) return;
        if (id) seen.add(id);
        const t: Tick = { id, ts: Date.now(), mcapUsd: Number(d.mcapUsd), usd: Number(d.usd) || 0, side: d.side === "sell" ? "sell" : "buy", block: d.block != null ? Number(d.block) : undefined, logIndex: d.logIndex };
        ticksRef.current.push(t);
        const cs = addTick(candlesRef.current, t, tfRef.current);
        if (cs[cs.length - 1]?.time === bucketOf(t.ts, tfRef.current)) pushLast(); else paint(false);   // an older bucket (clock skew): redraw all
      } else if (d.type === "State" && Number(d.mcapUsd) > 0) {
        if (markLast(candlesRef.current, Number(d.mcapUsd), Date.now(), tfRef.current)) pushLast();
      }
    };
    const onMark = (e: Event) => { const m = Number((e as CustomEvent<{ mcap?: number }>).detail?.mcap); if (!(m > 0)) return;
      if ((window as unknown as W).__discipleTrade) { if (markLast(candlesRef.current, m, Date.now(), tfRef.current)) pushLast(); setMark(null); } else setMark(m); };
    addEventListener("disciple:event", onEv); addEventListener("disciple:mark", onMark);
    return () => { removeEventListener("disciple:event", onEv); removeEventListener("disciple:mark", onMark); };
  }, [addr, paint, pushLast]);

  // ---- paper (guest) HUD price ≠ the on-chain last close ⇒ a dotted PAPER line
  useEffect(() => {
    const h = chartRef.current; if (!h) return;
    const lc = last?.close, show = mark != null && lc != null && Math.abs(mark / lc - 1) > 0.001;
    if (!show) { if (h.paper) { h.candle.removePriceLine(h.paper); h.paper = null; } return; }
    const o = { price: mark!, color: "rgba(255,231,163,.7)", lineWidth: 1 as const, lineStyle: h.lc.LineStyle.Dotted, axisLabelVisible: true, title: "PAPER" };
    if (h.paper) h.paper.applyOptions(o); else h.paper = h.candle.createPriceLine(o);
  }, [mark, last]);

  // ---- resize handle (desktop): live while dragging, the clamped size committed on release
  const rs = useRef<{ x0: number; y0: number; w0: number; h0: number; pid: number } | null>(null);
  const rsDown = (e: React.PointerEvent) => { e.preventDefault(); e.stopPropagation(); rs.current = { x0: e.clientX, y0: e.clientY, w0: size.w, h0: size.h, pid: e.pointerId };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* */ } };
  const rsMove = (e: React.PointerEvent) => { const r = rs.current; if (!r || r.pid !== e.pointerId) return;
    const s = clampSize("chart", { w: r.w0 + e.clientX - r.x0, h: r.h0 + e.clientY - r.y0 }, innerWidth, innerHeight);
    updateLayout((l) => setCard(l, "chart", { dx: l.chart?.dx ?? 0, dy: l.chart?.dy ?? 0, w: s.w, h: s.h }), false); };
  const rsUp = (e: React.PointerEvent) => { const r = rs.current; if (!r || r.pid !== e.pointerId) return; rs.current = null;
    const s = clampSize("chart", getLayout().chart, innerWidth, innerHeight);
    updateLayout((l) => setCard(l, "chart", { dx: off.dx, dy: off.dy, w: s.w, h: s.h })); };
  const rsReset = () => updateLayout((l) => setCard(l, "chart", { w: 0, h: 0 }));

  useLayoutEffect(() => { chartRef.current?.chart.timeScale().applyOptions({ rightOffset: phone ? 2 : 4 }); }, [phone, ready]);

  const shown = hover ?? last, chg = shown ? (shown.close / shown.open - 1) * 100 : 0, up = shown ? shown.close >= shown.open : true;
  const col = up ? C.up : C.down;
  const label = (ticker || "").replace(/^\$/, "").slice(0, 10).toUpperCase();
  const style: React.CSSProperties = phone
    ? { position: "fixed", display: "flex" }
    : { position: "fixed", left: vp.x, top: vp.y, width: size.w, height: size.h, transform: off.dx || off.dy ? `translate(${off.dx}px, ${off.dy}px)` : undefined,
        display: hidden ? "none" : "flex" };
  return (
    <div ref={boxRef} className="dex-chart" data-card="chart" data-testid="dex-chart" data-tf={tf ?? ""} data-status={status}
      style={{ ...style, zIndex: 31, flexDirection: "column", boxSizing: "border-box", background: C.bg, border: `1px solid ${C.frame}`, borderRadius: 10,
        boxShadow: "0 8px 28px rgba(0,0,0,.45)", overflow: "hidden", font: `11px ${mono}`, color: C.fg, userSelect: "none" }}>
      <div className="dex-head" style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", minHeight: 24, borderBottom: "1px solid rgba(255,255,255,.06)" }}>
        <span style={{ color: C.title, fontWeight: 700, letterSpacing: ".04em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {label ? `$${label}` : "MCAP"} <span style={{ color: C.dim, fontWeight: 400 }}>· MCAP USD</span></span>
        <span style={{ flex: 1 }} />
        <div role="group" aria-label="Timeframe" style={{ display: "flex", gap: 2 }}>
          {TFS.map((t) => <button key={t.s} type="button" data-testid={`dex-tf-${t.l}`} aria-pressed={tf === t.s} onClick={() => setTf(t.s)}
            style={{ all: "unset", cursor: "pointer", padding: phone ? "3px 9px" : "1px 6px", borderRadius: 6, fontSize: phone ? 12 : 10.5, fontWeight: 700,
              color: tf === t.s ? C.gold : C.dim, background: tf === t.s ? C.chipOn : "transparent" }}>{t.l}</button>)}
        </div>
      </div>
      <div style={{ position: "relative", flex: "1 1 auto", minHeight: 0 }}>
        <div ref={plotRef} data-testid="dex-plot" style={{ position: "absolute", inset: 0 }} />
        {shown && <div data-testid="dex-ohlc" style={{ position: "absolute", left: 6, top: 4, zIndex: 3, pointerEvents: "none", display: "flex", flexWrap: "wrap", gap: "0 8px",
          fontSize: phone ? 10.5 : 10.5, lineHeight: "14px", textShadow: "0 1px 2px #000", maxWidth: "calc(100% - 70px)" }}>
          {!phone && <><span>O <b style={{ color: col, fontWeight: 500 }}>{fmtMcap(shown.open)}</b></span>
            <span>H <b style={{ color: col, fontWeight: 500 }}>{fmtMcap(shown.high)}</b></span>
            <span>L <b style={{ color: col, fontWeight: 500 }}>{fmtMcap(shown.low)}</b></span></>}
          <span>C <b style={{ color: col, fontWeight: 500 }}>{fmtMcap(shown.close)}</b></span>
          <span style={{ color: col }}>{(chg >= 0 ? "+" : "") + chg.toFixed(2)}%</span>
          <span>Vol <b style={{ color: C.fg, fontWeight: 500 }}>{fmtVol(shown.volume)}</b></span>
        </div>}
        {status !== "ready" && <div data-testid="dex-empty" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: C.dim, pointerEvents: "none", zIndex: 2 }}>
          {status === "loading" ? "loading trades…" : status === "error" ? "chart unavailable" : `no trades yet${mark ? ` · mcap ${fmtMcap(mark)}` : ""}`}</div>}
      </div>
      {!phone && <div data-testid="card-resize-chart" title="Drag to resize (double-click: default size)" onPointerDown={rsDown} onPointerMove={rsMove} onPointerUp={rsUp} onPointerCancel={rsUp}
        onDoubleClick={rsReset} style={{ position: "absolute", right: 0, bottom: 0, width: 14, height: 14, cursor: "nwse-resize", zIndex: 5, touchAction: "none",
          background: `linear-gradient(135deg, transparent 0 50%, ${C.frame} 50% 58%, transparent 58% 70%, ${C.frame} 70% 78%, transparent 78%)` }} />}
      <style jsx global>{`
        html.ap-phone .dex-chart { display: none !important; }
        html.ap-phone[data-ph-sheet="chart"] .dex-chart {
          display: flex !important; left: var(--ph-bx) !important; top: var(--ph-by) !important; width: var(--ph-bw) !important; height: var(--ph-bh) !important;
          transform: none !important; z-index: 32 !important; border-radius: 20px !important; box-shadow: none !important;
        }
      `}</style>
    </div>
  );
}
