/** Run `fn` once the page has painted: after window load, then the next idle slot (rIC, timeout-capped). Returns a cancel. */
export function afterPaint(fn: () => void, idleTimeout = 1200): () => void {
  let done = false, idleId = 0, t: ReturnType<typeof setTimeout> | null = null;
  const run = () => { if (!done) { done = true; fn(); } };
  const idle = () => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    if (w.requestIdleCallback) idleId = w.requestIdleCallback(run, { timeout: idleTimeout });
    else t = setTimeout(run, 200);
  };
  if (document.readyState === "complete") idle();
  else window.addEventListener("load", idle, { once: true });
  return () => {
    done = true;
    window.removeEventListener("load", idle);
    const w = window as Window & { cancelIdleCallback?: (id: number) => void };
    if (idleId && w.cancelIdleCallback) w.cancelIdleCallback(idleId);
    if (t) clearTimeout(t);
  };
}

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
