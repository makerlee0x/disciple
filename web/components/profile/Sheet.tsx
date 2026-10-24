"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * One container for the profile's popups: centred .ds-modal on desktop, bottom sheet on mobile (CSS, ≤720px).
 * Esc / backdrop / close button close it; body scroll is locked (as SettingsModal); Tab is trapped inside; focus returns
 * to the opener on close.
 */
export default function Sheet({ open, onClose, label, className = "", children, testId }: {
  open: boolean; onClose: () => void; label: string; className?: string; children: ReactNode; testId?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key !== "Tab" || !box.current) return;
      const f = Array.from(box.current.querySelectorAll<HTMLElement>("button,a[href],input,select,textarea,[tabindex]:not([tabindex='-1'])")).filter((el) => !el.hasAttribute("disabled"));
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>("[data-autofocus],button")?.focus());
    return () => { window.removeEventListener("keydown", k); document.body.style.overflow = prev; opener?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="ds-modal-backdrop pf-sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className={`ds-modal pf-sheet ${className}`} role="dialog" aria-modal="true" aria-label={label} data-testid={testId}>
        <span className="pf-sheet-handle" aria-hidden />
        {children}
      </div>
    </div>
  );
}
