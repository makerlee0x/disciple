"use client";
import Icon from "@/components/ui/Icon";
import { useEffect, useRef, useState } from "react";

/**
 * TOUCH GRASS — ambient mode: only the rocket, sky, clouds, trail and a faded mcap readout.
 * G toggles (or Display → Touch Grass in the ESC settings menu), Esc exits, ?grass=1 enables (shareable), state remembered in localStorage.
 * The readout is "$TICKER · $8.8K MCAP" (engine drawGrass; ticker = the coin page's ?cs call sign).
 * The engine (disciple:grass) stops drawing HUD/fx and ignores trade keys; every React overlay is hidden by
 * the html.ap-grass rule below (visibility, so the sim, chat, PnL etc. keep running underneath).
 */
const KEY = "disciple.grass";
/** v2: cinematic camera is the default in Touch Grass (the old disciple.grass.cine "off" from testing is ignored/removed). */
const CINE_KEY = "disciple.grass.cine.v2";
const typing = (t: EventTarget | null) => { const e = t as HTMLElement | null; return !!e && (e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName || "")); };

export default function TouchGrass() {
  const [on, setOn] = useState(false);
  const [hint, setHint] = useState(false);
  const [cine, setCine] = useState(true);   // cinematic camera: default on; ?cinecam=0 or the 🎥 button turns it off (remembered)
  const onRef = useRef(on); onRef.current = on;

  useEffect(() => {
    const q = new URLSearchParams(location.search).get("grass");
    let init = false; try { init = localStorage.getItem(KEY) === "1"; } catch { /* */ }
    if (q === "1") init = true; else if (q === "0") init = false;
    setOn(init);
    const c = new URLSearchParams(location.search).get("cinecam"); let ci = true; try { ci = localStorage.getItem(CINE_KEY) !== "0"; } catch { /* */ }
    setCine(c === "1" ? true : c === "0" ? false : ci);
  }, []);
  useEffect(() => {
    const push = () => dispatchEvent(new CustomEvent("disciple:grass", { detail: { on, cine } }));
    push(); try { localStorage.setItem(KEY, on ? "1" : "0"); localStorage.setItem(CINE_KEY, cine ? "1" : "0"); localStorage.removeItem(KEY + ".cine"); } catch { /* */ }
    document.documentElement.classList.toggle("ap-grass", on);
    const t = setTimeout(() => dispatchEvent(new Event("resize")), 30);   // canvas goes full-bleed (rail hidden)
    addEventListener("disciple:ammo", push);   // engine (re)booted after us → resend
    return () => { clearTimeout(t); removeEventListener("disciple:ammo", push); };
  }, [on, cine]);
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
      {on && <div className="ap-grass-ui ap-grass-tl" data-hint={hint ? "1" : "0"} style={{ position: "fixed", left: 16, top: 16, zIndex: 80, display: "flex", gap: 8 }}>
        <button type="button" data-testid="grass-exit" aria-label="Exit Touch Grass" title="Exit Touch Grass (G / Esc)" onClick={() => setOn(false)}><Icon name="close" size={14} /></button>
        <button type="button" data-testid="grass-cine" aria-pressed={cine} aria-label="Cinematic camera" title={`Cinematic camera: ${cine ? "on" : "off"}`}
          onClick={() => setCine((v) => !v)} style={{ fontSize: 12 }}><Icon name={cine ? "video" : "video-off"} size={14} /></button>
      </div>}
      <style>{`
        html.ap-grass body { visibility: hidden; }
        html.ap-grass .flight-wrap, html.ap-grass .flight-wrap *, html.ap-grass .ap-grass-ui { visibility: visible; }
        html.ap-grass .flight-wrap { left: 0 !important; z-index: 70 !important; }
        html.ap-grass .flight-wrap * { cursor: ${hint ? "default" : "none"}; }
        .ap-grass-tl button { all: unset; box-sizing: border-box; cursor: pointer; width: 32px; height: 32px; display: grid; place-items: center; border-radius: 50%;
          font: 14px system-ui, sans-serif; color: #fff; background: rgba(0,0,0,.22); border: 1px solid rgba(255,255,255,.25);
          opacity: .14; transition: opacity .5s, background .3s; }
        .ap-grass-tl[data-hint="1"] button { opacity: .5; }
        .ap-grass-tl button:hover, .ap-grass-tl button:focus-visible { opacity: 1; background: rgba(0,0,0,.45); }
        .ap-grass-tl button:focus-visible { outline: 2px solid #c8ffd8; outline-offset: 2px; }
        html.ap-grass body { cursor: ${hint ? "default" : "none"}; }
      `}</style>
    </>
  );
}
