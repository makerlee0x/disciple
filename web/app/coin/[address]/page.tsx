"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useMemo } from "react";
import FlightCanvas from "@/components/FlightCanvas";
import CrewPanel from "@/components/CrewPanel";
import ShareButton from "@/components/ShareButton";
import PnlHud from "@/components/PnlHud";
import DiscipleFeed from "@/components/DiscipleFeed";
import TrampWallPanel from "@/components/trampwalls/TrampWallPanel";
import TradeBridge from "@/components/TradeBridge";
import CoinIdentity from "@/components/pairart/CoinIdentity";
import { isDeployed } from "@/lib/chains";
import { DEMO_POOL, STRATEGY_TOKEN } from "@/lib/config";
import { PROTOCOL_META } from "@/lib/protocol";

function FlightInner({ address }: { address: string }) {
  const sp = useSearchParams();
  const search = useMemo(() => {
    const q = new URLSearchParams(sp.toString());
    if (!q.has("coin")) q.set("coin", address);
    // DISCIPLE curve coins use the event-fed engine source; the AI/WETH v3 demo keeps its Swap path.
    if (isDeployed() && address.toLowerCase() !== DEMO_POOL.address && !q.has("source") && q.get("replay") !== "1") q.set("source", "disciple");
    // minimap pool label (Uniswap style "$TICKER/QUOTE fee%"): quote + total fee = LP fee + hook fee
    const demo = address.toLowerCase() === DEMO_POOL.address;
    if (!q.has("quote")) q.set("quote", demo ? DEMO_POOL.ticker.split("/")[1].trim() : STRATEGY_TOKEN.symbol);
    if (!q.has("feeBps")) q.set("feeBps", String(demo ? DEMO_POOL.fee / 100 : PROTOCOL_META.hookFeeBps + PROTOCOL_META.v4PoolFee / 100));
    return q.toString();
  }, [sp, address]);

  return (
    <>
      <FlightCanvas search={search} />
      <CrewPanel coin={address} />
      <PnlHud coin={address} />
      <DiscipleFeed token={address} />
      <TrampWallPanel token={address} />
      <TradeBridge token={address} />
      <CoinIdentity address={address} sp={new URLSearchParams(sp.toString())} />
      <ShareButton callSign={sp.get("cs") || "AI"} icon={sp.get("icon")} />
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
