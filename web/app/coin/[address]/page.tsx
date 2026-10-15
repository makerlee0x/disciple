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
import { isDeployed } from "@/lib/chains";
import { DEMO_POOL } from "@/lib/config";

function FlightInner({ address }: { address: string }) {
  const sp = useSearchParams();
  const search = useMemo(() => {
    const q = new URLSearchParams(sp.toString());
    if (!q.has("coin")) q.set("coin", address);
    // DISCIPLE curve coins use the event-fed engine source; the AI/WETH v3 demo keeps its Swap path.
    if (isDeployed() && address.toLowerCase() !== DEMO_POOL.address && !q.has("source") && q.get("replay") !== "1") q.set("source", "disciple");
    return q.toString();
  }, [sp, address]);

  return (
    <>
      <FlightCanvas search={search} />
      <CrewPanel />
      <PnlHud coin={address} />
      <DiscipleFeed token={address} />
      <TrampWallPanel token={address} />
      <TradeBridge token={address} />
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
        <div className="flex h-screen items-center justify-center text-[#ffe7a3]">
          Loading flight…
        </div>
      }
    >
      <FlightInner address={params.address} />
    </Suspense>
  );
}
