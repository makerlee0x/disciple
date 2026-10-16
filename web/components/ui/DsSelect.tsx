"use client";

import { useEffect, useId, useRef, useState } from "react";

export type DsOption = { value: string; label: string; hint?: string };

/** Themed dropdown (dark/navy + gold) — replaces native <select> so no OS menu / system blue. */
export default function DsSelect({ value, options, onChange, ariaLabel, className = "" }: {
  value: string; options: DsOption[]; onChange: (v: string) => void; ariaLabel?: string; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const cur = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  useEffect(() => { if (open) setHi(Math.max(0, options.findIndex((o) => o.value === value))); }, [open, options, value]);

  const pick = (v: string) => { onChange(v); setOpen(false); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return setOpen(false);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return setOpen(true);
      setHi((h) => (h + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (open && options[hi]) pick(options[hi].value); else setOpen(true);
    }
  };

  return (
    <div ref={ref} className={`ds-select ${open ? "open" : ""} ${className}`}>
      <button type="button" className="ds-input ds-select-btn" aria-haspopup="listbox" aria-expanded={open}
        aria-controls={id} aria-label={ariaLabel} onClick={() => setOpen((o) => !o)} onKeyDown={onKey}>
        <span className="ds-select-label">{cur ? cur.label : "—"}</span>
        {cur?.hint && <span className="ds-select-hint">{cur.hint}</span>}
        <span className="ds-select-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <ul id={id} role="listbox" className="ds-select-menu">
          {options.map((o, i) => (
            <li key={o.value} role="option" aria-selected={o.value === value}
              className={`${o.value === value ? "sel" : ""} ${i === hi ? "hi" : ""}`}
              onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); pick(o.value); }}>
              <span className="ds-select-check" aria-hidden>{o.value === value ? "✓" : ""}</span>
              <span className="ds-select-label">{o.label}</span>
              {o.hint && <span className="ds-select-hint">{o.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
