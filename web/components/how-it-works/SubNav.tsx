"use client";
/**
 * /how-it-works in-page nav: sticky under the chrome strip, plain #anchors (work without JS), the current section is
 * marked with aria-current via IntersectionObserver. On phones it scrolls sideways and keeps the active link in view.
 */
import { useEffect, useRef, useState } from "react";
import { HIW_SUBNAV } from "@/content/how-it-works";
import s from "./subnav.module.css";

export default function SubNav() {
  const [active, setActive] = useState<string>(HIW_SUBNAV.items[0].id);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const els = HIW_SUBNAV.items.map((i) => document.getElementById(i.id)).filter((e): e is HTMLElement => !!e);
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver((es) => {
      for (const e of es) seen.set(e.target.id, e.isIntersecting);
      const first = HIW_SUBNAV.items.find((i) => seen.get(i.id));
      if (first) setActive(first.id);
    }, { rootMargin: "-120px 0px -55% 0px" });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const box = list.current;
    const a = box?.querySelector<HTMLElement>(`a[href="#${active}"]`);
    if (!box || !a || box.scrollWidth <= box.clientWidth) return;
    box.scrollTo({ left: a.offsetLeft - 20, behavior: "auto" });
  }, [active]);

  return (
    <nav className={s.nav} aria-label={HIW_SUBNAV.label}>
      <div ref={list} className={s.list}>
        {HIW_SUBNAV.items.map((i) => (
          <a key={i.id} href={`#${i.id}`} className={s.link} aria-current={active === i.id ? "location" : undefined}>{i.label}</a>
        ))}
      </div>
      {HIW_SUBNAV.docs ? <span className={s.docs}>{HIW_SUBNAV.docs}</span> : null}
    </nav>
  );
}
