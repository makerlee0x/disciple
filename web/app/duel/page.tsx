"use client";
/** /duel: Trading Duel on its own, as a guest (no sign-in): play a bot, or send a friend a duel link. Play fuel only.
 *  It's also what plays inside the X timeline (maker 2026-11-16): /vs/<pilot> links carry an X player card that frames
 *  /duel?embed=1&first=1, so a tap on the post starts a bot duel right in the feed. Bot duels need no server session
 *  (third-party cookies are often blocked in a frame), and a slim bar links out to the full game, with the challenger's
 *  ref when there is one. */
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

const DuelScreen = dynamic(() => import("@/components/turbo/duel/DuelScreen"), { ssr: false });

export default function DuelOnlyPage() {
  const [out, setOut] = useState<string | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    let framed = false;
    try { framed = window.top !== window.self; } catch { framed = true; }
    if (q.get("embed") !== "1" && !framed) return;
    const vs = q.get("vs"), ref = q.get("ref");
    const to = new URL(vs && /^[a-z0-9_]{1,42}$/i.test(vs) ? `/vs/${vs}` : "/turbo/duel", location.origin);
    if (ref && /^0x[0-9a-fA-F]{40}$/.test(ref)) to.searchParams.set("ref", ref.toLowerCase());
    setOut(to.toString());
  }, []);
  return (
    <>
      <DuelScreen guest />
      {out && (
        <a href={out} target="_blank" rel="noopener" data-testid="duel-embed-out"
          style={{ position: "fixed", top: 8, right: 8, zIndex: 80, padding: "6px 10px", borderRadius: 10, background: "rgba(18,19,39,.85)", border: "1px solid rgba(243,223,168,.5)", color: "#F3DFA8", font: "700 13px/1 var(--dsc-font-game, sans-serif)", letterSpacing: ".5px", textTransform: "uppercase", textDecoration: "none" }}>
          Play ranked ↗
        </a>
      )}
    </>
  );
}
