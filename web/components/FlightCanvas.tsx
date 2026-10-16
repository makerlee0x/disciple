"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { brandedRocket } from "@/lib/decal";
import { BASE_PATH, withBase } from "@/lib/base-path";
import { AMMO_TIERS } from "@/lib/flight/ammoTiers";
import { ACTIVE_CHAIN } from "@/lib/chains";
import { chooseRenderMode, startWorkerRender } from "@/lib/flight/workerBridge";
import GameChat from "@/components/gamechat/GameChat";

declare global {
  interface Window {
    REPLAY?: unknown;
    __flight?: unknown;
    __rocketDecal?: { canvas: HTMLCanvasElement; t0: number; fallback: boolean };
  }
}

type Props = {
  /** Query string without leading ? (replay, speed, zoom, source, launched, …) */
  search: string;
};

/**
 * Mounts the ported prototype flight engine (public/flight/engine.js).
 * Keeps canvas logic largely as-is; loads REPLAY from /replay.json when needed.
 */
export default function FlightCanvas({ search }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Loading flight…");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let scriptEl: HTMLScriptElement | null = null;
    let stopWorker: (() => void) | null = null;
    let cv: HTMLCanvasElement | null = null;
    // The canvas is created per boot (not by React): a canvas can be transferred to a worker only once,
    // and Strict Mode / fallback need a fresh one.
    const freshCanvas = () => {
      cv?.remove();
      cv = document.createElement("canvas");
      cv.id = "c";
      wrapRef.current?.appendChild(cv);
      return cv;
    };
    const bootMain = async () => {
      freshCanvas();
      if (wrapRef.current) wrapRef.current.dataset.render = "main";
      const existing = document.querySelector('script[data-disciple-flight="1"]') as HTMLScriptElement | null;
      if (existing) {
        existing.remove();
        // Engine is an IIFE — remount requires a fresh script after clearing __flight
        delete window.__flight;
      }
      await new Promise<void>((resolve, reject) => {
        scriptEl = document.createElement("script");
        scriptEl.src = withBase("/flight/engine.js");
        scriptEl.dataset.discipleFlight = "1";
        scriptEl.async = false;
        scriptEl.onload = () => resolve();
        scriptEl.onerror = () => reject(new Error("Failed to load flight engine"));
        document.body.appendChild(scriptEl);
      });
    };
    // Worker path: resolves true when the engine is running in the worker, false → caller falls back.
    const bootWorker = (globals: Record<string, unknown>) =>
      new Promise<boolean>((resolve) => {
        const c = freshCanvas();
        if (wrapRef.current) wrapRef.current.dataset.render = "worker";
        let done = false;
        const finish = (ok: boolean, why?: string) => {
          if (done) return; done = true; clearTimeout(to);
          if (!ok) { console.warn("[flight] worker render unavailable, falling back to main thread:", why); stopWorker?.(); stopWorker = null; }
          resolve(ok);
        };
        const to = window.setTimeout(() => finish(false, "worker start timeout"), 10000);
        try {
          stopWorker = startWorkerRender({ canvas: c, wrap: wrapRef.current!, basePath: BASE_PATH, globals,
            onReady: () => finish(true), onError: (m) => (done ? console.error("[flight worker]", m) : finish(false, m)) });
        } catch (e) { finish(false, String(e)); }
      });

    async function boot() {
      try {
        // Sync URL search so engine's location.search / Q reads work if it falls back
        const qs = search.startsWith("?") ? search : search ? `?${search}` : "";
        if (qs && typeof window !== "undefined") {
          const url = new URL(window.location.href);
          const incoming = new URLSearchParams(qs.slice(1));
          incoming.forEach((v, k) => url.searchParams.set(k, v));
          window.history.replaceState({}, "", url.pathname + "?" + url.searchParams.toString());
        }

        const needReplay =
          new URLSearchParams(qs.slice(1)).get("replay") === "1" ||
          new URLSearchParams(qs.slice(1)).get("source") === "replay";

        if (!window.REPLAY) {
          setStatus("Loading replay data…");
          const r = await fetch(withBase("/replay.json"));
          if (!r.ok) throw new Error("Failed to load replay.json");
          window.REPLAY = await r.json();
        } else if (needReplay && !window.REPLAY) {
          /* already handled */
        }

        if (cancelled) return;
        setStatus("Starting engine…");

        // Flight engine loads /assets/* — prefix for githack basePath.
        const globals = {
          __DISCIPLE_BASE_PATH__: BASE_PATH,
          // Ammo preset tiers (single source: lib/flight/ammoTiers.ts) — engine scales its presets from this.
          __AMMO_TIERS: AMMO_TIERS,
          // Simulated market defaults ON for testnet chains (no address hardcoding — chain flag only).
          __DISCIPLE_TESTNET: !!(ACTIVE_CHAIN as { testnet?: boolean }).testnet,
          REPLAY: window.REPLAY,
        };
        Object.assign(window, globals);
        // ?render=main|worker forces a path; default = main; worker is opt-in (?render=worker) and falls back to main if unsupported/failed
        const mode = chooseRenderMode(qs);
        const ok = mode === "worker" && (await bootWorker(globals));
        if (cancelled) return;
        if (!ok) await bootMain();

        if (!cancelled) setStatus("Live");
      } catch (e) {
        if (!cancelled) {
          setErr(String((e as Error).message || e));
          setStatus("Error");
        }
      }
    }

    boot();
    // Token decal loads in parallel with the engine; never blocks flight.
    const icon = new URLSearchParams(search).get("icon");
    brandedRocket(icon).then(({ canvas, fallback }) => {
      if (!cancelled) window.__rocketDecal = { canvas, t0: performance.now(), fallback };
    });

    return () => {
      cancelled = true;
      stopWorker?.();
      cv?.remove();
      // Stop RAF / intervals by reloading is heavy; clear known hooks
      try {
        const src = (window.__flight as { source?: { stop?: () => void } } | undefined)
          ?.source;
        src?.stop?.();
      } catch {
        /* ignore */
      }
    };
  }, [search]);

  // Top-right stacking: the site's wallet strip (top-right, height varies with its state) comes first,
  // then the Share/Exit row, then the in-canvas status column + crew panel. Measured, not hardcoded.
  useEffect(() => {
    let last = -1;
    const tick = () => {
      const w = document.querySelector('[aria-label="wallet"]') as HTMLElement | null;
      const b = w ? Math.ceil(w.getBoundingClientRect().bottom) : 0;
      if (b === last) return;
      last = b;
      const row = Math.max(12, b + 8);
      const hudRT = row + 38 + 10;
      const st = document.documentElement.style;
      st.setProperty("--ap-tr-top", row + "px");
      st.setProperty("--ap-hud-rt", hudRT + "px");
      (window as unknown as { __hudRT?: number }).__hudRT = hudRT;
    };
    tick();
    const id = window.setInterval(tick, 400);
    return () => window.clearInterval(id);
  }, []);

  // Simulated-market toggle (engine owns the state; this just mirrors + flips it).
  const [sim, setSim] = useState<{ on: boolean; mode: string }>({ on: false, mode: "auto" });
  useEffect(() => {
    const on = (e: Event) => setSim((e as CustomEvent).detail);
    window.addEventListener("disciple:simstate", on);
    return () => window.removeEventListener("disciple:simstate", on);
  }, []);
  // SIMULATOR route (?source=sim): the local market is the market — no display-offset toggle
  const isSimulator = new URLSearchParams(search).get("source") === "sim";
  const toggleSim = () =>
    window.dispatchEvent(new CustomEvent("disciple:sim", { detail: { mode: sim.on ? "off" : "on" } }));

  // Live chat overlay: live coin pages only (needs a coin address); in /flight/sim only with ?chatmock=1
  const chatCoin = (() => { const q = new URLSearchParams(search); const coin = q.get("coin") || "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(coin) && !(q.get("source") === "sim" && q.get("chatmock") === "1")) return null;
    if (q.get("source") === "sim" && q.get("chatmock") !== "1") return null;
    return coin || "0x000000000000000000000000000000000000c0de"; })();

  return (
    <>
      <div
        id="wrap"
        ref={wrapRef}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          left: "var(--ap-rail-w, 64px)",
          overflow: "hidden",
        }}
        className="flight-wrap"
      >
      </div>
      <Link
        id="exitX"
        href="/"
        title="Back to Launchpad"
        aria-label="Close flight and return to Launchpad"
        style={{
          position: "fixed",
          top: "var(--ap-tr-top, 12px)",
          right: 12,
          zIndex: 35,
          width: 38,
          height: 38,
          display: "grid",
          placeItems: "center",
          borderRadius: "50%",
          textDecoration: "none",
          font: "bold 18px system-ui,sans-serif",
          color: "#fff7df",
          background: "rgba(10,12,28,.82)",
          border: "1px solid rgba(255,231,163,.7)",
          boxShadow: "0 0 16px rgba(255,220,150,.35)",
        }}
      >
        ✕
      </Link>
      {chatCoin && <GameChat coin={chatCoin} />}
      <div className="ap-bc" style={{ bottom: 142, zIndex: 25, display: "flex", gap: 8 }}>
        <button id="orbBtn" type="button" title="Toggle orbs (O)" className="ap-pill">
          ORBS ON · O
        </button>
        {!isSimulator && <button
          type="button"
          data-testid="sim-toggle"
          title="Simulated market: random buys/sells keep the rocket moving when the pool is quiet. Visual only — never touches balances or PnL."
          onClick={toggleSim}
          className="ap-pill"
          style={{ color: sim.on ? "#d9ccff" : "rgba(220,228,255,.6)", borderColor: sim.on ? "rgba(201,184,255,.7)" : "rgba(255,255,255,.2)" }}
        >
          {sim.on ? "◆ SIMULATED MARKET · ON" : "◇ SIMULATED MARKET · OFF"}
          {sim.mode === "auto" ? " (auto)" : ""}
        </button>}
      </div>
      <div
        id="launchFade"
        style={{
          position: "fixed",
          inset: 0,
          background: "#fff8ea",
          pointerEvents: "none",
          zIndex: 50,
          opacity: 0,
          transition: "opacity .9s ease",
        }}
      />
      {err && (
        <div
          style={{
            position: "fixed",
            bottom: 60,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 40,
            color: "#ff9fb8",
            fontFamily: "ui-monospace,monospace",
            fontSize: 12,
            background: "rgba(10,12,28,.85)",
            padding: "8px 14px",
            borderRadius: 10,
            border: "1px solid rgba(255,150,180,.4)",
          }}
        >
          {err}
        </div>
      )}
      <style jsx global>{`
        body.side-open .flight-wrap {
          left: var(--ap-side-w, 270px) !important;
        }
        .ap-bc {
          position: fixed;
          left: calc(50% + var(--ap-rail-w, 64px) / 2);
          transform: translateX(-50%);
        }
        body.side-open .ap-bc {
          left: calc(50% + var(--ap-side-w, 270px) / 2) !important;
        }
        .ap-pill {
          padding: 6px 12px;
          border-radius: 10px;
          border: 1px solid rgba(255, 231, 163, 0.6);
          background: rgba(10, 12, 28, 0.78);
          color: #ffe7a3;
          font: bold 11px ui-monospace, monospace;
          cursor: pointer;
          letter-spacing: 0.04em;
          white-space: nowrap;
        }
        @media (max-width: 760px) {
          .flight-wrap,
          body.side-open .flight-wrap {
            left: 0 !important;
          }
          .ap-bc,
          body.side-open .ap-bc {
            left: 50% !important;
          }
        }
        #c {
          display: block;
          image-rendering: auto;
        }
        .flight-wrap[data-render="worker"] #c {
          width: 100%;
          height: 100%;
        }
      `}</style>
      <span className="sr-only">{status}</span>
    </>
  );
}
