"use client";
/**
 * Share this trade from the phone flight (maker 2026-11-14 option 6: "the whole trade from entry to exit, or while it's open,
 * up until now"). A SHARE pill sits on the bag card's top edge while you hold a bag on a live coin, and after you have sold it
 * (it then pulses once: "SHARE THIS TRADE"). It opens the existing Share modal with trade: "last", so the video replays only
 * this trade from the indexed fills (the buy that opened it → your final sell, or → now) and ends on the P&L card; the modal's
 * Share button hands the MP4 to the iPhone share sheet (Web Share with a file) or downloads it.
 * Phone only (html.ap-phone), signed in, live coins (not Free play / replays).
 */
import { useEffect, useState } from "react";
import ShareModal, { type ShareTarget } from "@/components/share/ShareModal";
import { onWallet } from "@/lib/walletState";
import { localUsername } from "@/lib/profile";

export default function ShareTrade({ coin }: { coin: string | null }) {
  const [wallet, setWallet] = useState<string | null>(null);
  const [ticker, setTicker] = useState("");
  const [held, setHeld] = useState(false);
  const [traded, setTraded] = useState(false);
  const [landed, setLanded] = useState(false);
  const [phone, setPhone] = useState(false);
  const [open, setOpen] = useState<ShareTarget | null>(null);
  useEffect(() => onWallet((a) => setWallet(a ? a.toLowerCase() : null)), []);
  useEffect(() => {
    const html = document.documentElement, check = () => setPhone(html.classList.contains("ap-phone"));
    check(); const mo = new MutationObserver(check); mo.observe(html, { attributes: true, attributeFilter: ["class"] });
    let was = false;
    const onPos = (e: Event) => {
      const d = (e as CustomEvent<{ size?: number; valueUsd?: number }>).detail || {};
      const h = (d.size ?? 0) > 0 && (d.valueUsd ?? 0) > 0.01;
      setHeld(h); if (h) { setTraded(true); setLanded(false); } else if (was) setLanded(true);
      was = h;
    };
    const onRules = (e: Event) => { const t = (e as CustomEvent<{ ticker?: string }>).detail?.ticker; if (t) setTicker(t.replace(/^\$/, "")); };
    addEventListener("disciple:position", onPos); addEventListener("disciple:coinrules", onRules);
    return () => { mo.disconnect(); removeEventListener("disciple:position", onPos); removeEventListener("disciple:coinrules", onRules); };
  }, []);
  if (!coin || !wallet || !phone || !(held || traded)) return open ? <ShareModal target={open} onClose={() => setOpen(null)} /> : null;
  return (
    <>
      <style>{`
        .ph-share { position: fixed; left: 24px; bottom: calc(var(--ph-bar-bottom, 24px) + 82px); z-index: 37; height: 30px; padding: 0 12px; border-radius: 999px;
          border: 1.5px solid #F2C14E; background: rgba(14,16,32,.92); color: #F3DFA8; font: 800 14px/1 var(--dsc-font-game, "Barlow Condensed", sans-serif);
          letter-spacing: .8px; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; touch-action: manipulation; transition: opacity .45s ease; }
        .ph-share.landed { background: #F2C14E; color: #121327; animation: phShare 1.2s ease-out 2; }
        @keyframes phShare { 0% { box-shadow: 0 0 0 0 rgba(242,193,78,.55) } 100% { box-shadow: 0 0 0 14px rgba(242,193,78,0) } }
        html.ap-phone[data-ph-calm] .ph-share:not(.landed) { opacity: 0; pointer-events: none; }
        html.ap-phone:not([data-ph-sheet=""]) .ph-share { display: none; }
        @media (prefers-reduced-motion: reduce) { .ph-share.landed { animation: none; } }
      `}</style>
      <button type="button" data-testid="phone-share-trade" className={`ph-share${landed && !held ? " landed" : ""}`}
        onClick={() => setOpen({ coin, ticker: ticker || "ROCKET", wallet, username: localUsername() || null, trade: "last" })}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3v13M7 8l5-5 5 5M5 14v5h14v-5" /></svg>
        {landed && !held ? "SHARE THIS TRADE" : "SHARE"}
      </button>
      {open && <ShareModal target={open} onClose={() => setOpen(null)} />}
    </>
  );
}
