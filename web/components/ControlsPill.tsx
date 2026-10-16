"use client";

import { useEffect, useRef, useState } from "react";

/**
 * '? CONTROLS' pill (bottom-centre pill row) + popover with the key map and the live MODE line (mode, pending, points).
 * Replaces the always-on canvas MODE panel: on mount it tells the engine (disciple:controlsdock) to stop drawing it, and
 * the engine streams the panel's live values here (disciple:controls, ≤4 Hz on change). Hotkeys: / or F1 (not while typing).
 * Collapsed by default, state remembered; auto-opens once for first-time players.
 */
type Ctl = { mode: string; key: string; shot: string; pending: number; max: number; turbo: boolean | null; orbs: boolean; score: number; streak: number; mult: number };
const typingTarget = (t: EventTarget | null) => { const el = t as HTMLElement | null; return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)); };
const KEYS: [string, string, string?][] = [
  ["SPACE", "boost: buy the selected $ (custom $ wins) · hold = turbo", "#9ff3c8"], ["SHIFT", "dump: sell the selected % (custom sell wins)", "#ffb0c8"], ["P", "position tag on rocket", "#ffe7a3"], ["G", "touch grass: ambient, mcap only (Esc exits)", "#c8ffd8"], ["Z X C V", "select sell 10% · 25% · 50% · 100% (no trade; SHIFT dumps)", "#ffb0c8"],
  ["1–6", "buy that $ preset now (+ select)"], ["click preset", "select only (then BOOST / DUMP)"], ["W / ↑", "boost (hold)"], ["A / D", "steer (idle 1.5 s ⇒ re-centres)"], ["O", "orbs on/off"], ["B", "bombs on/off"],
  ["ENTER", "chat"], ["H", "chat ↔ holders"], ["/ or F1", "this help"],
];

export default function ControlsPill({ simulator = false }: { simulator?: boolean }) {
  const [open, setOpenS] = useState(false);
  const [c, setC] = useState<Ctl | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const setOpen = (v: boolean | ((o: boolean) => boolean)) => setOpenS((o) => { const n = typeof v === "function" ? v(o) : v; try { localStorage.setItem("disciple.controls.open", n ? "1" : "0"); } catch { /* */ } return n; });
  useEffect(() => { try { const v = localStorage.getItem("disciple.controls.open"); setOpenS(v === null ? true : v === "1"); } catch { /* */ } }, []);   // first visit: shown once
  useEffect(() => {
    let got = false; const on = (e: Event) => { got = true; setC((e as CustomEvent<Ctl>).detail); };
    addEventListener("disciple:controls", on);
    const dock = () => dispatchEvent(new CustomEvent("disciple:controlsdock", { detail: { docked: true } }));
    dock(); const iv = window.setInterval(() => { if (!got) dock(); }, 2000);   // engine may boot after us
    return () => { removeEventListener("disciple:controls", on); clearInterval(iv); dispatchEvent(new CustomEvent("disciple:controlsdock", { detail: { docked: false } })); };
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (typingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === "F1" || (e.code === "Slash" && !e.shiftKey)) { e.preventDefault(); setOpen((o) => !o); }
      else if (e.code === "Escape") setOpen(false); };
    const out = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpenS((o) => { if (o) try { localStorage.setItem("disciple.controls.open", "0"); } catch { /* */ } return false; }); };
    addEventListener("keydown", k); addEventListener("pointerdown", out);
    return () => { removeEventListener("keydown", k); removeEventListener("pointerdown", out); };
  }, []);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" data-testid="controls-pill" className="ap-pill" title="Controls (/ or F1)" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        style={{ color: open ? "#151830" : undefined, background: open ? "#ffe7a3" : undefined }}>
        ? CONTROLS{c ? ` · ${c.mode}` : ""}
      </button>
      {open && (
        <div data-testid="controls-pop" role="dialog" aria-label="Controls"
          style={{ position: "absolute", bottom: "calc(100% + 8px)", left: 0, width: 300, padding: "10px 12px", borderRadius: 12, zIndex: 40,
            background: "rgba(10,12,28,.92)", border: "1px solid rgba(255,231,163,.45)", color: "#e8ecff", font: "11px/1.5 ui-monospace,monospace", boxShadow: "0 8px 24px rgba(0,0,0,.45)" }}>
          {c && <div style={{ fontWeight: 800, color: "#fff", marginBottom: 6 }}>BUY {c.shot}/shot <span style={{ opacity: 0.6, fontWeight: 400 }}>[{c.key}]</span></div>}
          {KEYS.filter(([k]) => !(simulator && (k === "ENTER" || k === "H"))).map(([k, d, col]) => (
            <div key={k} style={{ display: "flex", gap: 8 }}><b style={{ minWidth: 96, color: col || "#ffe7a3" }}>{k}</b><span style={{ opacity: 0.9 }}>{d}</span></div>))}
          {c && <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid rgba(255,255,255,.1)", opacity: 0.9 }}>
            pending {c.pending}/{c.max}{c.turbo !== null ? ` · T turbo ${c.turbo ? "ON" : "off"}` : ""}
            {c.orbs && <span style={{ color: "#ffe7a3" }}> · POINTS {c.score} · streak {c.streak}{c.mult > 1 ? ` ×${c.mult}` : ""}</span>}
          </div>}
        </div>
      )}
    </div>
  );
}
