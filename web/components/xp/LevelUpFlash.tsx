"use client";
/**
 * Level up (Grok clip B4): a cream starburst over the screen when a level lands while the app is open, on the same beat as
 * the level_up sting (lib/xpClient fires LEVEL_UP_EVENT). Overlay on black, screen-blended, never takes a tap.
 */
import { useEffect, useState } from "react";
import AnimClip from "@/components/ui/AnimClip";
import { LEVEL_UP_EVENT } from "@/lib/xpClient";

export default function LevelUpFlash() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const on = () => setN((x) => x + 1);
    window.addEventListener(LEVEL_UP_EVENT, on);
    return () => window.removeEventListener(LEVEL_UP_EVENT, on);
  }, []);
  if (!n) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 90, pointerEvents: "none", display: "grid", placeItems: "center", mixBlendMode: "screen" }} aria-hidden data-testid="levelup-flash">
      <AnimClip key={n} id="B4-levelup" ratio="none" overlay maxMs={3000} onEnd={() => setN(0)}
        style={{ width: "min(80vmin, 640px)", height: "min(80vmin, 640px)", WebkitMaskImage: "radial-gradient(closest-side, #000 70%, transparent)", maskImage: "radial-gradient(closest-side, #000 70%, transparent)" }} />
    </div>
  );
}
