"use client";
/**
 * /market: your crates on top (maker 2026-11-17: crates belong with the market, not on the profile), then the website-only
 * market (components/hangar/Market MarketPage), on the Hangar page shell. Crates open in the app too; only buying and
 * selling is website-only.
 */
import { useEffect, useState } from "react";
import { onWallet } from "@/lib/walletState";
import { useCollection } from "@/lib/collectionClient";
import { Crates } from "./Collection";
import { MarketPage } from "./Market";

export default function MarketView() {
  const [wallet, setWallet] = useState<string | null>(null);
  useEffect(() => onWallet((a) => setWallet(a ? a.toLowerCase() : null)), []);
  const { col } = useCollection(wallet);
  // the profile's Your rocket card ("Open 2 crates") lands on #crates
  useEffect(() => { if (col && window.location.hash === "#crates") document.getElementById("hg-crates")?.closest("section")?.scrollIntoView({ block: "start" }); }, [col]);
  return (
    <div className="profile-page hg mkt-page">
      {wallet && <Crates col={col} wallet={wallet} />}
      <MarketPage wallet={wallet} />
    </div>
  );
}
