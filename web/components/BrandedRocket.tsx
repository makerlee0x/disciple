"use client";

import { useEffect, useRef, useState } from "react";
import { brandedRocket } from "@/lib/decal";
import { withBase } from "@/lib/base-path";

/** Small rocket preview with token decal; base chrome shows until the decal cross-fades in. */
/** Per-icon composite cache — the launchpad renders many rockets sharing a few icons. */
const CACHE = new Map<string, ReturnType<typeof brandedRocket>>();
const cached = (icon?: string | null) => { const k = icon ?? ""; let p = CACHE.get(k); if (!p) { p = brandedRocket(icon); CACHE.set(k, p); if (CACHE.size > 400) CACHE.delete(CACHE.keys().next().value as string); } return p; };

export default function BrandedRocket({ icon, height = 80, className }: { icon?: string | null; height?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    setReady(false);
    cached(icon).then(({ canvas }) => {
      const c = ref.current;
      if (!alive || !c) return;
      try {
        c.width = canvas.width; c.height = canvas.height;
        c.getContext("2d")!.drawImage(canvas, 0, 0);
        setReady(true);
      } catch { /* tainted canvas */ }
    });
    return () => { alive = false; };
  }, [icon]);
  const w = (height * 73) / 200;
  return (
    <span className={className} style={{ position: "relative", display: "inline-block", width: w, height }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={withBase("/assets/rocket.png")} alt="" style={{ position: "absolute", inset: 0, width: w, height }} />
      <canvas ref={ref} aria-label="branded rocket" style={{ position: "absolute", inset: 0, width: w, height, opacity: ready ? 1 : 0, transition: "opacity .3s" }} />
    </span>
  );
}
