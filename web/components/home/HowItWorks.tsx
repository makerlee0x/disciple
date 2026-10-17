"use client";
/**
 * First-visit "How DISCIPLE works" (BRAND app-home r1, mock C; copy approved by lee). Opened by HowItWorksHost:
 * automatically once per visitor on the home page, and any time from Help in the sidebar.
 * Accessible dialog: aria-modal + labelled/described, focus moves in and is trapped, Esc / ✕ / backdrop / the primary
 * button close it, focus returns to where it was.
 */
import { useEffect, useRef } from "react";
import { TIERS } from "@/lib/config";
import { withBase } from "@/lib/base-path";
import { tierTitle } from "@/lib/home/trending";
import Icon from "@/components/icons/Icon";
import s from "./howItWorks.module.css";

/** "How it works →" goes to /how-it-works, which doesn't exist yet: hidden until the page ships (set to true then). */
export const HOW_IT_WORKS_PAGE_LIVE = false;

const STEPS = [
  { icon: "base-pair", title: "Pick your coin.", body: "Launch a rocket paired with any coin you believe in. Your rocket trades in that coin." },
  { icon: "boost", title: "BOOST to climb.", body: "Every BOOST lifts the rocket. Every DUMP drops a bomb. BOOST = BUY & DUMP = SELL." },
  { icon: "lock", title: "Send your coin to The Moon and beyond.", body: "Rockets graduate from a bonding curve. Their liquidity is locked in a Uniswap v4 LP, forever." },
] as const;

/** $7K, $3.3B (tier ladder ends) */
const short$ = (v: number) => {
  const [d, u] = v >= 1e9 ? [1e9, "B"] : v >= 1e6 ? [1e6, "M"] : v >= 1e3 ? [1e3, "K"] : [1, ""];
  return "$" + String(+(v / d).toFixed(1)) + u;
};

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function HowItWorks({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    box.current?.focus({ preventScroll: true }); // the dialog itself; Tab moves to ✕ / To the moon
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key !== "Tab" || !box.current) return;
      const f = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current || !box.current.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !box.current.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.({ preventScroll: true });
    };
  }, [onClose]);

  const first = TIERS[0], last = TIERS[TIERS.length - 1];
  return (
    <div className={s.ov} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className={s.card} role="dialog" aria-modal="true" tabIndex={-1} aria-labelledby="hiw-title" aria-describedby="hiw-steps">
        <div className={s.hd} style={{ backgroundImage: `url(${withBase("/home/hiw-header.webp")})` }}>
          <button type="button" className={s.close} onClick={onClose} aria-label="Close How DISCIPLE works"><Icon name="close" size={16} /></button>
          <div className={s.hdTxt}>
            <span className={s.eyebrow}>First flight</span>
            <h2 id="hiw-title" className={s.title}>How DISCIPLE works</h2>
          </div>
        </div>
        <div className={s.body}>
          <ol id="hiw-steps" className={s.steps}>
            {STEPS.map((st, i) => (
              <li key={st.title} className={s.step}>
                <span className={s.n} aria-hidden><em>{i + 1}</em><Icon name={st.icon} size={22} /></span>
                <div>
                  <h3>{st.title}</h3>
                  <p>{st.body}</p>
                  {i === 1 && (
                    <>
                      <div className={s.tiers} role="img" aria-label={`${TIERS.length} tiers, from ${tierTitle(first.name)} to ${tierTitle(last.name)}`}>
                        {TIERS.map((t, k) => <i key={t.name} style={{ backgroundPosition: `${(k / (TIERS.length - 1)) * 100}% 50%`, backgroundImage: `url(${withBase("/home/tier-strip.webp")})` }} />)}
                      </div>
                      <div className={s.tierLbl} aria-hidden><span>{first.name} {short$(first.lo)}</span><span>{last.name} {short$(last.lo)}</span></div>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <div className={s.foot}>
            <button type="button" className={`${s.btn} ${s.pri}`} onClick={onClose}>To the moon</button>
            {HOW_IT_WORKS_PAGE_LIVE && <a className={s.btn} href={withBase("/how-it-works")}>How it works →</a>}
            <span className={s.note}>Shown once. Find it again under Help.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
