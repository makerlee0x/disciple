"use client";

import { cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { placeTooltip } from "@/lib/tooltipPlace";

/**
 * One tooltip for SITE titles / badges (profile title, verified mark, achievement badges, identity sigils).
 * Desktop: opens on hover and on keyboard focus, closes on leave / blur / Esc. Never on click.
 * Touch (no hover): a tap shows it, a tap anywhere outside closes it.
 * Rendered in a portal with position: fixed, placed above the trigger (flips below when there's no room) and shifted to
 * stay inside the viewport; the arrow follows the trigger. Styled with BRAND v2 tokens (.ds-tip in globals.css).
 * The child must be a single element that can take a ref (span / button / img).
 */
export default function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactElement; side?: "top" | "bottom" }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number; arrow: number; side: "top" | "bottom" } | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const tip = useRef<HTMLDivElement>(null);
  const lastPointer = useRef<string>("mouse");
  const id = useId();

  const place = useCallback(() => {
    const t = trigger.current, b = tip.current;
    if (!t || !b) return;
    const r = t.getBoundingClientRect();
    setPos(placeTooltip({ left: r.left, top: r.top, width: r.width, height: r.height }, { width: b.offsetWidth, height: b.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight }, side));
  }, [side]);

  useLayoutEffect(() => { if (open) place(); else setPos(null); }, [open, place, content]);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const outside = (e: PointerEvent) => { if (!trigger.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", esc);
    return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", esc); };
  }, [open]);

  if (!content || !isValidElement(children)) return children;
  type P = Record<string, unknown> & { ref?: unknown };
  const child = children as ReactElement<P>;
  const chain = (name: string, fn: (e: never) => void) => (e: never) => { (child.props[name] as ((e: never) => void) | undefined)?.(e); fn(e); };
  const trig = cloneElement(child, {
    ref: (el: HTMLElement | null) => { trigger.current = el; const r = (child as unknown as { ref?: unknown }).ref; if (typeof r === "function") r(el); else if (r && typeof r === "object") (r as { current: unknown }).current = el; },
    "aria-describedby": open ? id : undefined,
    tabIndex: child.props.tabIndex ?? (typeof child.type === "string" && !["button", "a", "input"].includes(child.type) ? 0 : undefined),
    title: undefined,
    onPointerDown: chain("onPointerDown", (e: PointerEvent) => { lastPointer.current = e.pointerType; }),
    onPointerEnter: chain("onPointerEnter", (e: PointerEvent) => { if (e.pointerType === "mouse" || e.pointerType === "pen") setOpen(true); }),
    onPointerLeave: chain("onPointerLeave", (e: PointerEvent) => { if (e.pointerType === "mouse" || e.pointerType === "pen") setOpen(false); }),
    onFocus: chain("onFocus", () => { if (lastPointer.current !== "touch") setOpen(true); }),
    onBlur: chain("onBlur", () => setOpen(false)),
    onClick: chain("onClick", (e: MouseEvent) => {
      // Touch only: tap toggles (no hover on phones). Mouse clicks never toggle it.
      if (lastPointer.current === "touch") { setOpen((o) => !o); e.stopPropagation(); }
      lastPointer.current = "mouse";
    }),
  });
  return (
    <>
      {trig}
      {open && typeof document !== "undefined" && createPortal(
        <div ref={tip} id={id} role="tooltip" className={`ds-tip ds-tip-${pos?.side ?? side}`} data-testid="tooltip"
          style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, ["--ds-tip-arrow" as string]: `${pos?.arrow ?? 0}px`, visibility: pos ? "visible" : "hidden" }}>
          {content}
        </div>, document.body)}
    </>
  );
}
