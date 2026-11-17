"use client";
/**
 * /rocket: your whole collection, off the profile (maker 2026-11-17: "the profile is so freakin busy"). Your rocket (skins,
 * trails, name tags, flourishes, trade up) and your crates. Everything here flies in every mode: duels, Royale and real-coin
 * flights. The profile keeps a small Your rocket card that links here.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { localUsername, PROFILE_CHANGED_EVENT } from "@/lib/profile";
import { defaultUsername } from "@/lib/defaultUsername";
import { onWallet } from "@/lib/walletState";
import { useCollection } from "@/lib/collectionClient";
import { WALLET_CTA_CLICK_EVENT } from "@/lib/walletCta";
import { Crates, YourRocket } from "./Collection";

export default function RocketPage() {
  const [wallet, setWallet] = useState<string | null | undefined>(undefined);
  useEffect(() => onWallet((a) => setWallet(a ? a.toLowerCase() : null)), []);
  const [me, setMe] = useState("");
  useEffect(() => {
    const read = () => setMe(localUsername());
    read();
    window.addEventListener(PROFILE_CHANGED_EVENT, read);
    return () => window.removeEventListener(PROFILE_CHANGED_EVENT, read);
  }, []);
  useEffect(() => {
    if (!wallet || localUsername()) return;
    let alive = true;
    fetch(`/api/profile/username?address=${wallet}`).then((r) => r.json())
      .then((j: { username?: string | null }) => { if (alive && j.username) setMe(j.username); }).catch(() => {});
    return () => { alive = false; };
  }, [wallet]);
  const { col } = useCollection(wallet || null);
  // the profile card's "Open crates" button lands on #crates
  useEffect(() => { if (col && window.location.hash === "#crates") document.getElementById("hg-crates")?.closest("section")?.scrollIntoView({ block: "start" }); }, [col]);
  const handle = me ? `@${me}` : defaultUsername(wallet ?? null);

  return (
    <div className="profile-page hg hgr" data-testid="rocket-page">
      <nav className="hgr-crumb"><Link href="/profile">Hangar</Link><span aria-hidden>/</span><b>Your rocket</b></nav>
      {wallet === null ? (
        <div className="hg-empty">
          <b>Sign in to see your rocket</b>
          <p>Your skins, trails and crates live here, and they fly in every mode.</p>
          <button type="button" className="dsc3-btn dsc3-btn-primary" onClick={() => window.dispatchEvent(new Event(WALLET_CTA_CLICK_EVENT))}>Sign in</button>
        </div>
      ) : (
        <>
          <nav className="hgr-tabs" aria-label="Your rocket">
            <a href="#hg-looks" onClick={(e) => { e.preventDefault(); document.getElementById("hg-looks")?.closest("section")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>Collection</a>
            <a href="#crates" onClick={(e) => { e.preventDefault(); document.getElementById("hg-crates")?.closest("section")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>Crates{col?.crates?.length ? <i>{col.crates.length}</i> : null}</a>
          </nav>
          <YourRocket col={col} wallet={wallet || null} handle={handle} />
          <Crates col={col} wallet={wallet || null} />
        </>
      )}
    </div>
  );
}
