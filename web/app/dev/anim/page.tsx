"use client";
/** Debug page: /dev/anim?show=loading|launch|lift|orbit|nuke|crate-<rarity>. Mounts each Grok clip spot on its own. Not linked. */
import { useEffect, useState } from "react";
import Loading from "@/app/loading";
import { LaunchIgnition } from "@/components/create/LaunchLive";
import OrbitFlash from "@/components/flight/OrbitFlash";
import TurboHBomb from "@/components/turbo/TurboHBomb";
import AnimClip from "@/components/ui/AnimClip";

export default function DevAnim() {
  const [show, setShow] = useState("");
  useEffect(() => { setShow(new URLSearchParams(location.search).get("show") || "loading"); }, []);
  useEffect(() => { if (show === "orbit") window.dispatchEvent(new CustomEvent("disciple:sfx", { detail: { k: "orbit" } })); }, [show]);
  const bg = { position: "fixed" as const, inset: 0, background: "linear-gradient(#0b1630,#05070d)" };
  if (show === "loading") return <Loading />;
  if (show === "launch" || show === "lift") return <LaunchIgnition name="Moon Dog" ticker="MDOG" mode="Easy" modeColor="#5FF0A0" phase={show === "lift" ? "lifting" : "signing"} />;
  if (show === "orbit") return <div style={bg}><OrbitFlash /></div>;
  if (show === "nuke") return <div style={bg}><TurboHBomb short={false} label="NUKED" onDone={() => {}} /></div>;
  if (show.startsWith("crate-")) return (
    <div className="hgu-cine"><AnimClip id={`D1-${show}`} ratio="none" overlay className="hgu-cine-clip" maxMs={60_000} /></div>
  );
  return null;
}
