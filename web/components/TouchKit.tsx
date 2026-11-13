"use client";
/* Phone feel, installed once for every route (mobile plan 2026-11-13). Renders nothing.
   - Haptics on taps and engine moments (lib/game/haptics.ts).
   - Flight routes (/coin/…, /flight/…): html.ap-flight turns off pull-to-refresh, rubber-band scroll and the long-press
     text menu (globals.css), and a screen wake lock keeps the phone from dimming mid-flight while the tab is visible. */
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { installHaptics } from "@/lib/game/haptics";
// same rule as Sidebar.isCollapsibleRoute, inlined so this tiny component does not pull the sidebar into its chunk
const isCollapsibleRoute = (p: string) => p.startsWith("/coin/") || p.startsWith("/flight");

type WakeLockSentinelLike = { release: () => Promise<void>; released?: boolean };
type WakeNav = Navigator & { wakeLock?: { request: (t: "screen") => Promise<WakeLockSentinelLike> } };

export default function TouchKit() {
  const pathname = usePathname() || "";
  const flight = isCollapsibleRoute(pathname);
  useEffect(() => installHaptics(), []);
  useEffect(() => {
    if (!flight) return;
    const de = document.documentElement;
    de.classList.add("ap-flight");
    const nav = navigator as WakeNav;
    let lock: WakeLockSentinelLike | null = null, alive = true;
    const acquire = async () => {
      if (!alive || document.hidden || !nav.wakeLock || (lock && !lock.released)) return;
      try { lock = await nav.wakeLock.request("screen"); if (!alive) void lock.release(); } catch { /* not allowed (battery saver, iframe): fine */ }
    };
    const onVis = () => { if (!document.hidden) void acquire(); };
    void acquire();
    // some browsers only grant the lock after a tap
    addEventListener("pointerdown", acquire, { passive: true });
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false; de.classList.remove("ap-flight");
      removeEventListener("pointerdown", acquire);
      document.removeEventListener("visibilitychange", onVis);
      if (lock && !lock.released) void lock.release().catch(() => {});
    };
  }, [flight]);
  return null;
}
