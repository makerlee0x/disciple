"use client";
/**
 * Turbo flight: the CURRENT-MAIN flight engine (public/flight/engine.js) in its Turbo mode (?source=turbo&clean=1).
 * Not draft #311. Same locked rocket sprite; the DUMP dive is a pose of it.
 *
 * What this component feeds the engine (all cosmetic; a BOOST / DUMP / CLOSE tap never waits on any of it):
 *  - altitude  = PnL after fees as a share of fuel (lib/turbo/flight.ts pnlToAlt) → window.__turboFeed({t:'mark', mcap})
 *  - window.__turboFx = { open, pending, side, lev, danger, dive, liqMcap, liqLabel } → red liquidation seam, jetstream
 *    L = log10(lev)/3, baseline airspeed, orange glow > 50%, shudder (existing wobble spring) > 80%, sputter > 95%
 *  - ignite(): flame on at the tap (engine S.buyBoost), before the fill arrives
 *  - supernova(): the engine's ATOM bomb under the page's H-BOMB overlay (TurboHBomb)
 * The engine runs on the main thread (no worker) so these window hooks reach it.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { brandedRocket } from "@/lib/decal";
import { BASE_PATH, withBase } from "@/lib/base-path";
import { AMMO_TIERS } from "@/lib/flight/ammoTiers";
import { paperCurve } from "@/lib/flight/paperCurve";

export interface TurboFx {
  open: boolean; pending: boolean; side: "long" | "short" | null; lev: number; danger: number; dive: boolean;
  liqMcap?: number; liqLabel?: string;
}
export interface TurboFlightHandle {
  /** Altitude target (engine alt units, see lib/turbo/flight.ts). */
  setAlt(alt: number): void;
  setFx(fx: TurboFx): void;
  ignite(): void;
  supernova(bombs: boolean): void;
  /** The engine's pixels per altitude unit (engine.js PX_PER_ALT), for lib/turbo/flight.ts. */
  pxPerAlt(): number | undefined;
  /** Engine alt → its mcap scale (for the liquidation line). */
  altToMcap(alt: number): number | null;
  ready(): boolean;
}

type Engine = { PX_PER_ALT?: number; altToMcap?: (a: number) => number; bomb?: (k: string, o?: unknown) => void; S?: Record<string, unknown>; source?: { stop?: () => void } };
type W = Window & { __flight?: Engine; __turboFeed?: ((e: unknown) => void) | null; __turboFx?: TurboFx; Q_OVERRIDE?: URLSearchParams | null; __rocketDecal?: unknown };

const TurboFlight = forwardRef<TurboFlightHandle, { className?: string }>(function TurboFlight({ className }, ref) {
  const wrap = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "live" | "error">("loading");
  const pendingAlt = useRef<number | null>(null);
  const seeded = useRef(false);

  useImperativeHandle(ref, () => ({
    setAlt(alt) {
      const w = window as W, f = w.__flight, feed = w.__turboFeed;
      if (!f?.altToMcap || !feed) { pendingAlt.current = alt; return; }
      const mcap = f.altToMcap(alt);
      if (!(mcap > 0)) return;
      feed(seeded.current ? { t: "mark", mcap } : { t: "swap", block: 0, ts: Date.now(), txHash: "(turbo)", side: "buy", usd: 0, mcap, price: mcap / 1e6, mine: true });
      seeded.current = true;
    },
    setFx(fx) { (window as W).__turboFx = fx; },
    ignite() { const S = (window as W).__flight?.S; if (S) { S.buyBoost = 1; S.thrustT = S.t; } },
    supernova(bombs) { if (bombs) try { (window as W).__flight?.bomb?.("atom", { usd: 0 }); } catch { /* cosmetic */ } },
    pxPerAlt() { const v = (window as W).__flight?.PX_PER_ALT; return typeof v === "number" && v > 0 ? v : undefined; },
    altToMcap(alt) { const f = (window as W).__flight; return f?.altToMcap ? f.altToMcap(alt) : null; },
    ready() { return status === "live"; },
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
    Object.assign(window, { __DISCIPLE_BASE_PATH__: BASE_PATH, __AMMO_TIERS: AMMO_TIERS, __PAPER_CURVE: paperCurve() });
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
      // the engine's source starts on load; seed altitude as soon as the feed exists
      const tryFeed = () => { if (cancelled) return; if (w.__turboFeed && w.__flight?.altToMcap) { const a = pendingAlt.current ?? 4.5; pendingAlt.current = null;
        const mcap = w.__flight.altToMcap(a); w.__turboFeed({ t: "swap", block: 0, ts: Date.now(), txHash: "(turbo)", side: "buy", usd: 0, mcap, price: mcap / 1e6, mine: true }); seeded.current = true; }
        else setTimeout(tryFeed, 50); };
      tryFeed();
    };
    s.onerror = () => { if (!cancelled) setStatus("error"); };
    document.body.appendChild(s);
    return () => {
      cancelled = true;
      try { w.__flight?.source?.stop?.(); } catch { /* ignore */ }
      // a later engine run takes a new generation (engine.js @gen) so this run's listeners and loop go quiet
      (window as unknown as { __flightGen?: number }).__flightGen = ((window as unknown as { __flightGen?: number }).__flightGen || 0) + 1;
      s.remove(); cv.remove(); fade.remove();
      w.Q_OVERRIDE = null; w.__turboFeed = null;
      seeded.current = false;
    };
  }, []);

  return (
    <div ref={wrap} id="wrap" className={className} data-testid="turbo-flight" data-status={status} style={{ position: "relative", overflow: "hidden" }}>
      {status !== "live" && <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--dsc-muted)", fontSize: 13 }}>
        {status === "error" ? "The flight view didn't load. Trading still works." : "Loading the flight…"}</div>}
    </div>
  );
});
export default TurboFlight;
