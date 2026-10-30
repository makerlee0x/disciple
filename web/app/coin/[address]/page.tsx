"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { erc20Abi, isAddress, type Address } from "viem";
import FlightCanvas from "@/components/FlightCanvas";
import CrewPanel from "@/components/CrewPanel";
import { CREW_CARD_ENABLED } from "@/lib/features";
import PnlHud from "@/components/PnlHud";
import DiscipleFeed from "@/components/DiscipleFeed";
import TrampWallPanel from "@/components/trampwalls/TrampWallPanel";
import TradeBridge from "@/components/TradeBridge";
import SnipeCountdown from "@/components/flight/SnipeCountdown";
import CoinIdentity from "@/components/pairart/CoinIdentity";
import CoinClaims from "@/components/claims/CoinClaims";
import CardChrome from "@/components/flight/CardChrome";
import DexChart from "@/components/flight/DexChart";
import { isDeployed } from "@/lib/chains";
import { DEMO_POOL, STRATEGY_TOKEN } from "@/lib/config";
import { PROTOCOL_META } from "@/lib/protocol";
import { publicClient, readCurveState } from "@/lib/protocol-viem";
import { basePair } from "@/lib/pairArt";

function FlightInner({ address }: { address: string }) {
  const sp = useSearchParams();
  const demo0 = address.toLowerCase() === DEMO_POOL.address;
  // The coin's real quote token from its launch (curve state). The engine writes its params back into the URL, so a
  // stale ?quote= (e.g. the old STRATEGY default on a USDG-paired coin) would otherwise stick forever.
  const [realQuote, setRealQuote] = useState<string | null>(null);
  useEffect(() => {
    if (demo0 || !isDeployed() || !isAddress(address)) return;
    let alive = true;
    const pc = publicClient();
    readCurveState(pc, address as Address)
      .then((st) => pc.readContract({ address: st.quote as Address, abi: erc20Abi, functionName: "symbol" }))
      .then((sym) => { if (alive && sym) setRealQuote(String(sym)); })
      .catch((e) => console.warn("[disciple] coin page: quote token read failed; keeping URL quote", e));
    return () => { alive = false; };
  }, [address, demo0]);
  const search = useMemo(() => {
    const q = new URLSearchParams(sp.toString());
    if (!q.has("coin")) q.set("coin", address);
    // DISCIPLE curve coins use the event-fed engine source; the AI/WETH v3 demo keeps its Swap path.
    if (isDeployed() && address.toLowerCase() !== DEMO_POOL.address && !q.has("source") && q.get("replay") !== "1") q.set("source", "disciple");
    // minimap pool label (Uniswap style "$TICKER/QUOTE fee%"): quote + total fee = LP fee + hook fee
    const demo = address.toLowerCase() === DEMO_POOL.address;
    // launchpad links carry ?cs=TICKER: hand it to the engine so its chart label names the coin instead of "COIN"
    if (!q.has("ticker") && q.get("cs")) q.set("ticker", q.get("cs") as string);
    // real quote (launch data) > launchpad ?pair= > existing ?quote= > default. Plain label: mUSDG shows as USDG.
    const known = realQuote ?? (demo ? null : sp.get("pair"));
    if (known) q.set("quote", basePair(known)?.sym ?? known);
    else if (!q.has("quote")) q.set("quote", demo ? DEMO_POOL.ticker.split("/")[1].trim() : STRATEGY_TOKEN.symbol);
    if (!q.has("feeBps")) q.set("feeBps", String(demo ? DEMO_POOL.fee / 100 : PROTOCOL_META.hookFeeBps + PROTOCOL_META.v4PoolFee / 100));
    return q.toString();
  }, [sp, address, realQuote]);

  return (
    <>
      <FlightCanvas search={search} />
      {/* CREW card: off by default since the Oct 30 cleanup (NEXT_PUBLIC_FEATURE_CREW_CARD=1 brings it back); its buy presets + orb-rain unlock are gone even then (pass 2) */}
      {CREW_CARD_ENABLED && <CrewPanel coin={address} />}
      <PnlHud coin={address} />
      {/* DEX-style mcap chart (GAME, Oct 30): lightweight-charts card; the engine's canvas chart stays for the v3 demo / replays */}
      {isDeployed() && !demo0 && isAddress(address) && sp.get("replay") !== "1" && sp.get("clean") !== "1" && <DexChart coin={address} ticker={sp.get("ticker") || sp.get("cs")} />}
      <DiscipleFeed token={address} />
      <TrampWallPanel token={address} />
      <TradeBridge token={address} />
      <SnipeCountdown token={address} />
      <CoinIdentity address={address} sp={new URLSearchParams(sp.toString())} />
      <CoinClaims token={address} />
      {/* pass 3 #4 (GAME): drag / minimize / close every desktop card + LAYOUT menu (per-account, localStorage) */}
      <CardChrome />
      {/* Share (trade card + rocket card) lives in the ESC settings menu (FlightCanvas → SettingsMenu), not a floating pill */}
    </>
  );
}

export default function CoinPage({
  params,
}: {
  params: { address: string };
}) {
  return (
    <Suspense
      fallback={
        <div className="tier-sky-placeholder flex h-screen items-center justify-center text-[#C9CED6]">
          Loading flight…
        </div>
      }
    >
      <FlightInner address={params.address} />
    </Suspense>
  );
}
