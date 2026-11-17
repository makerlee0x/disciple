"use client";
/**
 * /market: the storefront (components/hangar/MarketShop) with your crates as a slim strip under the featured banner
 * (maker 2026-11-17: crates belong with the market). The strip opens the full Crates panel (odds, open, reveal).
 * Crates open in the app too; only buying and selling is website-only.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { withBase } from "@/lib/base-path";
import { RARITIES, RARITY_COLOR as SW, crateArt } from "@/lib/collection";
import { onWallet } from "@/lib/walletState";
import { useCollection } from "@/lib/collectionClient";
import { Crates } from "./Collection";
import { MarketShop } from "./MarketShop";

export default function MarketView() {
  const [wallet, setWallet] = useState<string | null>(null);
  useEffect(() => onWallet((a) => setWallet(a ? a.toLowerCase() : null)), []);
  const { col } = useCollection(wallet);
  const [openCrates, setOpenCrates] = useState(false);
  // the profile's Your rocket card ("Open 2 crates") lands on #crates
  useEffect(() => {
    if (col && window.location.hash === "#crates") { setOpenCrates(true); setTimeout(() => document.getElementById("hg-crates")?.closest("section")?.scrollIntoView({ block: "start" }), 50); }
  }, [col]);
  const crates = [...(col?.crates ?? [])].sort((a, b) => RARITIES.indexOf(b.tier) - RARITIES.indexOf(a.tier));
  const strip = wallet && crates.length > 0 ? (
    <>
      <button type="button" className={`mk-crates${openCrates ? " on" : ""}`} onClick={() => setOpenCrates((v) => !v)} aria-expanded={openCrates} data-testid="crates-strip">
        <span className="mk-crates-art">{crates.slice(0, 4).map((c) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={c.id} src={withBase(crateArt(c.tier))} alt="" style={{ ["--sw" as string]: SW[c.tier] } as CSSProperties} />
        ))}</span>
        <span className="mk-crates-tx"><b>{crates.length} {crates.length === 1 ? "crate" : "crates"} ready</b><small>Open, then list what you pull</small></span>
        <span className="dsc3-btn dsc3-btn-primary">{openCrates ? "Close" : "Open"}</span>
      </button>
      {openCrates && <Crates col={col} wallet={wallet} />}
    </>
  ) : null;
  return (
    <div className="profile-page hg mkt-page">
      <MarketShop wallet={wallet} crates={strip} />
    </div>
  );
}
