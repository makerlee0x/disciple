"use client";
/**
 * The restricted-region strip across the top of Duel and Climb (maker 2026-11-19: "make it a banner like lighter or
 * hyperliquid"). It shows when the visitor's country blocks real-money Turbo (lib/turbo/region). The game still runs on
 * play money; real orders are off (lighterWanted) and the server refuses them (app/api/lighter, 451).
 *
 * It sits above the game's own top bar: html.geo-bar moves .duel-root down by the strip's height (--geo-bar). The
 * iPhone app never runs real Turbo, so there's nothing to tell there and it stays hidden.
 */
import { useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/base-path";
import { isNativeApp } from "@/lib/native";
import { turboRegion } from "@/lib/turbo/region";

const CSS = `
.geo-bar-strip{position:fixed;top:0;left:0;right:0;z-index:70;display:flex;align-items:center;justify-content:center;
  padding:calc(8px + env(safe-area-inset-top,0px)) 16px 8px;background:linear-gradient(180deg,#B0162F,#8A0F24);
  border-bottom:1px solid rgba(255,255,255,.12);color:#FFF4F4;font:600 14px/1.35 var(--dsc-font-ui,system-ui,sans-serif);text-align:center}
.geo-bar-strip a{color:inherit;text-decoration:underline;text-underline-offset:3px;white-space:nowrap}
.geo-bar-strip a:focus-visible{outline:2px solid #fff;outline-offset:2px;border-radius:3px}
html.geo-bar .duel-root{top:var(--geo-bar,0px);height:auto}
html.geo-bar .duel-root .stage{top:var(--geo-bar,0px)}
.geo-bar-strip .s{display:none}
@media (max-width:560px){.geo-bar-strip{font-size:13px;padding-left:12px;padding-right:12px}.geo-bar-strip .l{display:none}.geo-bar-strip .s{display:inline}}
`;

export default function GeoBanner() {
  const [on, setOn] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isNativeApp()) return;
    let gone = false;
    void turboRegion().then((r) => { if (!gone && r.blocked) setOn(true); });
    return () => { gone = true; };
  }, []);
  useEffect(() => {
    const el = ref.current, html = document.documentElement;
    if (!on || !el) return;
    const fit = () => html.style.setProperty("--geo-bar", `${el.offsetHeight}px`);
    fit();
    html.classList.add("geo-bar");
    const ro = new ResizeObserver(fit); ro.observe(el);
    return () => { ro.disconnect(); html.classList.remove("geo-bar"); html.style.removeProperty("--geo-bar"); };
  }, [on]);
  if (!on) return null;
  return (
    <>
      <style>{CSS}</style>
      <div ref={ref} className="geo-bar-strip" role="status" data-testid="geo-banner">
        <span>
          <span className="l">You&apos;re accessing DISCIPLE from a restricted region. Real&#8209;money trading is off. See the </span>
          <span className="s">Restricted region. Real&#8209;money trading is off. </span>
          <a href={withBase("/terms#who-can-use-disciple")} target="_blank" rel="noopener">Terms of Use</a>
        </span>
      </div>
    </>
  );
}
