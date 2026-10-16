"use client";
import { useEffect, useRef, useState } from "react";

/**
 * TOUCH GRASS — ambient mode: only the rocket, sky, clouds, trail and a faded mcap readout.
 * G toggles, Esc exits, ?grass=1 enables (shareable), state remembered in localStorage.
 * The engine (disciple:grass) stops drawing HUD/fx and ignores trade keys; every React overlay is hidden by
 * the html.ap-grass rule below (visibility, so the sim, chat, PnL etc. keep running underneath).
 */
const KEY = "disciple.grass";
const typing = (t: EventTarget | null) => { const e = t as HTMLElement | null; return !!e && (e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName || "")); };

export default function TouchGrass() {
  const [on, setOn] = useState(false);
  const [hint, setHint] = useState(false);
  const onRef = useRef(on); onRef.current = on;

  useEffect(() => {
    const q = new URLSearchParams(location.search).get("grass");
    let init = false; try { init = localStorage.getItem(KEY) === "1"; } catch { /* */ }
    if (q === "1") init = true; else if (q === "0") init = false;
    setOn(init);
  }, []);
  useEffect(() => {
    const push = () => dispatchEvent(new CustomEvent("disciple:grass", { detail: { on } }));
    push(); try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* */ }
    document.documentElement.classList.toggle("ap-grass", on);
    const t = setTimeout(() => dispatchEvent(new Event("resize")), 30);   // canvas goes full-bleed (rail hidden)
    addEventListener("disciple:ammo", push);   // engine (re)booted after us → resend
    return () => { clearTimeout(t); removeEventListener("disciple:ammo", push); };
  }, [on]);
  useEffect(() => () => document.documentElement.classList.remove("ap-grass"), []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === "KeyG" && !e.repeat) { e.preventDefault(); setOn((v) => !v); }
      else if (e.code === "Escape" && onRef.current) setOn(false);
    };
    const tg = () => setOn((v) => !v);
    addEventListener("keydown", k); addEventListener("disciple:grass-toggle", tg);
    return () => { removeEventListener("keydown", k); removeEventListener("disciple:grass-toggle", tg); };
  }, []);
  // faint corner icon + cursor only on mouse move; both fade after 2.5 s of stillness
  useEffect(() => {
    if (!on) { setHint(false); return; }
    let t = 0 as unknown as ReturnType<typeof setTimeout>;
    const mv = () => { setHint(true); clearTimeout(t); t = setTimeout(() => setHint(false), 2500); };
    addEventListener("pointermove", mv); return () => { removeEventListener("pointermove", mv); clearTimeout(t); };
  }, [on]);

  return (
    <>
      {on && <button type="button" className="ap-grass-ui" data-testid="grass-exit" aria-label="Exit Touch Grass" title="Exit Touch Grass (G / Esc)" onClick={() => setOn(false)}
        style={{ position: "fixed", right: 16, bottom: 16, zIndex: 80, cursor: "pointer", width: 34, height: 34, borderRadius: "50%", border: "1px solid rgba(255,255,255,.18)",
          background: "rgba(0,0,0,.18)", color: "rgba(255,255,255,.75)", fontSize: 14, opacity: hint ? 0.55 : 0, transition: "opacity .6s", pointerEvents: hint ? "auto" : "none" }}>🌿</button>}
      <style>{`
        html.ap-grass body { visibility: hidden; }
        html.ap-grass .flight-wrap, html.ap-grass .flight-wrap *, html.ap-grass .ap-grass-ui { visibility: visible; }
        html.ap-grass .flight-wrap { left: 0 !important; z-index: 70 !important; }
        html.ap-grass .flight-wrap * { cursor: ${hint ? "default" : "none"}; }
        html.ap-grass body { cursor: ${hint ? "default" : "none"}; }
      `}</style>
    </>
  );
}

/** Small pill for the bottom-centre pill row (next to '? CONTROLS'). */
export function TouchGrassPill() {
  return <button type="button" className="ap-pill" data-testid="grass-toggle" title="Touch Grass: ambient rocket, mcap only (G)"
    onClick={() => dispatchEvent(new Event("disciple:grass-toggle"))}>🌿 GRASS · G</button>;
}
