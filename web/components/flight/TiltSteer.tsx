"use client";
/**
 * Tilt to steer (phone setting, maker 2026-11-14 option 3). Reads the phone's left/right tilt (gravity via DeviceMotionEvent, see rollDeg) and
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
  const M = (typeof DeviceMotionEvent !== "undefined" ? DeviceMotionEvent : undefined) as unknown as Req | undefined;
  // iOS gates motion (gravity, used for steering) and orientation separately: ask for both inside the same tap
  try {
    // both asks start synchronously in the tap (an await in between would lose the gesture on iOS)
    const asks: Promise<string>[] = [];
    if (typeof M?.requestPermission === "function") asks.push(M.requestPermission());
    if (typeof D.requestPermission === "function") asks.push(D.requestPermission());
    return (await Promise.all(asks)).every((x) => x === "granted");
  } catch { return false; }
}

/**
 * Pure: the phone's left/right roll in degrees (+ = right side down) from the gravity vector (DeviceMotionEvent
 * accelerationIncludingGravity, m/s²). Used instead of DeviceOrientationEvent.gamma, which is unreliable when the phone is
 * held upright the way people play (gamma jumps near beta 90°, so tilting left read as right: TestFlight build 1 feedback).
 * Works whichever sign convention the browser uses for the axes (iOS reports them opposite to the spec): the roll's sign is
 * taken relative to the axis gravity mostly lies on (y when upright, z when flat). Tested in scripts/test-tilt.mts.
 */
export function rollDeg(gx: number, gy: number, gz: number): number {
  if (![gx, gy, gz].every(Number.isFinite)) return NaN;
  const ref = Math.abs(gy) >= Math.abs(gz) ? gy : gz, conv = ref < 0 ? -1 : 1;
  const s = Math.max(-1, Math.min(1, (-conv * gx) / 9.81));
  return (Math.asin(s) * 180) / Math.PI;
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
    let neutral: number | null = null, sm = 0, got = false, asked = false, gravity = false;
    const feed = (deg: number) => {
      if (!Number.isFinite(deg)) return;
      got = true;
      if (neutral === null) neutral = deg;
      sm += (tiltShare(deg, neutral) - sm) * 0.35;   // light smoothing: sensor jitter, not lag
      send(Math.abs(sm) < 0.02 ? 0 : sm);
    };
    // gravity first (reliable upright); orientation gamma only if this device never sends motion events
    const onMotion = (e: DeviceMotionEvent) => {
      const g = e.accelerationIncludingGravity;
      if (!g || g.x == null || g.y == null || g.z == null) return;
      if (!gravity) { gravity = true; neutral = null; }
      feed(rollDeg(g.x, g.y, g.z));
    };
    const onOri = (e: DeviceOrientationEvent) => { if (!gravity && typeof e.gamma === "number") feed(e.gamma); };
    // no readings yet (access not granted this session): ask on the first touch, which iOS counts as a gesture
    const onTouch = () => { if (got || asked) return; asked = true; void requestTilt(); };
    addEventListener("devicemotion", onMotion);
    addEventListener("deviceorientation", onOri);
    addEventListener("pointerdown", onTouch, true);
    return () => { removeEventListener("devicemotion", onMotion); removeEventListener("deviceorientation", onOri); removeEventListener("pointerdown", onTouch, true); send(null); };
  }, [tilt]);
  return null;
}
