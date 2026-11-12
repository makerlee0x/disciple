"use client";

/**
 * Full-bleed liftoff overlay for Quick Launch. Reuses the homepage HeroPad
 * animation as a placeholder (r4: mid-flight keyframe of HeroPad).
 */
import { useEffect, useState } from "react";
import HeroPad, { LIFTOFF_MS } from "@/components/home/HeroPad";
import { QUICK_LAUNCH_COPY } from "@/lib/quickLaunch";
import s from "./quickLaunch.module.css";

export { LIFTOFF_MS };

export default function LiftoffOverlay({ onDone }: { onDone?: () => void }) {
  const [go, setGo] = useState(false);
  const [launching, setLaunching] = useState(false);
  useEffect(() => {
    const a = requestAnimationFrame(() => setGo(true));
    const start = window.setTimeout(() => setLaunching(true), 40);
    const done = onDone ? window.setTimeout(onDone, LIFTOFF_MS + 200) : 0;
    return () => { cancelAnimationFrame(a); window.clearTimeout(start); if (done) window.clearTimeout(done); };
  }, [onDone]);
  return (
    <div className={s.liftoff} role="status" aria-live="polite" data-testid="liftoff-overlay">
      <div className={s.liftStage}>
        <HeroPad go={go} launching={launching} />
      </div>
      <div className={s.liftCount}>{QUICK_LAUNCH_COPY.liftoff}</div>
    </div>
  );
}
