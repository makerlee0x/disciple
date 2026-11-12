"use client";

/**
 * Create-page rocket preview: the homepage HeroPad idle keyframe (pad, exhaust
 * smoke, smog, slight motion) so the rocket feels about to launch, with the
 * chosen badge on the hull. Not a still staging card.
 */
import { useEffect, useState } from "react";
import HeroPad from "@/components/home/HeroPad";
import { QUICK_LAUNCH_COPY } from "@/lib/quickLaunch";
import s from "./quickLaunch.module.css";

export default function CreatePadPreview({ name, ticker, icon }: { name: string; ticker: string; icon: string | null }) {
  const [go, setGo] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setGo(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div className={s.stage} aria-label="Rocket on the launch pad" data-testid="create-pad-preview">
      <div className={s.stagePad}>
        <HeroPad go={go} launching={false} icon={icon} />
      </div>
      <div className={s.stageTicker}>{ticker ? `$${ticker}` : "$TICKER"}</div>
      <div className={s.stageReady}>{QUICK_LAUNCH_COPY.ready(name)}</div>
    </div>
  );
}
