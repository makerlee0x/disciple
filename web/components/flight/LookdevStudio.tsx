"use client";

import { useEffect, useRef, useState } from "react";
import { DEFAULT_HDRI, HDRIS, type HdriId } from "@/lib/flight/lookdev/studio";

/** Look-dev studio: the authored 3D chrome rocket (left) beside the official sprite at the same on-screen height (right).
 *  Desktop first. The 3D module is dynamically imported so three.js never lands in another route's bundle. */
export default function LookdevStudio() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hdri, setHdri] = useState<HdriId>(DEFAULT_HDRI);
  const [status, setStatus] = useState("loading…");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const search = window.location.search;
    const q = new URLSearchParams(search).get("hdri");
    if (q && q in HDRIS) setHdri(q as HdriId);
    let dispose: (() => void) | null = null, dead = false;
    import("@/lib/flight/lookdev/studio")
      .then((m) => m.startLookdev(canvas, search))
      .then((d) => { if (dead) d(); else { dispose = d; setStatus(window.__lookdev?.backend === "webgpu" ? "WebGPU" : "WebGL 2"); } })
      .catch((e) => { console.error("[lookdev]", e); setStatus("failed: " + String(e?.message || e)); });
    return () => { dead = true; dispose?.(); };
  }, []);

  const h = HDRIS[hdri];
  const pick = (id: HdriId) => {
    const u = new URL(window.location.href); u.searchParams.set("hdri", id); u.searchParams.delete("exposure"); u.searchParams.delete("envrot");
    window.location.assign(u.toString());
  };

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-[#0b0b14] text-[#c9c9d3]" data-testid="lookdev">
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <canvas ref={canvasRef} className="block h-full w-full" data-testid="lookdev-canvas" />
          <div className="pointer-events-none absolute left-4 top-3 text-xs uppercase tracking-[0.2em] opacity-70">3D · authored GLB · {status}</div>
        </div>
        <div className="relative flex min-w-0 flex-1 items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element -- the reference sprite at its native pixels, unoptimised on purpose */}
          <img src="/assets/rocket-hi.webp" alt="Official DISCIPLE rocket sprite" className="h-[80.6%] w-auto select-none" draggable={false} data-testid="lookdev-sprite" />
          <div className="pointer-events-none absolute left-4 top-3 text-xs uppercase tracking-[0.2em] opacity-70">Official sprite · rocket-hi.webp</div>
        </div>
      </div>
      <div className="flex items-center gap-3 border-t border-white/10 px-4 py-2 text-xs">
        <span className="opacity-60">HDRI</span>
        {(Object.keys(HDRIS) as HdriId[]).map((id) => (
          <button key={id} type="button" onClick={() => pick(id)}
            className={`rounded px-2 py-1 ${id === hdri ? "bg-white/15 text-white" : "hover:bg-white/10"}`}>
            {HDRIS[id].title} <span className="opacity-50">({HDRIS[id].kind})</span>
          </button>
        ))}
        <span className="ml-auto opacity-60" data-testid="lookdev-credit">
          Lighting: <a className="underline" href={h.url} target="_blank" rel="noreferrer">{h.title}</a> by {h.author} ·{" "}
          <a className="underline" href={h.license.url} target="_blank" rel="noreferrer">{h.license.name}</a> · ACES filmic + bloom
        </span>
      </div>
    </div>
  );
}
