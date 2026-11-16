"use client";
/**
 * The launch builder's pad stage: the real lobby pad scene (HeroPad) with the host's rocket seated in the mount ring,
 * lit like the plate (night tint, amber bounce, cool rim), idle exhaust smog rolling round the base, and the badge on
 * the hull shaded with it. The nameplate follows what the host types and picks.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { CoinLook } from "@/lib/coinLook";
import HeroPad from "@/components/home/HeroPad";
import { withBase } from "@/lib/base-path";
import s from "./launch.module.css";

const GRAIN_SRC = "/home/pad/grain.webp";

/** `look` puts the picked skin on the pad; `chip` (the look chip) sits over the seat card; `tray` (the look picker) opens over the stage. */
export default function LaunchPad({ name, ticker, icon, mode, modeColor, seat, look, chip, tray }: {
  name: string; ticker: string; icon: string | null; mode: string; modeColor: string; seat: string; look?: CoinLook | null; chip?: ReactNode; tray?: ReactNode;
}) {
  // idle layers (smog, glow, stars) load after first paint, like the lobby
  const [go, setGo] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => setGo(true)); return () => cancelAnimationFrame(id); }, []);
  return (
    <section className={s.stage} aria-label="Your rocket on the pad" data-testid="create-pad-preview" style={{ ["--mc" as string]: modeColor }}>
      <div className={s.padScene} aria-hidden>
        <HeroPad go={go} launching={false} icon={icon} layout="launch" moon={false} look={look} />
      </div>
      <div className={s.grain} style={go ? { backgroundImage: `url(${withBase(GRAIN_SRC)})` } : undefined} aria-hidden />
      <div className={s.stageScrim} aria-hidden />
      <div className={s.stageTop}>
        <div className={s.stageTitle}>
          <span className={s.eb}>Host a match</span>
          <h1>Launch<br />a rocket</h1>
        </div>
        <span className={s.modeTag} data-testid="pad-mode">● {mode}</span>
      </div>
      <div className={s.plate}>
        <div className={s.plateName}>
          <b data-testid="pad-name">{name.trim() || "Your rocket"}</b>
          <span>{ticker ? `$${ticker}` : "$TICKER"} · On the pad</span>
        </div>
        <div className={s.stageSide}>
          {chip}
          <div className={s.seatCard}><span>Your seat</span><b data-testid="pad-seat">{seat}</b></div>
        </div>
      </div>
      {tray}
    </section>
  );
}
