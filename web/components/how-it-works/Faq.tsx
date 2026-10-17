"use client";
/**
 * /how-it-works FAQ accordion (WAI-ARIA accordion pattern): each question is an <h3> wrapping a <button> with
 * aria-expanded / aria-controls; answers are labelled regions. Enter/Space toggle (native button), ↑/↓ move between
 * questions, Home/End jump to the first/last. Every answer starts open to match the mock (and is in the HTML for
 * no-JS and search); any can be collapsed.
 */
import { useRef, useState, type KeyboardEvent } from "react";
import Icon from "@/components/icons/Icon";
import { HIW_FAQ } from "@/content/how-it-works";
import s from "./faq.module.css";

export default function Faq() {
  const [open, setOpen] = useState<boolean[]>(() => HIW_FAQ.items.map(() => true));
  const btns = useRef<(HTMLButtonElement | null)[]>([]);
  const n = HIW_FAQ.items.length;

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const to = e.key === "ArrowDown" ? (i + 1) % n : e.key === "ArrowUp" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    btns.current[to]?.focus();
  };

  return (
    <div className={s.faq}>
      {HIW_FAQ.items.map((it, i) => (
        <div key={it.q} className={s.q}>
          <h3 className={s.h}>
            <button
              ref={(el) => { btns.current[i] = el; }}
              type="button"
              id={`hiw-faq-q${i}`}
              className={s.btn}
              aria-expanded={open[i]}
              aria-controls={`hiw-faq-a${i}`}
              onClick={() => setOpen((o) => o.map((v, k) => (k === i ? !v : v)))}
              onKeyDown={(e) => onKey(e, i)}
            >
              <Icon name="chevron-down" size={16} className={s.chev} />
              <span>{it.q}</span>
            </button>
          </h3>
          <div id={`hiw-faq-a${i}`} role="region" aria-labelledby={`hiw-faq-q${i}`} className={s.a} hidden={!open[i]}>
            <p>{it.a}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
