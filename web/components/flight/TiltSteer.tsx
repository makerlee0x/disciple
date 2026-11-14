"use client";
/**
 * Tilt to steer (maker 2026-11-14; Settings → Tilt to steer, off by default). Phones only: tilting left / right sets a steering
 * target across the sky (disciple:tilt {x}, engine.js @tilt), which frees both thumbs for the lever and tricks. A finger
 * on the sky still wins while it's down. iOS asks for motion access the first time it's turned on (requestTiltAccess, called
 * from the switch's tap, since iOS only asks inside a tap).
 */
import { useEffect } from "react";
import { useGameSettings } from "@/lib/game/settings";
import { tiltToX } from "@/lib/flight/feel";


type DOE = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<"granted" | "denied"> };
/** Ask iOS for motion access (no-op elsewhere). Call from a tap. */
export async function requestTiltAccess(): Promise<boolean> {
  if (typeof window === "undefined" || typeof DeviceOrientationEvent === "undefined") return false;
  const D = DeviceOrientationEvent as DOE;
  if (typeof D.requestPermission !== "function") return true;
  try { return (await D.requestPermission()) === "granted"; } catch { return false; }
}

export default function TiltSteer() {
  const { tilt } = useGameSettings();
  useEffect(() => {
    if (!tilt || typeof window === "undefined") return;
    const phone = () => document.documentElement.classList.contains("ap-phone");
    let x = 0;
    const send = (v: number | null) => dispatchEvent(new CustomEvent("disciple:tilt", { detail: { x: v } }));
    const on = (e: DeviceOrientationEvent) => {
      if (!phone() || e.gamma == null) return;
      // landscape is locked out in the app; in a browser held sideways, beta is the left-right axis
      const ang = typeof screen !== "undefined" && screen.orientation && /landscape/.test(screen.orientation.type) ? (e.beta ?? 0) * (screen.orientation.angle === 90 ? -1 : 1) : e.gamma;
      x += (tiltToX(ang) - x) * 0.35;   // smooth the sensor
      send(Math.abs(x) < 0.01 ? 0 : x);
    };
    addEventListener("deviceorientation", on);
    return () => { removeEventListener("deviceorientation", on); send(null); };
  }, [tilt]);
  return null;
}
