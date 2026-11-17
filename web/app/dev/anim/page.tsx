"use client";
/** Debug page: /dev/anim?show=loading|launch|lift|orbit|nuke|crate-<rarity>|bomb-<0..5>|levelup|tradeup|error. Mounts each Grok clip spot on its own. Not linked. */
import { useEffect, useState } from "react";
import Loading from "@/app/loading";
import { LaunchIgnition } from "@/components/create/LaunchLive";
import OrbitFlash from "@/components/flight/OrbitFlash";
import BombFlash from "@/components/flight/BombFlash";
import { LEVEL_UP_EVENT } from "@/lib/xpClient";
import TurboHBomb from "@/components/turbo/TurboHBomb";
import AnimClip from "@/components/ui/AnimClip";
import PageError from "@/app/error";

export default function DevAnim() {
  const [show, setShow] = useState("");
  useEffect(() => { setShow(new URLSearchParams(location.search).get("show") || "loading"); }, []);
  useEffect(() => {
    if (show === "orbit") window.dispatchEvent(new CustomEvent("disciple:sfx", { detail: { k: "orbit" } }));
    if (show.startsWith("bomb-")) setTimeout(() => window.dispatchEvent(new CustomEvent("disciple:sfx", { detail: { k: "bomb", tier: +show.slice(5), fx: 0.5, fy: 0.55 } })), 100);
    if (show === "levelup") setTimeout(() => window.dispatchEvent(new Event(LEVEL_UP_EVENT)), 100);
  }, [show]);
  const bg = { position: "fixed" as const, inset: 0, background: "linear-gradient(#0b1630,#05070d)" };
  if (show === "loading") return <Loading />;
  if (show === "launch" || show === "lift") return <LaunchIgnition name="Moon Dog" ticker="MDOG" mode="Easy" modeColor="#5FF0A0" phase={show === "lift" ? "lifting" : "signing"} />;
  if (show === "orbit") return <div style={bg}><OrbitFlash /></div>;
  if (show.startsWith("bomb-")) return <div style={bg}><BombFlash /></div>;
  if (show === "levelup") return <div style={bg} />;   /* the app layout mounts LevelUpFlash */
  if (show === "nuke") return <div style={bg}><TurboHBomb short={false} label="NUKED" onDone={() => {}} /></div>;
  if (show === "error") return <PageError error={new Error("dev")} reset={() => {}} />;
  if (show === "tradeup") return (
    <div className="hgu-cine"><AnimClip id="D2-tradeup-burn" ratio="none" overlay className="hgu-cine-clip" maxMs={60_000} /></div>
  );
  if (show.startsWith("crate-")) return (
    <div className="hgu-cine"><AnimClip id={`D1-${show}`} ratio="none" overlay className="hgu-cine-clip" maxMs={60_000} /></div>
  );
  return null;
}
