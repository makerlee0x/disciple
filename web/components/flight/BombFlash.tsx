"use client";
/**
 * Dump bomb blasts (Grok clips B3, one per tier GRENADE … NUKE): laid over the engine's own blast at the point it went off.
 * The engine fires disciple:sfx {k:"bomb", tier, fx, fy} with fx/fy as 0..1 of #wrap. Overlay on black, screen-blended,
 * never takes a tap; at most three at once. Reduced motion skips them (AnimClip).
 */
import { useEffect, useRef, useState } from "react";
import AnimClip from "@/components/ui/AnimClip";

const CLIPS = ["grenade", "bunker-buster", "warhead", "moab", "atom-bomb", "nuke"];
/** blast size by tier, as a share of the short side of the screen */
const SIZE = [0.24, 0.32, 0.42, 0.52, 0.64, 0.84];

type Blast = { n: number; tier: number; x: number; y: number; d: number };

export default function BombFlash() {
  const [list, setList] = useState<Blast[]>([]);
  const n = useRef(0);
  useEffect(() => {
    const on = (e: Event) => {
      const d = ((e as CustomEvent).detail || {}) as { k?: string; tier?: number; fx?: number; fy?: number };
      if (d.k !== "bomb" || typeof d.fx !== "number" || typeof d.fy !== "number") return;
      const wrap = document.getElementById("wrap")?.getBoundingClientRect();
      const r = wrap && wrap.width ? wrap : { left: 0, top: 0, width: innerWidth, height: innerHeight };
      const tier = Math.max(0, Math.min(CLIPS.length - 1, Math.round(d.tier || 0)));
      const b = { n: ++n.current, tier, x: r.left + d.fx * r.width, y: r.top + d.fy * r.height, d: Math.min(900, SIZE[tier] * Math.min(innerWidth, innerHeight)) };
      setList((l) => [...l.slice(-2), b]);
    };
    window.addEventListener("disciple:sfx", on);
    return () => window.removeEventListener("disciple:sfx", on);
  }, []);
  if (!list.length) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 55, pointerEvents: "none", overflow: "hidden", mixBlendMode: "screen" }} aria-hidden data-testid="bomb-flash">
      {list.map((b) => (
        <AnimClip key={b.n} id={`B3-bomb-${CLIPS[b.tier]}`} ratio="none" overlay maxMs={3000}
          onEnd={() => setList((l) => l.filter((x) => x.n !== b.n))}
          style={{ position: "absolute", left: b.x - b.d / 2, top: b.y - b.d / 2, width: b.d, height: b.d, WebkitMaskImage: "radial-gradient(closest-side, #000 72%, transparent)", maskImage: "radial-gradient(closest-side, #000 72%, transparent)" }} />
      ))}
    </div>
  );
}
