"use client";
/**
 * After "Light the engines" (canvas board "Launch: after Light the engines"). A: the countdown while the launch
 * confirms, with its three steps. B: you're live, with the flight link to open, share on X or copy.
 */
import { useState } from "react";
import { withBase } from "@/lib/base-path";
import { ROCKET_SRC } from "@/lib/home/trending";
import s from "./launch.module.css";

/** signing: the launch is being sent and confirmed. fuelling: it landed, the last step (fee receiver) runs. lifting: away. */
export type LaunchPhase = "signing" | "fuelling" | "lifting";
const ORDER: LaunchPhase[] = ["signing", "fuelling", "lifting"];
const STEPS = ["Signed", "Fuelled", "Lifting off"];

const Check = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#121327" strokeWidth="3.5" aria-hidden><path d="M5 12l5 5 9-10" /></svg>
);

export function LaunchCountdown({ name, mode, phase }: { name: string; mode: string; phase: LaunchPhase }) {
  const at = ORDER.indexOf(phase);
  return (
    <div className={s.overlay} role="status" aria-live="polite" data-testid="liftoff-overlay">
      <section className={`${s.frame}${phase === "lifting" ? ` ${s.lifting}` : ""}`} aria-label="Countdown">
        <div className={s.cdSky} aria-hidden />
        <div className={s.cdTint} aria-hidden />
        <div className={s.cdGlow} aria-hidden />
        <div className={s.cdRocket} aria-hidden>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={withBase(ROCKET_SRC)} alt="" />
          <span className={s.flame} />
        </div>
        <span className={`${s.smoke} ${s.cdSmokeA}`} aria-hidden />
        <span className={`${s.smoke} ${s.cdSmokeB}`} aria-hidden />
        <div className={s.vignette2} aria-hidden />
        <span className={`${s.bar} ${s.barT}`} aria-hidden />
        <span className={`${s.bar} ${s.barB}`} aria-hidden />
        <div className={s.cdScrim} aria-hidden />
        <div className={s.cdText}>
          <span className={s.eb}>{name} · {mode}</span>
          <span className={s.cdNum} data-testid="countdown">{3 - at}</span>
          <span className={s.cdLine}>Engines lit.<br />Hold tight.</span>
        </div>
        <div className={s.steps}>
          {STEPS.map((label, i) => (
            <span key={label} className={`${s.step}${i === at ? ` ${s.stepNow}` : ""}`}>
              <span className={`${s.dot} ${i < at ? s.dotDone : i === at ? s.spin : s.dotWait}`}>{i < at && <Check />}</span>
              {label}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}

export function LaunchLiveNow({ name, ticker, mode, modeColor, seat, href, token, note, onOpen }: {
  name: string; ticker: string; mode: string; modeColor: string; seat: string; href: string; token: string; note?: string | null; onOpen: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const url = typeof window === "undefined" ? `/coin/${token}` : `${window.location.origin}${withBase(`/coin/${token}`)}`;
  const short = `/coin/${token.slice(0, 6)}…${token.slice(-4)}`;
  const share = () => {
    const text = `${name} ($${ticker}) is live on Disciple. Hop aboard before it climbs: ${url}`;
    window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { /* clipboard blocked */ }
  };
  return (
    <section className={`${s.frame} ${s.liveFrame}`} aria-labelledby="live-title" data-testid="launch-live">
      <div className={s.liveSky} aria-hidden />
      <div className={s.liveTint} aria-hidden />
      <div className={s.liveHalo} aria-hidden />
      <div className={s.liveLine} aria-hidden />
      <div className={s.trail} aria-hidden />
      <div className={s.liveRocket} aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={withBase(ROCKET_SRC)} alt="" />
        <span className={s.flame} />
      </div>
      <div className={s.vignette2} aria-hidden />
      <div className={s.liveScrim} aria-hidden />
      <span className={`${s.bar} ${s.barT}`} aria-hidden />
      <span className={`${s.bar} ${s.barB}`} aria-hidden />
      <div className={s.liveBody}>
        <span className={s.liveTag}>Live now</span>
        <h2 id="live-title">{name}<br />is flying</h2>
        <p>You&apos;re the host. Every boost and dump pays you a cut. Bring your crew: the more pilots aboard, the higher it climbs.</p>
        <div className={s.liveChips}>
          <div><span>Your seat</span><b>{seat}</b></div>
          <div><span>Difficulty</span><b style={{ color: modeColor }}>{mode}</b></div>
          <div><span>Ticker</span><b>${ticker}</b></div>
        </div>
        <div className={s.btns}>
          <a href={href} className={`${s.btn} ${s.gold}`} data-testid="open-flight" onClick={(e) => { e.preventDefault(); onOpen(); }}>Open your flight</a>
          <button type="button" className={`${s.btn} ${s.ghost}`} onClick={share} data-testid="share-x">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M17.5 3h3.2l-7 8 8.3 10h-6.5l-5-6.2L4.8 21H1.6l7.5-8.6L1.2 3h6.6l4.6 5.7L17.5 3z" /></svg>
            Share on X
          </button>
        </div>
        <div className={s.copy}>
          <span>Your flight link · {short}</span>
          <button type="button" onClick={copy} data-testid="copy-link">{copied ? "Copied" : "Copy link"}</button>
        </div>
        {note && <p className={s.liveNote} role="status">{note}</p>}
      </div>
    </section>
  );
}
