"use client";
/**
 * Mounts "How DISCIPLE works" on demand (the dialog's code loads only when it opens):
 *  - once per visitor on the home page (localStorage dsc_hiw_seen_v1), after the hero has painted;
 *  - any time on window event "dsc:hiw" (sidebar Help).
 * Closing it in any way marks it seen.
 */
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { afterPaint } from "./idle";

export const HIW_SEEN_KEY = "dsc_hiw_seen_v1";
export const HIW_EVENT = "dsc:hiw";
const HowItWorks = dynamic(() => import("./HowItWorks"), { ssr: false });

export default function HowItWorksHost() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const h = () => setOpen(true);
    window.addEventListener(HIW_EVENT, h);
    return () => window.removeEventListener(HIW_EVENT, h);
  }, []);

  useEffect(() => {
    if (pathname !== "/") return;
    let seen = true;
    try { seen = localStorage.getItem(HIW_SEEN_KEY) === "1"; } catch { /* storage blocked: don't nag */ }
    if (seen) return;
    return afterPaint(() => setOpen(true), 600);
  }, [pathname]);

  const close = useCallback(() => {
    setOpen(false);
    try { localStorage.setItem(HIW_SEEN_KEY, "1"); } catch { /* ignore */ }
  }, []);

  return open ? <HowItWorks onClose={close} /> : null;
}
