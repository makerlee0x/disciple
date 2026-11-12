"use client";
/**
 * Mounts "How DISCIPLE works" on demand (the dialog's code loads only when it opens): on window event "dsc:hiw"
 * (sidebar Help). The lobby (brand v3) teaches the four steps on the page itself, so it no longer opens on a first
 * visit. Closing it marks it seen.
 */
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";

export const HIW_SEEN_KEY = "dsc_hiw_seen_v1";
export const HIW_EVENT = "dsc:hiw";
const HowItWorks = dynamic(() => import("./HowItWorks"), { ssr: false });

export default function HowItWorksHost() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const h = () => setOpen(true);
    window.addEventListener(HIW_EVENT, h);
    return () => window.removeEventListener(HIW_EVENT, h);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    try { localStorage.setItem(HIW_SEEN_KEY, "1"); } catch { /* ignore */ }
  }, []);

  return open ? <HowItWorks onClose={close} /> : null;
}
