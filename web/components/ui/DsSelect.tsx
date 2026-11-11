"use client";

import { useEffect, useId, useRef, useState } from "react";
import Icon from "@/components/icons/Icon";

export type DsOption = { value: string; label: string; hint?: string };

/**
 * Themed listbox. Same keyboard model as a Headless UI Listbox (button opens a listbox,
 * arrows move, Enter picks, Escape closes). Replaces a native select so the menu is ours.
 */
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
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  useEffect(() => { if (open) setHi(Math.max(0, options.findIndex((o) => o.value === value))); }, [open, options, value]);
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${id}-opt-${hi}`)?.scrollIntoView({ block: "nearest" });
  }, [open, hi, id]);

  const pick = (v: string) => { onChange(v); setOpen(false); };
  const onKey = (e: React.KeyboardEvent) => {
    if (!options.length) return;
    if (e.key === "Escape") return setOpen(false);
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      if (!open) return setOpen(true);
      setHi((h) => {
        if (e.key === "Home") return 0;
        if (e.key === "End") return options.length - 1;
        return (h + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      });
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (open && options[hi]) pick(options[hi].value); else setOpen(true);
    }
  };

  return (
    <div ref={ref} className={`ds-select ${open ? "open" : ""} ${className}`}>
      <button type="button" className="ds-input ds-select-btn" role="combobox" aria-haspopup="listbox" aria-expanded={open}
        aria-controls={id} aria-activedescendant={open ? `${id}-opt-${hi}` : undefined} aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)} onKeyDown={onKey}>
        <span className="ds-select-label">{cur ? cur.label : "—"}</span>
        {cur?.hint && <span className="ds-select-hint">{cur.hint}</span>}
        <span className="ds-select-caret" aria-hidden><Icon name="chevron-down" size={16} /></span>
      </button>
      {open && (
        <ul id={id} role="listbox" aria-label={ariaLabel} className="ds-select-menu" tabIndex={-1}>
          {options.map((o, i) => (
            <li key={o.value} id={`${id}-opt-${i}`} role="option" aria-selected={o.value === value}
              className={`${o.value === value ? "sel" : ""} ${i === hi ? "hi" : ""}`}
              onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); pick(o.value); }}>
              <span className="ds-select-check" aria-hidden>{o.value === value ? <Icon name="check" size={12} /> : ""}</span>
              <span className="ds-select-label">{o.label}</span>
              {o.hint && <span className="ds-select-hint">{o.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
