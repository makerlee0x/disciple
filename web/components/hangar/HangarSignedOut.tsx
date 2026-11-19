"use client";
/**
 * Hangar, signed out (step 5 board "Sign in, account menu, Hangar signed out", maker 2026-11-13). Replaces
 * "Your Profile · Sign in (top right)": the same bay as the signed-in Hangar with the chrome rocket waiting for a pilot,
 * Sign in + Watch a flight first (the perk list was cut in the subcopy pass, 2026-11-17). Below it, a filled-in sample hangar
 * (record, fleet, trophies) sits blurred behind the sign-in, so the page shows what you get instead of a black page
 * (maker 2026-11-18: "This bay could be yours", blur the rest). The sample is decorative: aria-hidden, no clicks.
 */
import Link from "next/link";
import HangarBay from "./HangarBay";
import type { Loadout } from "./hangarData";
import { WALLET_CTA_CLICK_EVENT } from "@/lib/walletCta";
import { withBase } from "@/lib/base-path";

export const HANGAR_OUT_COPY = {
  eyebrow: "Your hangar",
  lines: ["This bay", "could be yours"],
  signIn: "Sign in",
  watch: "Watch a flight first",
  record: [["Hangar value", "$4,820.16"], ["Cash", "$1,240.55"], ["Flights aboard", "37"], ["Rockets launched", "6"]],
  fleet: "Your fleet",
  trophies: "Trophy case",
  /** sample fleet (ticker, hull tint) and trophies, only ever shown blurred */
  ships: [["$MOON", "#F3DFA8"], ["$PENGU", "#7FB7FF"], ["$NUKE", "#FF8A7A"], ["$WHALE", "#B59CFF"]],
  gems: ["pad_ignition", "first_grenade", "graduated_dev", "unfumbled", "nuke_ach"],
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
      <div className="hgo-blur" aria-hidden>
        <section className="hg-record">
          {C.record.map(([l, v]) => <div key={l}><span className="l">{l}</span><b className="hgo-v">{v}</b></div>)}
        </section>
        <div className="hgo-row">
          <div className="hgo-panel hgo-wide"><h2>{C.fleet}</h2><div className="hgo-cards">
            {C.ships.map(([t, c]) => (
              <i key={t} style={{ background: `radial-gradient(120% 80% at 50% 100%, ${c}33, transparent 70%), #121318` }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={withBase("/how-it-works/rocket.webp")} alt="" width={40} height={108} />
                <b>{t}</b>
              </i>
            ))}
          </div></div>
          <div className="hgo-panel"><h2>{C.trophies}</h2><div className="hgo-gems">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {C.gems.map((g) => <img key={g} src={withBase(`/achievements/${g}.svg`)} alt="" width={52} height={52} />)}
          </div></div>
        </div>
      </div>
    </>
  );
}
