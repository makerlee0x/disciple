"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { brandedRocket } from "@/lib/decal";

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
          const r = await fetch("/replay.json");
          if (!r.ok) throw new Error("Failed to load /replay.json");
          window.REPLAY = await r.json();
        } else if (needReplay && !window.REPLAY) {
          /* already handled */
        }

        if (cancelled) return;
        setStatus("Starting engine…");

        // Avoid double-inject on React Strict Mode remount
        const existing = document.querySelector(
          'script[data-disciple-flight="1"]',
        ) as HTMLScriptElement | null;
        if (existing) {
          existing.remove();
          // Engine is an IIFE — remount requires a fresh script after clearing __flight
          delete window.__flight;
        }

        await new Promise<void>((resolve, reject) => {
          scriptEl = document.createElement("script");
          scriptEl.src = "/flight/engine.js";
          scriptEl.dataset.discipleFlight = "1";
          scriptEl.async = false;
          scriptEl.onload = () => resolve();
          scriptEl.onerror = () => reject(new Error("Failed to load flight engine"));
          document.body.appendChild(scriptEl);
        });

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
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        className="flight-wrap"
      >
        <canvas id="c" />
      </div>
      <Link
        id="exitX"
        href="/"
        title="Back to Launchpad"
        aria-label="Close flight and return to Launchpad"
        style={{
          position: "fixed",
          top: 12,
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
      <button
        id="orbBtn"
        type="button"
        title="Toggle orbs (O)"
        style={{
          position: "fixed",
          left: "calc(50% + var(--ap-rail-w, 64px) / 2)",
          bottom: 14,
          transform: "translateX(-50%)",
          zIndex: 5,
          padding: "7px 14px",
          borderRadius: 10,
          border: "1px solid rgba(255,231,163,.6)",
          background: "rgba(10,12,28,.72)",
          color: "#ffe7a3",
          font: "bold 12px ui-monospace,monospace",
          cursor: "pointer",
          letterSpacing: "0.04em",
        }}
      >
        ORBS ON · O
      </button>
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
        body.side-open #orbBtn {
          left: calc(50% + var(--ap-side-w, 270px) / 2) !important;
        }
        @media (max-width: 760px) {
          .flight-wrap,
          body.side-open .flight-wrap {
            left: 0 !important;
          }
          #orbBtn,
          body.side-open #orbBtn {
            left: 50% !important;
          }
        }
        #c {
          display: block;
          image-rendering: auto;
        }
      `}</style>
      <span className="sr-only">{status}</span>
    </>
  );
}
