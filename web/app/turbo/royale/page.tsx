"use client";
/**
 * /turbo/royale: Turbo Royale, practice (fake money, 11 labelled bots) on live HYPE / SOL / ETH / BTC charts. Hidden with
 * the rest of Turbo (/turbo?turbo=1 on this device), and held for launch: blank unless ROYALE_ENABLED or ?royale=1 here. The game is the signed-off prototype, shipped as
 * public/turbo/royale/play.html (built by tools/royale/build.mjs from the Trading Duel's own CSS) and shown full screen.
 * This page feeds it live Lighter prices (Hyperliquid as the fallback, lib/turbo/royalePrices) and, behind the hidden Lighter switch, turns your presses into
 * real Lighter orders (lib/lighter/royale).
 */
import { useEffect, useRef, useState } from "react";
import { LIGHTER_PRICE_HOST, streamRoyalePrices } from "@/lib/turbo/royalePrices";
import { lighterPriceHost } from "@/lib/turbo/priceVenue";
import { lighterWanted } from "@/lib/lighter/duel";
import { RoyaleLighter } from "@/lib/lighter/royale";
import { onWallet } from "@/lib/walletState";
import { withBase } from "@/lib/base-path";
import { isTurboEnabled } from "@/lib/turbo/flag";
import { royaleOpenHere } from "@/lib/features";
import { useTurboMusic } from "@/lib/game/turboMusic";
import { trackFunnel } from "@/lib/funnelClient";
import LobbySettings from "@/components/turbo/LobbySettings";

export default function RoyalePage() {
  const [on, setOn] = useState<boolean | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [gear, setGear] = useState(false);
  useTurboMusic();
  useEffect(() => { setOn(isTurboEnabled() && royaleOpenHere()); }, []);   // held for launch: lib/features ROYALE_ENABLED
  // funnel: the first round a browser plays (the game turns its music on when a round starts), lib/funnel TURBO_STEPS
  useEffect(() => {
    const f = (e: MessageEvent) => { if (e.origin === location.origin && e.data?.type === "disciple:music" && e.data.on === true) trackFunnel("royale_join"); };
    window.addEventListener("message", f); return () => window.removeEventListener("message", f);
  }, []);
  useEffect(() => {
    if (!on) return;
    const post = (d: unknown) => { try { frame.current?.contentWindow?.postMessage(d, location.origin); } catch { /* gone */ } };
    // Lighter's own exchange (the one real orders go to) when the server says so, else Lighter main
    let dead = false, stopPx = () => {};
    void lighterPriceHost().then((h) => { if (!dead) stopPx = streamRoyalePrices((px) => post({ type: "disciple:px", px }), 250, h ?? LIGHTER_PRICE_HOST); });
    const stop = () => { dead = true; stopPx(); };
    let wallet: string | null = null;
    const offW = onWallet((a) => { wallet = a; });
    const lx = lighterWanted() ? new RoyaleLighter(() => wallet, (t) => post({ type: "disciple:toast", t })) : null;
    const f = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow) return;
      if (e.data?.type === "disciple:settings") { setGear(true); return; }   // the lobby gear in play.html
      if (e.data?.type !== "disciple:royale") return;
      lx?.handle(e.data);
    };
    window.addEventListener("message", f);
    return () => { stop(); offW(); window.removeEventListener("message", f); void lx?.end(); };
  }, [on]);
  if (!on) return null;
  return (
    <>
    <iframe
      ref={frame}
      title="Turbo Royale"
      src={withBase("/turbo/royale/play.html?v=19")}
      style={{ position: "fixed", inset: 0, width: "100%", height: "100%", border: 0, zIndex: 60, background: "#07080c" }}
      allow="autoplay; web-share; clipboard-write"
    />
    <LobbySettings mode="royale" open={gear} onClose={() => setGear(false)} />
    </>
  );
}
