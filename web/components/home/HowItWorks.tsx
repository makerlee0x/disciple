"use client";
/**
 * First-visit "How DISCIPLE works" (BRAND app-home r1, mock C; copy approved by lee). Opened by HowItWorksHost:
 * automatically once per visitor on the home page, and any time from Help in the sidebar.
 * Accessible dialog: aria-modal + labelled/described, focus moves in and is trapped, Esc / ✕ / backdrop / the primary
 * button (and "How it works →", which navigates to /how-it-works) close it, focus returns to where it was.
 */
import { useEffect, useRef } from "react";
import Link from "next/link";
import { withBase } from "@/lib/base-path";
import Icon from "@/components/icons/Icon";
import HowItWorksSteps from "./HowItWorksSteps";
import s from "./howItWorks.module.css";

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function HowItWorks({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    box.current?.focus({ preventScroll: true }); // the dialog itself; Tab moves to ✕ / To the moon
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key !== "Tab" || !box.current) return;
      const f = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current || !box.current.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !box.current.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.({ preventScroll: true });
    };
  }, [onClose]);

  return (
    <div className={s.ov} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className={s.card} role="dialog" aria-modal="true" tabIndex={-1} aria-labelledby="hiw-title" aria-describedby="hiw-steps">
        <div className={s.hd} style={{ backgroundImage: `url(${withBase("/home/hiw-header.webp")})` }}>
          <button type="button" className={s.close} onClick={onClose} aria-label="Close How DISCIPLE works"><Icon name="close" size={16} /></button>
          <div className={s.hdTxt}>
            <span className={s.eyebrow}>First flight</span>
            <h2 id="hiw-title" className={s.title}>How DISCIPLE works</h2>
          </div>
        </div>
        <div className={s.body}>
          <HowItWorksSteps id="hiw-steps" />
          <div className={s.foot}>
            <button type="button" className={`${s.btn} ${s.pri}`} onClick={onClose}>To the moon</button>
            <Link className={s.btn} href="/how-it-works" prefetch={false} onClick={onClose}>How it works →</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
