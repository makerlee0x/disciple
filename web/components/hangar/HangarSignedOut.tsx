"use client";
/**
 * Hangar, signed out (step 5 board "Sign in, account menu, Hangar signed out", maker 2026-11-13). Replaces
 * "Your Profile · Sign in (top right)": the same bay as the signed-in Hangar with the chrome rocket waiting for a pilot,
 * what you get once you sign in, Sign in + Watch a flight first, and dimmed outlines of the real sections below (no
 * sample numbers).
 */
import Link from "next/link";
import HangarBay from "./HangarBay";
import type { Loadout } from "./hangarData";
import { WALLET_CTA_CLICK_EVENT } from "@/lib/walletCta";

export const HANGAR_OUT_COPY = {
  eyebrow: "Your hangar",
  lines: ["This bay", "is yours"],
  body: "Sign in to park your rocket here. Your level, your fleet and your trophies all live in the Hangar.",
  perks: [
    { dot: "#5FF0A0", text: "Level up from your first boost" },
    { dot: "#A9C4FF", text: "See every rocket you're aboard in one place" },
    { dot: "#F2C14E", text: "Collect trophies and claim your rewards" },
  ],
  signIn: "Sign in",
  watch: "Watch a flight first",
  record: ["Hangar value", "Cash", "Flights aboard", "Rockets launched"],
  fleet: "Your fleet",
  trophies: "Trophy case",
} as const;

export default function HangarSignedOut({ loadout }: { loadout: Loadout }) {
  const C = HANGAR_OUT_COPY;
  const bio = (
    <div className="hgo-bio">
      <p>{C.body}</p>
      <ul>{C.perks.map((p) => <li key={p.text}><i style={{ background: p.dot }} aria-hidden />{p.text}</li>)}</ul>
    </div>
  );
  const actions = (
    <>
      <button type="button" className="dsc3-btn dsc3-btn-primary hg-claim" onClick={() => window.dispatchEvent(new Event(WALLET_CTA_CLICK_EVENT))} data-testid="hangar-signin">{C.signIn}</button>
      <Link href="/play" className="hg-ghost">{C.watch}</Link>
    </>
  );
  return (
    <>
      <HangarBay handle="" lines={[...C.lines]} eyebrow={<span>{C.eyebrow}</span>} bio={bio} avatar={null} xp={null} loadout={loadout} actions={actions} spend={false} />
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
