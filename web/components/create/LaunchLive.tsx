"use client";
/**
 * After "Light the engines" (maker, 2026-11-15: no 3-2-1, no share screen, straight to trading).
 * While the launch confirms, the cinematic liftoff plate holds with the real status (no fake countdown). The moment it
 * lands, a short liftoff clip (Grok B1, LIFTOFF_MS) plays and the page goes straight to the flight. Sharing lives on the
 * flight as a toast that never blocks the trade bar (components/flight/LaunchedToast).
 */
import { useEffect } from "react";
import { withBase } from "@/lib/base-path";
import { playSfx } from "@/lib/game/sfx";
import AnimClip from "@/components/ui/AnimClip";
import s from "./liftoff.module.css";

/** signing: the launch is being sent and confirmed. fuelling: it landed, the fee receiver step runs. lifting: away. */
export type LaunchPhase = "signing" | "fuelling" | "lifting";
/** Liftoff length (ms): the page navigates when it ends. Mirrors --lift-ms in liftoff.module.css. */
export const LIFTOFF_MS = 2700;

const COPY: Record<LaunchPhase, { h: string; sub: string }> = {
  signing: { h: "Lighting the engines", sub: "Confirm in your wallet if it asks. Trading opens the second it lands." },
  fuelling: { h: "Fuelling", sub: "One more confirmation to set your fee receiver." },
  lifting: { h: "Liftoff", sub: "Taking you to the flight." },
};

export function LaunchIgnition({ name, ticker, mode, modeColor, phase }: {
  name: string; ticker: string; mode: string; modeColor: string; phase: LaunchPhase;
}) {
  const c = COPY[phase];
  const lifting = phase === "lifting";
  // ignition rumble while the launch confirms, the liftoff roar the moment it lands
  useEffect(() => { playSfx(lifting ? "launch_liftoff" : "launch_ignite", { gapMs: 1500 }); }, [lifting]);
  return (
    <div className={`${s.stage}${lifting ? ` ${s.lift}` : ""}`} role="status" aria-live="polite" data-testid="liftoff-overlay" data-phase={phase}
      style={{ ["--plate-d" as string]: `url(${withBase("/art/hero/hero-desktop.webp")})`, ["--plate-p" as string]: `url(${withBase("/art/hero/hero-phone.webp")})` }}>
      <div className={s.cam} aria-hidden>
        <div className={s.plate} />
        {/* the plate, alive (Grok clip A2) while the launch confirms */}
        <AnimClip id="A2-lobby" loop className={s.plateVid} />
        <div className={s.burn} />
      </div>
      {/* liftoff (Grok clip B1): ignition, clamps off, cream white-out, then the flight. The CSS chase is the fallback. */}
      <AnimClip id="B1-liftoff" paused={!lifting} className={`${s.liftVid}${lifting ? ` ${s.liftOn}` : ""}`} maxMs={LIFTOFF_MS + 400} />
      <div className={s.streaks} aria-hidden />
      <div className={s.scrim} aria-hidden />
      <div className={s.flash} aria-hidden />
      <div className={s.out} aria-hidden />
      <div className={s.copy}>
        <span className={s.eb}>
          {ticker ? <b>${ticker}</b> : null}
          <span>{name}</span>
          <i style={{ color: modeColor }}>{mode}</i>
        </span>
        <h2 key={phase} className={s.h}>{c.h}</h2>
        <p className={s.sub}>{c.sub}</p>
      </div>
      <div className={s.bar} aria-hidden><span /></div>
    </div>
  );
}
