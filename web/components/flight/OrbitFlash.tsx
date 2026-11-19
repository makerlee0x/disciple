"use client";
/**
 * Reaching orbit (Grok clip B2): a pale-blue shock ring and a sunrise flare over the flight, the beat everyone aboard
 * sees. The engine fires disciple:sfx {k:"orbit"} (the same cue FlightSfx plays ath_reached on). Overlay on black,
 * screen-blended; it never takes a tap.
 */
import { useEffect, useState } from "react";
import AnimClip from "@/components/ui/AnimClip";

export default function OrbitFlash() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const on = (e: Event) => { if (((e as CustomEvent).detail || {}).k === "orbit") setN((x) => x + 1); };
    window.addEventListener("disciple:sfx", on);
    return () => window.removeEventListener("disciple:sfx", on);
  }, []);
  if (!n) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, pointerEvents: "none", mixBlendMode: "screen", opacity: 0.55 }} aria-hidden data-testid="orbit-flash">
      <AnimClip key={n} id="B2-orbit" overlay onEnd={() => setN(0)} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
