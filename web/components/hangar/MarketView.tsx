"use client";
/** /market: the website-only market (components/hangar/Market MarketPage), on the Hangar page shell. */
import { useEffect, useState } from "react";
import { onWallet } from "@/lib/walletState";
import { MarketPage } from "./Market";

export default function MarketView() {
  const [wallet, setWallet] = useState<string | null>(null);
  useEffect(() => onWallet((a) => setWallet(a ? a.toLowerCase() : null)), []);
  return <div className="profile-page hg mkt-page"><MarketPage wallet={wallet} /></div>;
}
