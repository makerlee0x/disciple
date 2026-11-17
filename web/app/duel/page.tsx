"use client";
/** /duel: Trading Duel on its own, as a guest (no sign-in): play a bot, or send a friend a duel link. Play fuel only.
 *  It's also what plays inside the X timeline (maker 2026-11-16): /vs/<pilot> links carry an X player card that frames
 *  /duel?embed=1. It opens on a "Tap to play" screen (X blocks sound until a tap), and the tap starts a bot duel right
 *  in the feed. next.config.mjs lets x.com and twitter.com frame this route. Bot duels need no server session
 *  (third-party cookies are often blocked in a frame), and a slim bar links out to the full game, with the challenger's
 *  ref when there is one. */
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

const DuelScreen = dynamic(() => import("@/components/turbo/duel/DuelScreen"), { ssr: false });

export default function DuelOnlyPage() {
  const [out, setOut] = useState<string | null>(null);
  const [embed, setEmbed] = useState(false);
  const [go, setGo] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    let framed = false;
    try { framed = window.top !== window.self; } catch { framed = true; }
    if (q.get("embed") !== "1" && !framed) { setGo(true); return; }
    setEmbed(true);
    const vs = q.get("vs"), ref = q.get("ref");
    const to = new URL(vs && /^[a-z0-9_]{1,42}$/i.test(vs) ? `/vs/${vs}` : "/turbo/duel", location.origin);
    if (ref && /^0x[0-9a-fA-F]{40}$/.test(ref)) to.searchParams.set("ref", ref.toLowerCase());
    setOut(to.toString());
  }, []);
  // the tap: the duel mounts as a first run (host.first, ?first=1), so it goes straight into a rookie bot match with sound
  const start = () => {
    const u = new URL(location.href); u.searchParams.set("first", "1"); history.replaceState(history.state, "", u.toString());
    setGo(true);
  };
  if (embed && !go) return (
    <button type="button" onClick={start} data-testid="duel-embed-tap"
      style={{ position: "fixed", inset: 0, width: "100%", border: 0, padding: 24, background: "#0B0C0E url(/og/duel-square.jpg) center / cover", color: "#F2F3F7", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", gap: 10 }}>
      <span style={{ font: "800 34px/1 var(--dsc-font-game, sans-serif)", textTransform: "uppercase", textShadow: "0 4px 20px rgba(0,0,0,.8)" }}>1v1 trading duel</span>
      <span style={{ padding: "14px 34px", borderRadius: 14, background: "#F2C14E", color: "#121327", font: "800 24px/1 var(--dsc-font-game, sans-serif)", letterSpacing: 1, textTransform: "uppercase" }}>Tap to play</span>
      <span style={{ fontSize: 13, color: "#D7D9E4", textShadow: "0 2px 8px rgba(0,0,0,.9)" }}>One minute on live BTC. Free, no sign-up.</span>
    </button>
  );
  if (!go) return null;
  return (
    <>
      <DuelScreen guest embed={embed} />
      {out && (
        <a href={out} target="_blank" rel="noopener" data-testid="duel-embed-out"
          style={{ position: "fixed", top: 150, left: 12, zIndex: 80, padding: "6px 10px", borderRadius: 10, background: "rgba(18,19,39,.85)", border: "1px solid rgba(243,223,168,.5)", color: "#F3DFA8", font: "700 13px/1 var(--dsc-font-game, sans-serif)", letterSpacing: ".5px", textTransform: "uppercase", textDecoration: "none" }}>
          Play ranked ↗
        </a>
      )}
    </>
  );
}
