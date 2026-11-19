"use client";
/**
 * Cross-link from a rocket's flight page to Trading Duel (maker 2026-11-16: "yes we need cross links good idea"). A small
 * chip in the lower left on desktop: "1v1 duel on BTC", one minute, free. Hidden on phones, where the flight HUD already
 * fills the screen, and inside the iPhone app, which has Duel on its home. Dismiss hides it for the rest of the visit.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { isNativeApp } from "@/lib/native";
import { isTurboEnabled } from "@/lib/turbo/flag";

const KEY = "disciple.duelchip.off";

export default function DuelChip() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let off = false;
    try { off = sessionStorage.getItem(KEY) === "1"; } catch { /* private mode */ }
    setOn(!off && !isNativeApp() && isTurboEnabled());
  }, []);
  // the Flight objectives stack above this chip in the lower left (--ap-duelchip-h)
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = document.documentElement, el = ref.current;
    if (!on || !el) { root.style.removeProperty("--ap-duelchip-h"); return; }
    const pub = () => root.style.setProperty("--ap-duelchip-h", `${Math.ceil(el.getBoundingClientRect().height) + 10}px`);
    pub(); const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(pub) : null; ro?.observe(el);
    return () => { ro?.disconnect(); root.style.removeProperty("--ap-duelchip-h"); };
  }, [on]);
  if (!on) return null;
  const close = () => { try { sessionStorage.setItem(KEY, "1"); } catch { /* private mode */ } setOn(false); };
  return (
    <div ref={ref} className="duel-chip" data-testid="duel-chip">
      <style>{`
        .duel-chip { position: fixed; left: 16px; bottom: 16px; z-index: 30; display: flex; align-items: center; gap: 4px;
          border-radius: 14px; border: 1px solid rgba(255,156,196,.5); background: rgba(18,19,39,.88); backdrop-filter: blur(8px);
          box-shadow: 0 10px 30px rgba(0,0,0,.35); }
        .duel-chip a { display: flex; flex-direction: column; gap: 2px; padding: 10px 6px 10px 14px; color: #F2F3F7; text-decoration: none; }
        .duel-chip b { font: 800 17px/1 var(--dsc-font-game, sans-serif); letter-spacing: .4px; text-transform: uppercase; color: #FF9CC4; }
        .duel-chip span { font: 500 13px/1.2 var(--dsc-font-ui, system-ui, sans-serif); color: #D7D9E4; }
        .duel-chip button { border: 0; background: none; color: rgba(215,217,228,.7); padding: 10px 12px 10px 6px; cursor: pointer; font-size: 16px; line-height: 1; }
        @media (max-width: 760px) { .duel-chip { display: none; } }
      `}</style>
      <Link href="/turbo/duel" prefetch={false}>
        <b>⚔ 1v1 duel on BTC</b>
        <span>One minute, most profit wins. Free.</span>
      </Link>
      <button type="button" aria-label="Hide" onClick={close}>×</button>
    </div>
  );
}
