"use client";
/**
 * NUKE: the liquidation overlay on top of the engine's ATOM bomb.
 * Sequence (~6 s): hull white-hot → short freeze → implosion → white-out → shockwave + second ring → star-collapse
 * glow with debris → scorched sky → onDone (the share card). Bombs off ⇒ a short (~1.2 s) version that still makes the
 * liquidation obvious. Purely cosmetic: it never blocks a tap (pointer-events: none).
 */
import { useEffect, useRef, useState } from "react";
import AnimClip from "@/components/ui/AnimClip";
import s from "./turbo.module.css";

export default function TurboHBomb({ short, label, onDone }: { short: boolean; label: string; onDone: () => void }) {
  const done = useRef(onDone); done.current = onDone;   // the parent re-renders on every price tick: never restart the timer
  useEffect(() => { const id = setTimeout(() => done.current(), short ? 1200 : 6000); return () => clearTimeout(id); }, [short]);
  // C6 starts at the implosion (22% of 6 s) so its flash lands on the CSS white-out
  const [boom, setBoom] = useState(false);
  useEffect(() => { if (short) return; const id = setTimeout(() => setBoom(true), 1320); return () => clearTimeout(id); }, [short]);
  return (
    <div className={`${s.nova} ${short ? s.novaShort : s.novaHasClip}`} aria-live="assertive" data-testid="turbo-h-bomb">
      <div className={s.novaCore} />
      <div className={s.novaWhite} />
      <div className={s.novaRing} />
      <div className={`${s.novaRing} ${s.novaRing2}`} />
      <div className={s.novaScorch} />
      {/* the mushroom cloud (Grok clip C6), timed so its flash lands on the white-out; skipped in the short version */}
      {!short && <AnimClip id="C6-nuke" ratio="none" overlay paused={!boom} className={s.novaClip} maxMs={4000} />}
      <div className={s.novaLabel}>{label}</div>
    </div>
  );
}
