"use client";
/** "How Turbo works": the crypto detail kept off the main surfaces (Nova, Hyperliquid, Arbitrum, fees, funding). */
import { useEffect } from "react";
import { TURBO_COPY as C } from "@/lib/turbo/copy";
import s from "./turbo.module.css";

export default function TurboHowItWorks({ onClose }: { onClose: () => void }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);
  return (
    <div className={s.dim} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={C.howItWorks} className={s.sheet} data-testid="turbo-how">
        <button type="button" className={s.x} aria-label="Close" onClick={onClose}>×</button>
        <h2 className={s.sheetTitle}>{C.howItWorks}</h2>
        {C.howBody.map((p, i) => <p key={i} className={s.howP}>{p}</p>)}
      </div>
    </div>
  );
}
