"use client";
/**
 * Free play: never lose the rocket behind a HUD card (maker 2026-11-16: "the rocket keeps going behind the chart … it gets
 * hidden which is just confusing"). Now that you can fly anywhere, a card the rocket is under (the chart, the crew list,
 * the phone chart header) fades to a ghost and lets the sky show through until the rocket leaves it.
 * Reads the engine's rocket position (window.__flight.S: camX / x, ry, in #wrap CSS px) 10 times a second.
 */
import { useEffect } from "react";

const CARDS = ['[data-testid="desk-chart"]', '[data-testid="chat-dock"]', '[data-testid="phone-header"]', '[data-testid="sim-bar"]'];
type S = { x?: number; camX?: number | null; ry?: number };

export default function RocketClear() {
  useEffect(() => {
    const faded = new Set<HTMLElement>();
    const iv = window.setInterval(() => {
      const st = (window as unknown as { __flight?: { S?: S } }).__flight?.S, wrap = document.getElementById("wrap");
      if (!st || !wrap || typeof st.ry !== "number") return;
      const r = wrap.getBoundingClientRect(), x = r.left + (st.camX ?? st.x ?? r.width / 2), y = r.top + st.ry;
      // the rocket sprite: ~150 px tall above the nozzle, ~60 px wide
      const box = { l: x - 34, r: x + 34, t: y - 150, b: y + 10 };
      for (const sel of CARDS) document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
        const e = el.getBoundingClientRect(), hit = e.width > 0 && box.l < e.right && box.r > e.left && box.t < e.bottom && box.b > e.top;
        if (hit && !faded.has(el)) { faded.add(el); el.style.transition = "opacity .2s ease"; el.style.opacity = "0.22"; el.dataset.rocketUnder = "1"; }
        else if (!hit && faded.has(el)) { faded.delete(el); el.style.opacity = ""; delete el.dataset.rocketUnder; }
      });
    }, 100);
    return () => { window.clearInterval(iv); faded.forEach((el) => { el.style.opacity = ""; delete el.dataset.rocketUnder; }); };
  }, []);
  return null;
}
