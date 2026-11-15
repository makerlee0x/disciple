"use client";
/**
 * First launch of the iPhone app (TestFlight build 1 feedback, maker 2026-11-14: "we need a login screen / how to play for first
 * login"). Three swipeable cards (how a flight works, the lever, Turbo duels), then Sign in or Play free first. Shown once per
 * install, only inside the app, only when signed out; the flight's own "How to fly" card still covers the lever in detail.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { isNativeApp } from "@/lib/native";
import { hasSavedSession } from "@/lib/aa/session";
import { WALLET_CTA_CLICK_EVENT } from "@/lib/walletCta";
import { withBase } from "@/lib/base-path";

export const WELCOME_KEY = "disciple.welcome.v1";

export const WELCOME_CARDS = [
  { k: "rocket", t: ["Every coin", "is a rocket."], s: "Its altitude is its market cap. Jump on one that's climbing." },
  { k: "lever", t: ["Slide up to boost.", "Slide down to dump."], s: "Boost buys you a seat. Dump sells. Cash out higher than you got in." },
  { k: "duel", t: ["Beat your", "friends."], s: "Turbo duels: 1v1, three minutes, most profit wins. Free play costs nothing." },
] as const;

export default function WelcomeIntro() {
  const router = useRouter();
  const [show, setShow] = useState(false);
  const [i, setI] = useState(0);
  const row = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isNativeApp() || hasSavedSession()) return;
    try { if (localStorage.getItem(WELCOME_KEY)) return; } catch { return; }
    setShow(true);
  }, []);
  if (!show) return null;

  const done = () => { try { localStorage.setItem(WELCOME_KEY, String(Date.now())); } catch { /* private mode */ } setShow(false); };
  const go = (n: number) => { const r = row.current; if (r) r.scrollTo({ left: n * r.clientWidth, behavior: "smooth" }); };
  const last = i === WELCOME_CARDS.length - 1;
  // same path as the top bar's Sign in (WalletButton): it loads Privy if needed, then opens the sign-in window
  const signIn = () => { done(); window.dispatchEvent(new Event(WALLET_CTA_CLICK_EVENT)); };
  const play = () => { done(); router.push("/flight/sim"); };

  return (
    <div className="wi" role="dialog" aria-modal="true" aria-label="Welcome to DISCIPLE" data-testid="welcome-intro">
      <style>{`
        .wi { position: fixed; inset: 0; z-index: 200; background: #0B0C0E; color: #F2F3F7; display: flex; flex-direction: column;
          padding: calc(env(safe-area-inset-top, 0px) + 18px) 0 calc(env(safe-area-inset-bottom, 0px) + 18px); box-sizing: border-box;
          font-family: var(--dsc-font-ui, Geist, system-ui, sans-serif); }
        .wi-top { display: flex; justify-content: space-between; align-items: center; padding: 0 20px; height: 40px; }
        .wi-top img { height: 22px; }
        .wi-skip { border: 0; background: none; color: rgba(215,217,228,.75); font: 700 16px/1 var(--dsc-font-game, sans-serif); letter-spacing: .6px; padding: 10px 0 10px 16px; }
        .wi-row { flex: 1; display: flex; overflow-x: auto; scroll-snap-type: x mandatory; scrollbar-width: none; overscroll-behavior-x: contain; }
        .wi-row::-webkit-scrollbar { display: none; }
        .wi-card { flex: 0 0 100%; scroll-snap-align: center; display: flex; flex-direction: column; justify-content: flex-end; padding: 0 24px 24px; box-sizing: border-box; position: relative; }
        .wi-art { flex: 1; display: grid; place-items: center; }
        .wi-art img { max-height: 46vh; max-width: 70%; object-fit: contain; filter: drop-shadow(0 20px 50px rgba(242,193,78,.18)); }
        .wi-h { margin: 0; font: italic 800 clamp(40px, 11vw, 54px)/.92 var(--dsc-font-game, sans-serif); text-transform: uppercase; }
        .wi-s { margin: 12px 0 0; font-size: 17px; line-height: 1.4; color: #D7D9E4; max-width: 30ch; }
        .wi-dots { display: flex; gap: 6px; justify-content: center; padding: 6px 0 18px; }
        .wi-dots i { width: 7px; height: 7px; border-radius: 4px; background: rgba(232,234,238,.25); transition: width .2s ease; }
        .wi-dots i.on { width: 22px; background: #F2C14E; }
        .wi-btns { display: flex; flex-direction: column; gap: 10px; padding: 0 20px; }
        .wi-go { height: 56px; border-radius: 14px; border: 0; background: linear-gradient(180deg, #F3DFA8, #F2C14E); color: #121327; font: 800 22px/1 var(--dsc-font-game, sans-serif); letter-spacing: .6px; text-transform: uppercase; }
        .wi-alt { height: 52px; border-radius: 14px; border: 1.5px solid #2E323A; background: transparent; color: #F2F3F7; font: 800 19px/1 var(--dsc-font-game, sans-serif); letter-spacing: .6px; text-transform: uppercase; }
        @media (prefers-reduced-motion: reduce) { .wi-dots i { transition: none; } }
      `}</style>
      <div className="wi-top">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={withBase("/brand/disciple-lockup-horizontal-light.svg")} alt="DISCIPLE" />
        <button type="button" className="wi-skip" onClick={done} data-testid="welcome-skip">SKIP</button>
      </div>
      <div className="wi-row" ref={row} onScroll={(e) => { const r = e.currentTarget; setI(Math.round(r.scrollLeft / Math.max(1, r.clientWidth))); }}>
        {WELCOME_CARDS.map((c) => (
          <section key={c.k} className="wi-card" aria-label={c.t.join(" ")}>
            <div className="wi-art" aria-hidden>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={withBase(c.k === "duel" ? "/art/modes/duel.webp" : c.k === "lever" ? "/art/modes/live.webp" : "/assets/rocket-hi.webp")} alt="" />
            </div>
            <h2 className="wi-h">{c.t[0]}<br />{c.t[1]}</h2>
            <p className="wi-s">{c.s}</p>
          </section>
        ))}
      </div>
      <div className="wi-dots" aria-hidden>{WELCOME_CARDS.map((c, n) => <i key={c.k} className={n === i ? "on" : undefined} />)}</div>
      <div className="wi-btns">
        {last ? (
          <>
            <button type="button" className="wi-go" onClick={signIn} data-testid="welcome-signin">Sign in</button>
            <button type="button" className="wi-alt" onClick={play} data-testid="welcome-play">Play free first</button>
          </>
        ) : (
          <button type="button" className="wi-go" onClick={() => go(i + 1)} data-testid="welcome-next">Next</button>
        )}
      </div>
    </div>
  );
}
