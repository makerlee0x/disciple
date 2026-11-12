"use client";
/**
 * SUPERNOVA (placeholder name until Brand signs off): the liquidation overlay on top of the engine's ATOM bomb.
 * Sequence (~6 s): hull white-hot → short freeze → implosion → white-out → shockwave + second ring → star-collapse
 * glow with debris → scorched sky → onDone (the share card). Bombs off ⇒ a short (~1.2 s) version that still makes the
 * liquidation obvious. Purely cosmetic: it never blocks a tap (pointer-events: none).
 */
import { useEffect, useRef } from "react";
import s from "./turbo.module.css";

export default function TurboSupernova({ short, label, onDone }: { short: boolean; label: string; onDone: () => void }) {
  const done = useRef(onDone); done.current = onDone;   // the parent re-renders on every price tick: never restart the timer
  useEffect(() => { const id = setTimeout(() => done.current(), short ? 1200 : 6000); return () => clearTimeout(id); }, [short]);
  return (
    <div className={`${s.nova} ${short ? s.novaShort : ""}`} aria-live="assertive" data-testid="turbo-supernova">
      <div className={s.novaCore} />
      <div className={s.novaWhite} />
      <div className={s.novaRing} />
      <div className={`${s.novaRing} ${s.novaRing2}`} />
      <div className={s.novaScorch} />
      <div className={s.novaLabel}>{label}</div>
    </div>
  );
}
