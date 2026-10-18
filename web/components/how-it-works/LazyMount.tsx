"use client";
/**
 * Mounts below-the-fold visuals (charts) only when they come near the viewport (IntersectionObserver, 400px margin).
 * Reserves space with `minHeight` (kept after mount, so a late-arriving dynamic chunk can't shift anything either). Falls back to rendering at once without IntersectionObserver.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

export default function LazyMount({ children, minHeight, className }: { children: ReactNode; minHeight: number | string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") { setOn(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setOn(true); io.disconnect(); } }, { rootMargin: "400px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} className={className} style={{ minHeight }}>{on ? children : null}</div>;
}
