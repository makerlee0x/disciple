"use client";
/**
 * /turbo/royale: Turbo Royale, practice only (fake money, 11 labelled bots, simulated charts). Hidden with the rest of
 * Turbo (/turbo?turbo=1 on this device). The game is the signed-off prototype, shipped as public/turbo/royale/play.html
 * (built by tools/royale/build.mjs from the Trading Duel's own CSS) and shown full screen.
 */
import { useEffect, useState } from "react";
import { withBase } from "@/lib/base-path";
import { isTurboEnabled } from "@/lib/turbo/flag";
import { useTurboMusic } from "@/lib/game/turboMusic";

export default function RoyalePage() {
  const [on, setOn] = useState<boolean | null>(null);
  useTurboMusic();
  useEffect(() => { setOn(isTurboEnabled()); }, []);
  if (!on) return null;
  return (
    <iframe
      title="Turbo Royale"
      src={withBase("/turbo/royale/play.html?v=6")}
      style={{ position: "fixed", inset: 0, width: "100%", height: "100%", border: 0, zIndex: 60, background: "#07080c" }}
      allow="autoplay; web-share; clipboard-write"
    />
  );
}
