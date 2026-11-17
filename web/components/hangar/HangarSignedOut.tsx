"use client";
/**
 * Hangar, signed out (step 5 board "Sign in, account menu, Hangar signed out", maker 2026-11-13). Replaces
 * "Your Profile · Sign in (top right)": the same bay as the signed-in Hangar with the chrome rocket waiting for a pilot,
 * Sign in + Watch a flight first (the perk list was cut in the subcopy pass, 2026-11-17), and dimmed outlines of the real sections below (no
 * sample numbers).
 */
import Link from "next/link";
import HangarBay from "./HangarBay";
import type { Loadout } from "./hangarData";
import { WALLET_CTA_CLICK_EVENT } from "@/lib/walletCta";

export const HANGAR_OUT_COPY = {
  eyebrow: "Your hangar",
  lines: ["This bay", "is yours"],
  signIn: "Sign in",
  watch: "Watch a flight first",
  record: ["Hangar value", "Cash", "Flights aboard", "Rockets launched"],
  fleet: "Your fleet",
  trophies: "Trophy case",
} as const;

export default function HangarSignedOut({ loadout }: { loadout: Loadout }) {
  const C = HANGAR_OUT_COPY;
  const actions = (
    <>
      <button type="button" className="dsc3-btn dsc3-btn-primary hg-claim" onClick={() => window.dispatchEvent(new Event(WALLET_CTA_CLICK_EVENT))} data-testid="hangar-signin">{C.signIn}</button>
      <Link href="/play" className="hg-ghost">{C.watch}</Link>
    </>
  );
  return (
    <>
      <HangarBay handle="" lines={[...C.lines]} eyebrow={<span>{C.eyebrow}</span>} bio={null} avatar={null} xp={null} loadout={loadout} actions={actions} spend={false} />
      <section className="hg-record hgo-ghost" aria-hidden>
        {C.record.map((l) => <div key={l}><span className="l">{l}</span><i className="hgo-bar" /></div>)}
      </section>
      <div className="hgo-row" aria-hidden>
        <div className="hgo-panel hgo-wide"><h2>{C.fleet}</h2><div className="hgo-cards"><i /><i /><i /><i /></div></div>
        <div className="hgo-panel"><h2>{C.trophies}</h2><div className="hgo-gems"><i /><i /><i /></div></div>
      </div>
    </>
  );
}
