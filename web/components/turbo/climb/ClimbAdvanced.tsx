"use client";
/**
 * The Turbo popup's Advanced record (fills and cash moves, read from Lighter; components/turbo/TurboCashBody) on the
 * Climb level select and the result screens (maker 2026-11-20: "we should add the advanced fills and history on these
 * pages"). Real money only: Simulator runs place no orders. A fold under the lobby panel, open state kept per browser;
 * it reloads each time a result shows, so the run's own fills are there.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Advanced } from "@/components/turbo/TurboCashBody";
import { gaslessSigner, onWallet } from "@/lib/wallet";

const OPEN_KEY = "disciple.climb.adv.v1";

export default function ClimbAdvanced({ root, real }: { root: HTMLElement | null; real: boolean }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [show, setShow] = useState(false);
  const [n, setN] = useState(0);
  const [addr, setAddr] = useState<string | null>(null);
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(OPEN_KEY) === "1"; } catch { return false; } });
  useEffect(() => onWallet((a) => setAddr(a ?? null)), []);

  useEffect(() => {
    const side = root?.querySelector(".pre-side"), panel = side?.querySelector(".panel");
    const lv = root?.querySelector<HTMLElement>("#climb"), cr = root?.querySelector<HTMLElement>("#cres");
    if (!side || !panel || !lv || !cr) { setSlot(null); return; }
    const el = document.createElement("div");
    el.className = "cl-adv"; panel.after(el); setSlot(el);
    let resWas = false;
    const vis = () => {
      const res = !cr.hidden && cr.dataset.k === "res";
      setShow(!lv.hidden);   // the result card lists the run's own fills (RunFills)
      if (res && !resWas) setN((k) => k + 1);   // a new result: read the record again
      resWas = res;
    };
    const mo = new MutationObserver(vis);
    [lv, cr].forEach((p) => mo.observe(p, { attributes: true, attributeFilter: ["hidden", "data-k"] }));
    vis();
    return () => { mo.disconnect(); el.remove(); setSlot(null); };
  }, [root]);

  const owner = addr ? (gaslessSigner()?.address ?? addr).toLowerCase() : null;
  if (!slot || !show || !real || !owner) return null;
  const flip = () => { const v = !open; setOpen(v); try { localStorage.setItem(OPEN_KEY, v ? "1" : "0"); } catch { /* private mode */ } };
  return createPortal(
    <section className="cl-advbox" data-testid="climb-advanced">
      <button type="button" className="cl-advh" aria-expanded={open} onClick={flip}>
        <span>Advanced</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: open ? "rotate(180deg)" : undefined }}><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && <Advanced key={n} wallet={owner} />}
    </section>,
    slot,
  );
}
