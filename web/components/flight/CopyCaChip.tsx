"use client";
/**
 * Copy contract address chip on the coin's top card (maker 2026-11-20, first mainnet launch: "we need to add a copy contract
 * address button in this card").
 *   desktop  the card is drawn by the engine (public/flight/engine.js drawHud). This sets window.__coinCa, the engine leaves
 *            room right after TICKER/PAIR and publishes the spot (CARD_RECTS.header.ca, card-local canvas px), and this
 *            draws the DOM button there, riding with the card's offset.
 *   phone    <CopyCaButton> sits inline in the chart card's label row (PhoneChart `ca`).
 */
import { useEffect, useState, type CSSProperties, type MouseEvent } from "react";
import { getAddress, isAddress } from "viem";
import { isPhoneUI, useCanvasCards } from "@/lib/game/cardLayoutStore";

async function copyText(t: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(t); return true; } catch { /* blocked: fall back */ }
  try {
    const el = document.createElement("textarea");
    el.value = t; el.setAttribute("readonly", ""); el.style.position = "fixed"; el.style.opacity = "0";
    document.body.appendChild(el); el.select(); const ok = document.execCommand("copy"); el.remove(); return ok;
  } catch { return false; }
}

export function CopyCaButton({ address, size = 22, style }: { address: string; size?: number; style?: CSSProperties }) {
  const [done, setDone] = useState(false);
  useEffect(() => { if (!done) return; const t = window.setTimeout(() => setDone(false), 1500); return () => window.clearTimeout(t); }, [done]);
  const onClick = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation(); e.currentTarget.blur();   // blur: Space / Enter keep flying the rocket
    if (await copyText(isAddress(address) ? getAddress(address) : address)) setDone(true);   // checksummed, like explorers
  };
  const ic = Math.round(size * 0.6);
  return (
    <button type="button" data-testid="copy-ca" onClick={onClick} tabIndex={-1}
      aria-label={done ? "Contract address copied" : `Copy contract address ${address}`} title={done ? "Copied" : "Copy CA"}
      style={{ all: "unset", boxSizing: "border-box", width: size, height: size, display: "grid", placeItems: "center", borderRadius: 6, cursor: "pointer",
        color: done ? "#5FF0A0" : "rgba(215,217,228,.78)", background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.14)", pointerEvents: "auto", ...style }}>
      {done
        ? <svg width={ic} height={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
        : <svg width={ic} height={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>}
    </button>
  );
}

/** Desktop: the chip on the engine-drawn header card. Renders nothing on phones (PhoneChart has its own). */
export default function CopyCaChip({ address }: { address: string }) {
  const ok = isAddress(address);
  useEffect(() => {
    if (!ok) return;
    const w = window as unknown as { __coinCa?: string };
    w.__coinCa = address;
    return () => { w.__coinCa = ""; };
  }, [ok, address]);
  const hc = useCanvasCards().cards.header as ({ x: number; y: number; dx: number; dy: number; min?: boolean; closed?: boolean; ca?: { x: number; y: number; s: number } } | undefined);
  const [wrap, setWrap] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const f = () => { const r = document.getElementById("wrap")?.getBoundingClientRect(); setWrap(r && !isPhoneUI() ? { x: r.left, y: r.top } : null); };
    f(); addEventListener("resize", f);
    return () => removeEventListener("resize", f);
  }, [hc?.x, hc?.y]);
  if (!ok || !hc?.ca || !wrap || hc.min || hc.closed) return null;
  return <CopyCaButton address={address} size={hc.ca.s} style={{ position: "fixed", zIndex: 61, left: wrap.x + hc.ca.x + (hc.dx || 0), top: wrap.y + hc.ca.y + (hc.dy || 0) }} />;
}
