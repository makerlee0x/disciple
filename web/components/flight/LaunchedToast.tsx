"use client";
/**
 * Right after a launch (Launch page → flight, no share screen in between): the flight fades in from the liftoff flash,
 * and a small "you're live" toast sits at the top with Share on X and Copy link. It never covers the trade bar or
 * takes focus, closes itself after a while, and the full share card stays in the flight menu (ESC → Share).
 */
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { withBase } from "@/lib/base-path";
import { takeLaunchHandoff, type LaunchHandoff } from "@/lib/launchHandoff";
import s from "./launchedToast.module.css";

/** How long the toast stays up untouched. Hovering or using it keeps it up. */
const AUTO_CLOSE_MS = 14_000;

export default function LaunchedToast({ token }: { token: string }) {
  const [h, setH] = useState<LaunchHandoff | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [held, setHeld] = useState(false);
  const took = useRef(false);   // the note is read once, so React's dev double-effect can't lose it

  useEffect(() => {
    if (took.current) return;
    took.current = true;
    const note = takeLaunchHandoff(token);
    if (!note) return;
    setH(note);
    setOpen(true);
  }, [token]);

  useEffect(() => {
    if (!open || held) return;
    const t = window.setTimeout(() => setOpen(false), AUTO_CLOSE_MS);
    return () => window.clearTimeout(t);
  }, [open, held]);

  if (!h) return null;
  // blur after a click so Space / Enter keep flying the rocket instead of pressing the button again
  const done = (e: MouseEvent<HTMLButtonElement>) => e.currentTarget.blur();
  const url = `${window.location.origin}${withBase(`/coin/${token}`)}`;
  const share = () => {
    setHeld(true);
    const text = `$${h.ticker} just lifted off on Disciple. Get aboard early: ${url}`;
    window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
  };
  const copy = async () => {
    setHeld(true);
    try { await navigator.clipboard.writeText(url); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { /* clipboard blocked */ }
  };

  return (
    <>
      <div className={s.arrive} aria-hidden data-testid="launch-arrive" />
      {open && (
        <div className={s.toast} role="status" data-testid="launched-toast"
          onMouseEnter={() => setHeld(true)} onFocus={() => setHeld(true)}>
          <span className={s.live}>Live</span>
          <div className={s.txt}>
            <b>${h.ticker} is flying</b>
            <span>{h.note ?? "You're the host. Every trade pays you a cut."}</span>
          </div>
          <button type="button" className={s.x} onClick={(e) => { done(e); share(); }} data-testid="share-x" tabIndex={-1}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M17.5 3h3.2l-7 8 8.3 10h-6.5l-5-6.2L4.8 21H1.6l7.5-8.6L1.2 3h6.6l4.6 5.7L17.5 3z" /></svg>
            Share
          </button>
          <button type="button" className={s.btn} onClick={(e) => { done(e); void copy(); }} data-testid="copy-link" tabIndex={-1}>{copied ? "Copied" : "Copy link"}</button>
          <button type="button" className={s.close} onClick={() => setOpen(false)} aria-label="Close" tabIndex={-1}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
      )}
    </>
  );
}
