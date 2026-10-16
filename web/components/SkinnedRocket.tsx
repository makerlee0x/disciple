"use client";

import { useEffect, useRef, useState } from "react";
import { skinnedRocket } from "@/lib/rocketSkin";
import { withBase } from "@/lib/base-path";

/** Rocket sprite with a body skin + nose coin applied; re-composites whenever either changes. */
export default function SkinnedRocket({ skin, coin, height = 200 }: { skin: string; coin: string; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    skinnedRocket(skin, coin).then((cv) => {
      const c = ref.current;
      if (!alive || !c) return;
      c.width = cv.width; c.height = cv.height;
      const g = c.getContext("2d")!;
      g.clearRect(0, 0, c.width, c.height);
      g.drawImage(cv, 0, 0);
      setReady(true);
    }).catch(() => {});
    return () => { alive = false; };
  }, [skin, coin]);
  const w = (height * 73) / 200;
  return (
    <span style={{ position: "relative", display: "inline-block", width: w, height }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {!ready && <img src={withBase("/assets/rocket.png")} alt="" style={{ position: "absolute", inset: 0, width: w, height }} />}
      <canvas ref={ref} aria-label={`${skin} rocket`} style={{ position: "absolute", inset: 0, width: w, height }} />
    </span>
  );
}
