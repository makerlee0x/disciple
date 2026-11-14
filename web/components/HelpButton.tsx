"use client";
/**
 * The top bar's "?" (board "Top bar: fewer tabs", option A, maker 2026-11-14): How to play left the tabs, so this opens a
 * small help card with one line on the game, then How to play and Docs. Signed in it sits first in the wallet strip (left
 * of the cash chip); signed out it sits left of Play now on desktop (phones have How to play as a tab). Esc, a click
 * outside or picking a link closes it.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { TOPBAR_POPOVER_EVENT } from "@/components/account/WelcomeToast";

export const HELP_COPY = {
  label: "Help",
  title: "New here?",
  line: "Boost lifts the whole crew. Dump drops a bomb. Cash out before it falls.",
  howToPlay: "How to play",
  docs: "Docs",
} as const;

export default function HelpButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    addEventListener("pointerdown", away); addEventListener("keydown", esc);
    return () => { removeEventListener("pointerdown", away); removeEventListener("keydown", esc); };
  }, [open]);
  const C = HELP_COPY;
  return (
    <span ref={root} className={`lb-help${className ? ` ${className}` : ""}`}>
      <button type="button" className={`lb-help-btn${open ? " on" : ""}`} aria-label={C.label} aria-expanded={open} aria-haspopup="dialog" onClick={() => { if (!open) dispatchEvent(new Event(TOPBAR_POPOVER_EVENT)); setOpen((v) => !v); }} data-testid="topbar-help">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6" /><circle cx="12" cy="17" r=".6" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <span className="lb-help-pop" role="dialog" aria-label={C.title} data-testid="help-card">
          <b>{C.title}</b>
          <span>{C.line}</span>
          <Link href="/how-it-works" className="lb-help-l" onClick={() => setOpen(false)}>{C.howToPlay}</Link>
          <Link href="/docs" className="lb-help-l" onClick={() => setOpen(false)}>{C.docs}</Link>
        </span>
      )}
    </span>
  );
}
