"use client";
/**
 * Turbo flight: the CURRENT-MAIN flight engine (public/flight/engine.js) in its Turbo mode (?source=turbo&clean=1).
 * Not draft #311. Same locked rocket sprite. Existing background — no new skies.
 *
 * What this component feeds the engine (all cosmetic; a BOOST / DUMP / CLOSE tap never waits on any of it):
 *  - mark(mcap)  = live BTC/ETH market cap (lib/turbo/flight.ts marketCapUsd) → window.__turboFeed({t:'mark', mcap})
 *                  The rocket follows this the same way a live DISCIPLE rocket follows its market, even with no position.
 *  - swap(trade) = a completed Hyperliquid (or later, Nova) buy/sell → window.__turboFeed({t:'swap', ...})
 *                  Buys become boosts and sells become bombs via the engine's existing ammo / impact path.
 *  - window.__turboFx = { open, pending, side, lev, danger, dive:false, liqMcap, liqLabel }
 *  - ignite(): flame on at the player's own tap, before the fill arrives
 *  - supernova(): the engine's ATOM bomb under the page's H-BOMB overlay (TurboHBomb)
 * The engine never places trades. A short does not flip the sky.
 * @turbo-sky (maker, Nov 13 2026): the page now marks the ZOOMED sky market cap (skyMcap) instead of the whole BTC/ETH
 * market cap, so the H-BOMB line sits ~16% of the screen below the boarding line at any gear.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { brandedRocket } from "@/lib/decal";
import { BASE_PATH, withBase } from "@/lib/base-path";
import { AMMO_TIERS } from "@/lib/flight/ammoTiers";
import { paperCurve } from "@/lib/flight/paperCurve";
import GameRadio from "@/components/flight/GameRadio";
import { skyAlt } from "@/lib/turbo/flight";
import SettingsMenu from "@/components/flight/SettingsMenu";

export interface TurboFx {
  open: boolean; pending: boolean; side: "long" | "short" | null; lev: number; danger: number;
  /** Always false: a short does not dive or invert the sky (lee, Nov 12 2026 10:40 AM CT). */
  dive: boolean;
  liqMcap?: number; liqLabel?: string;
  /** @turbo-sky: lines drawn across the zoomed sky (H-BOMB, break-even, boarded), at their sky market cap. */
  lines?: { mcap: number; kind: "hbomb" | "even" | "boarded"; label: string }[];
}

export interface TurboSwap {
  side: "buy" | "sell";
  usd: number;
  mcap: number;
  price: number;
  prePrice?: number;
  ts?: number;
  trader?: string;
}

export interface TurboFlightHandle {
  /** Follow the live market cap (engine mark path). */
  mark(mcap: number): void;
  /** A completed market print: buy → boost, sell → bomb, using the engine's existing sizing. */
  swap(t: TurboSwap): void;
  setFx(fx: TurboFx): void;
  ignite(): void;
  supernova(bombs: boolean): void;
  pxPerAlt(): number | undefined;
  altToMcap(alt: number): number | null;
  ready(): boolean;
  /** @turbo-sky: the zoomed-sky market cap for a price (anchor + liqDist set by the page), or null before the engine loads. */
  skyMcap(price: number, anchor: number, liqDist: number): number | null;
}

type Engine = { PX_PER_ALT?: number; altToMcap?: (a: number) => number; bomb?: (k: string, o?: unknown) => void; S?: Record<string, unknown>; source?: { stop?: () => void } };
type W = Window & { __flight?: Engine; __turboFeed?: ((e: unknown) => void) | null; __turboFx?: TurboFx; Q_OVERRIDE?: URLSearchParams | null; __rocketDecal?: unknown; __entryMcap?: number };

const TurboFlight = forwardRef<TurboFlightHandle, { className?: string; ticker?: string; onReady?: () => void }>(function TurboFlight({ className, ticker = "BTC", onReady }, ref) {
  const wrap = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "live" | "error">("loading");
  const pendingMark = useRef<number | null>(null);
  const lastMcap = useRef(0);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const push = (e: Record<string, unknown>) => {
    const w = window as W;
    const feed = w.__turboFeed;
    if (!feed) return false;
    feed(e);
    return true;
  };

  useImperativeHandle(ref, () => ({
    mark(mcap) {
      if (!(mcap > 0)) return;
      lastMcap.current = mcap;
      if (!push({ t: "mark", mcap })) pendingMark.current = mcap;
    },
    swap(t) {
      if (!(t.mcap > 0) || !(t.usd > 0)) return;
      lastMcap.current = t.mcap;
      const ev: Record<string, unknown> = {
        t: "swap", side: t.side, usd: t.usd, mcap: t.mcap, price: t.price,
        prePrice: t.prePrice, postPrice: t.price, ts: t.ts ?? Date.now(),
        txHash: "(turbo-print)", mine: false, trader: t.trader,
      };
      if (!push(ev)) pendingMark.current = t.mcap;
    },
    setFx(fx) { (window as W).__turboFx = { ...fx, dive: false }; },
    ignite() { const S = (window as W).__flight?.S; if (S) { S.buyBoost = 1; S.thrustT = S.t; } },
    supernova(bombs) { if (bombs) try { (window as W).__flight?.bomb?.("atom", { usd: 0, mine: true }); } catch { /* cosmetic */ } },
    pxPerAlt() { const v = (window as W).__flight?.PX_PER_ALT; return typeof v === "number" && v > 0 ? v : undefined; },
    altToMcap(alt) { const f = (window as W).__flight; return f?.altToMcap ? f.altToMcap(alt) : null; },
    ready() { return status === "live"; },
    skyMcap(price, anchor, liqDist) {
      const f = (window as W).__flight;
      if (!f?.altToMcap || !(price > 0)) return null;
      const m = f.altToMcap(skyAlt(price, anchor, liqDist, window.innerHeight, f.PX_PER_ALT ?? 0));
      return Number.isFinite(m) && m > 0 ? m : null;
    },
  }), [status]);

  useEffect(() => {
    let cancelled = false;
    const w = window as W;
    const cv = document.createElement("canvas");
    cv.id = "c";
    wrap.current?.appendChild(cv);
    const fade = document.createElement("div");
    fade.id = "launchFade"; fade.style.cssText = "position:absolute;inset:0;background:#000;opacity:0;pointer-events:none";
    wrap.current?.appendChild(fade);
    Object.assign(window, { __DISCIPLE_BASE_PATH__: BASE_PATH, __AMMO_TIERS: AMMO_TIERS, __PAPER_CURVE: paperCurve(),
      __GAME_FONT: getComputedStyle(document.documentElement).getPropertyValue("--font-barlow-condensed").trim() });
    w.Q_OVERRIDE = new URLSearchParams("source=turbo&clean=1");
    w.__turboFx = { open: false, pending: false, side: null, lev: 100, danger: 0, dive: false };
    brandedRocket(null).then(({ canvas, fallback }) => { if (!cancelled) w.__rocketDecal = { canvas, t0: performance.now(), fallback }; }).catch(() => {});
    document.querySelector('script[data-disciple-flight="1"]')?.remove();
    delete w.__flight;
    const s = document.createElement("script");
    s.src = withBase("/flight/engine.js"); s.async = false; s.dataset.discipleFlight = "1";
    s.onload = () => {
      if (cancelled) return;
      setStatus("live");
      onReadyRef.current?.();
      const tryFeed = () => {
        if (cancelled) return;
        if (w.__turboFeed && w.__flight) {
          const m = pendingMark.current ?? lastMcap.current;
          pendingMark.current = null;
          if (m > 0) w.__turboFeed({ t: "swap", block: 0, ts: Date.now(), txHash: "(turbo)", side: "buy", usd: 0, mcap: m, price: m / 1e6, mine: true });
        } else setTimeout(tryFeed, 50);
      };
      tryFeed();
    };
    s.onerror = () => { if (!cancelled) setStatus("error"); };
    document.body.appendChild(s);
    return () => {
      cancelled = true;
      try { w.__flight?.source?.stop?.(); } catch { /* ignore */ }
      (window as unknown as { __flightGen?: number }).__flightGen = ((window as unknown as { __flightGen?: number }).__flightGen || 0) + 1;
      s.remove(); cv.remove(); fade.remove();
      w.Q_OVERRIDE = null; w.__turboFeed = null; w.__entryMcap = 0;
    };
  }, []);

  return (
    <>
      <div ref={wrap} id="wrap" className={`flight-wrap ${className ?? ""}`} data-testid="turbo-flight" data-status={status}
        style={{ position: "fixed", top: 0, right: 0, bottom: 0, left: "var(--ap-rail-w, 64px)", overflow: "hidden" }}>
        {status !== "live" && <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--dsc-muted)", fontSize: 13 }}>
          {status === "error" ? "The flight view didn't load. Trading still works." : "Loading the flight…"}</div>}
      </div>
      <div className="turbo-radio-slot"><GameRadio /></div>
      <SettingsMenu coin="" ticker={ticker} simulator={false} />
    </>
  );
});
export default TurboFlight;
