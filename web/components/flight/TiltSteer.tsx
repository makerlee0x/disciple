"use client";
/**
 * Tilt to steer (phone setting, maker 2026-11-14 option 3). Reads the phone's left/right tilt (DeviceOrientationEvent.gamma) and
 * sends the engine disciple:tilt {g} with g ∈ [-1, 1]: the rocket heads for that share of the sky, through the same steering spring
 * a finger drag uses (a finger on the sky still wins). The neutral angle is however you hold the phone when the flight starts
 * (or when you turn tilt on). Off: sends {g: null} once.
 * iOS asks for motion access, and only allows the ask from a tap: requestTilt() is called from the settings switch, and again on
 * the first touch of a flight if access has not been granted in this session.
 */
import { useEffect } from "react";
import { useGameSettings } from "@/lib/game/settings";

export const TILT_RANGE_DEG = 22, TILT_DEAD_DEG = 2.5;
type Req = { requestPermission?: () => Promise<"granted" | "denied" | "default"> };

/** Ask for motion access (must run inside a user gesture on iOS). true = granted, or nothing to ask. */
export async function requestTilt(): Promise<boolean> {
  if (typeof window === "undefined" || typeof DeviceOrientationEvent === "undefined") return false;
  const D = DeviceOrientationEvent as unknown as Req;
  if (typeof D.requestPermission !== "function") return true;
  try { return (await D.requestPermission()) === "granted"; } catch { return false; }
}

/** Pure: tilt angle (deg) relative to neutral → steering share in [-1, 1] with a dead zone. Tested in scripts/test-tilt.mts. */
export function tiltShare(gamma: number, neutral: number): number {
  const d = gamma - neutral;
  if (!Number.isFinite(d) || Math.abs(d) < TILT_DEAD_DEG) return 0;
  const v = (Math.abs(d) - TILT_DEAD_DEG) / (TILT_RANGE_DEG - TILT_DEAD_DEG);
  return Math.sign(d) * Math.min(1, v);
}

export default function TiltSteer() {
  const { tilt } = useGameSettings();
  useEffect(() => {
    const send = (g: number | null) => dispatchEvent(new CustomEvent("disciple:tilt", { detail: { g } }));
    if (!tilt || !document.documentElement.classList.contains("ap-phone")) { send(null); return; }
    let neutral: number | null = null, sm = 0, got = false, asked = false;
    const onOri = (e: DeviceOrientationEvent) => {
      if (typeof e.gamma !== "number") return;
      got = true;
      if (neutral === null) neutral = e.gamma;
      sm += (tiltShare(e.gamma, neutral) - sm) * 0.35;   // light smoothing: sensor jitter, not lag
      send(Math.abs(sm) < 0.02 ? 0 : sm);
    };
    // no readings yet (access not granted this session): ask on the first touch, which iOS counts as a gesture
    const onTouch = () => { if (got || asked) return; asked = true; void requestTilt(); };
    addEventListener("deviceorientation", onOri);
    addEventListener("pointerdown", onTouch, true);
    return () => { removeEventListener("deviceorientation", onOri); removeEventListener("pointerdown", onTouch, true); send(null); };
  }, [tilt]);
  return null;
}
