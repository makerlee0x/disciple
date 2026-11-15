"use client";
/**
 * First launch of the iPhone app. Was three swipeable cards (2026-11-14); since the app audit (maker, 2026-11-15) it is one
 * screen that drops a new pilot straight into a 1-minute bot duel, with sign-in after the result. Shown once per install,
 * only inside the app, only when signed out. SKIP goes to the lobby.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { isNativeApp } from "@/lib/native";
import { hasSavedSession } from "@/lib/aa/session";
import { WALLET_CTA_CLICK_EVENT } from "@/lib/walletCta";
import { withBase } from "@/lib/base-path";

export const WELCOME_KEY = "disciple.welcome.v1";

/** First launch (maker, 2026-11-15, app audit: "straight into a bot duel"): one screen, then a 1-minute practice duel
 *  against the rookie bot (/turbo/duel?first=1). Sign-in waits until after the result ("Save your win"). */
export const WELCOME_COPY = {
  h: ["1v1.", "One minute."],
  s: "Live BTC, 500x. Out-trade a rival and the W is yours. Practice money, no sign-up.",
  play: "Play",
  signIn: "I have an account \u00b7 Sign in",
} as const;

export default function WelcomeIntro() {
  const router = useRouter();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!isNativeApp() || hasSavedSession()) return;
    try { if (localStorage.getItem(WELCOME_KEY)) return; } catch { return; }
    setShow(true);
  }, []);
  if (!show) return null;

  const done = () => { try { localStorage.setItem(WELCOME_KEY, String(Date.now())); } catch { /* private mode */ } setShow(false); };
  // same path as the top bar's Sign in (WalletButton): it loads Privy if needed, then opens the sign-in window
  const signIn = () => { done(); window.dispatchEvent(new Event(WALLET_CTA_CLICK_EVENT)); };
  const play = () => { done(); router.push("/turbo/duel?first=1"); };

  return (
    <div className="wi" role="dialog" aria-modal="true" aria-label="Welcome to DISCIPLE" data-testid="welcome-intro">
      <style>{`
        .wi { position: fixed; inset: 0; z-index: 200; background: #0B0C0E; color: #F2F3F7; display: flex; flex-direction: column;
          padding: calc(env(safe-area-inset-top, 0px) + 18px) 0 calc(env(safe-area-inset-bottom, 0px) + 18px); box-sizing: border-box;
          font-family: var(--dsc-font-ui, Geist, system-ui, sans-serif); }
        .wi-top { display: flex; justify-content: space-between; align-items: center; padding: 0 20px; height: 40px; }
        .wi-top img { height: 22px; }
        .wi-skip { border: 0; background: none; color: rgba(215,217,228,.75); font: 700 16px/1 var(--dsc-font-game, sans-serif); letter-spacing: .6px; padding: 10px 0 10px 16px; }
        .wi-card { flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: flex-end; padding: 0 24px 24px; box-sizing: border-box; position: relative; }
        .wi-art { flex: 1; display: grid; place-items: center; }
        .wi-art img { max-height: 52vh; max-width: 82%; border-radius: 20px; object-fit: contain; filter: drop-shadow(0 20px 50px rgba(242,193,78,.18)); }
        .wi-h { margin: 0; font: italic 800 clamp(40px, 11vw, 54px)/.92 var(--dsc-font-game, sans-serif); text-transform: uppercase; }
        .wi-s { margin: 12px 0 0; font-size: 17px; line-height: 1.4; color: #D7D9E4; max-width: 30ch; }
        .wi-btns { display: flex; flex-direction: column; gap: 10px; padding: 0 20px; }
        .wi-go { height: 56px; border-radius: 14px; border: 0; background: linear-gradient(180deg, #F3DFA8, #F2C14E); color: #121327; font: 800 22px/1 var(--dsc-font-game, sans-serif); letter-spacing: .6px; text-transform: uppercase; }
        .wi-link { height: 48px; border: 0; background: none; color: rgba(215,217,228,.85); font: 600 16px/1 var(--dsc-font-ui, system-ui, sans-serif); }
      `}</style>
      <div className="wi-top">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={withBase("/brand/disciple-lockup-horizontal-light.svg")} alt="DISCIPLE" />
        <button type="button" className="wi-skip" onClick={done} data-testid="welcome-skip">SKIP</button>
      </div>
      <section className="wi-card" aria-label={WELCOME_COPY.h.join(" ")}>
        <div className="wi-art" aria-hidden>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={withBase("/art/modes/duel.webp")} alt="" />
        </div>
        <h2 className="wi-h">{WELCOME_COPY.h[0]}<br />{WELCOME_COPY.h[1]}</h2>
        <p className="wi-s">{WELCOME_COPY.s}</p>
      </section>
      <div className="wi-btns">
        <button type="button" className="wi-go" onClick={play} data-testid="welcome-play">{WELCOME_COPY.play}</button>
        <button type="button" className="wi-link" onClick={signIn} data-testid="welcome-signin">{WELCOME_COPY.signIn}</button>
      </div>
    </div>
  );
}
