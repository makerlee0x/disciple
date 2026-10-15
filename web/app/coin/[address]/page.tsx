"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useMemo } from "react";
import FlightCanvas from "@/components/FlightCanvas";

function FlightInner({ address }: { address: string }) {
  const sp = useSearchParams();
  const search = useMemo(() => {
    const q = new URLSearchParams(sp.toString());
    if (!q.has("coin")) q.set("coin", address);
    return q.toString();
  }, [sp, address]);

  return <FlightCanvas search={search} />;
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
