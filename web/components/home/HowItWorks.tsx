"use client";
/**
 * Quick help (round 2 "Quick help" board, maker 2026-11-13): replaces the old "How DISCIPLE works" popup. The 20-second
 * version for Help in flight (sidebar Help → HowItWorksHost), so a pilot can check the keys without leaving the rocket.
 * Same words as the How to play page. Desktop: a popup with a sky header and three step cards (keys). Phone: a bottom
 * sheet, taps instead of keys. Esc, ✕, the backdrop and "Back to the flight" close it; focus returns where it was
 * (components/profile/Sheet).
 */
import Link from "next/link";
import Sheet from "@/components/profile/Sheet";
import { withBase } from "@/lib/base-path";
import { Warn } from "@/components/cash/bits";

export const QUICK_HELP_COPY = {
  eyebrow: "How to play",
  title: "Your first flight",
  lede: "Seats cost real cash. Cash out for more than you paid in, and you win.",
  steps: [
    { tone: "up", tag: "Climb", title: "Boost", body: "Pick an amount, then hit Space. Your cash buys a seat and lifts the rocket.", keys: ["1", "2", "3", "4"], key: "Space",
      phone: "Tap an amount, then BOOST. You buy a seat and lift the rocket." },
    { tone: "down", tag: "Cash out", title: "Dump", body: "Pick how much, then hit Shift. You get cash back and drop a bomb.", keys: ["Z", "X", "C", "V"], key: "Shift",
      phone: "Tap how much, then DUMP. Hold DUMP ALL to sell everything." },
    { tone: "gold", tag: "Crew goal", title: "Reach orbit", body: "At $33,333 the rocket breaks into orbit and the sky opens up. Everyone aboard gets the moment.", keys: [], key: "$3,333 → $33,333",
      phone: "At $33,333 the rocket breaks into orbit. That's the crew goal.", phoneTag: "Orbit" },
  ],
  warn: "If the rocket falls below where you boarded, your bag is worth less than you paid. Only fly with cash you're fine losing.",
  warnPhone: "Only fly with cash you're fine losing.",
  tutorial: "Full tutorial",
  back: "Back to the flight",
  backPhone: "Back to flight",
} as const;

function X() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>;
}

export default function HowItWorks({ onClose }: { onClose: () => void }) {
  const C = QUICK_HELP_COPY;
  const sky = withBase("/home/sky/t6.webp");
  return (
    <Sheet open onClose={onClose} label={C.title} className="r2-modal qh-modal" testId="quick-help">
      {/* desktop */}
      <div className="qh-hd cx-d" style={{ backgroundImage: `url(${sky})` }}>
        <button type="button" className="r2-x qh-x" aria-label="Close" onClick={onClose}><X /></button>
        <div className="qh-hdtxt">
          <span className="r2-eb">{C.eyebrow}</span>
          <h2 className="r2-g" id="qh-title">{C.title}</h2>
        </div>
      </div>
      <div className="qh-body cx-d">
        <p className="qh-lede">{C.lede}</p>
        <div className="qh-steps">
          {C.steps.map((s) => (
            <div key={s.title} className={`qh-step ${s.tone}`}>
              <span className="qh-tag"><span className="qh-dot" /><span className="r2-eb">{s.tag}</span></span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
              <div className="qh-keys">
                {s.keys.map((k) => <span key={k} className="qh-k">{k}</span>)}
                <span className={`qh-k ${s.keys.length ? `wide ${s.tone}` : "txt"}`}>{s.key}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="qh-warn"><Warn /><span>{C.warn}</span></div>
        <div className="qh-acts">
          <Link className="qh-btn" href="/how-it-works" prefetch={false} onClick={onClose}>{C.tutorial}</Link>
          <button type="button" className="r2-gold qh-gold" onClick={onClose} data-autofocus>{C.back}</button>
        </div>
      </div>
      {/* phone: bottom sheet */}
      <div className="qh-pbody cx-p">
        <div className="qh-phead">
          <div><span className="r2-eb">{C.eyebrow}</span><h2 className="r2-g">{C.title}</h2></div>
          <button type="button" className="r2-x" aria-label="Close" onClick={onClose}><X /></button>
        </div>
        <p className="qh-lede">{C.lede}</p>
        {C.steps.map((s) => (
          <div key={s.title} className={`qh-step row ${s.tone}`}>
            <span className="r2-g qh-chip">{"phoneTag" in s ? s.phoneTag : s.title}</span>
            <p>{s.phone}</p>
          </div>
        ))}
        <span className="qh-pwarn">{C.warnPhone}</span>
        <div className="qh-pacts">
          <Link className="qh-btn" href="/how-it-works" prefetch={false} onClick={onClose}>{C.tutorial}</Link>
          <button type="button" className="r2-gold" onClick={onClose}>{C.backPhone}</button>
        </div>
      </div>
    </Sheet>
  );
}
