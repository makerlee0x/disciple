"use client";

import { useEffect, useRef, useState } from "react";
import { brandedRocket } from "@/lib/decal";

/** Small rocket preview with token decal; base chrome shows until the decal cross-fades in. */
export default function BrandedRocket({ icon, height = 80, className }: { icon?: string | null; height?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    setReady(false);
    brandedRocket(icon).then(({ canvas }) => {
      const c = ref.current;
      if (!alive || !c) return;
      c.width = canvas.width; c.height = canvas.height;
      c.getContext("2d")!.drawImage(canvas, 0, 0);
      setReady(true);
    });
    return () => { alive = false; };
  }, [icon]);
  const w = (height * 73) / 200;
  return (
    <span className={className} style={{ position: "relative", display: "inline-block", width: w, height }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/assets/rocket.png" alt="" style={{ position: "absolute", inset: 0, width: w, height }} />
      <canvas ref={ref} aria-label="branded rocket" style={{ position: "absolute", inset: 0, width: w, height, opacity: ready ? 1 : 0, transition: "opacity .3s" }} />
    </span>
  );
}
