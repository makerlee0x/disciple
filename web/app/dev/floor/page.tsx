"use client";
/**
 * Dev fixture (not linked from nav): the graduation floor bins card on the REAL band geometry (lib/floor floorFixture:
 * 16 bands, $1,201 seeded at a $33,333 graduation), at a few current prices. Used for screenshots while no coin has
 * graduated on the preview chain. ?now=<mcap> picks one price.
 */
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { FloorBinsCard } from "@/components/floor/FloorBins";
import { buildFloorView, floorFixture } from "@/lib/floor";

function Inner() {
  const sp = useSearchParams();
  const one = Number(sp.get("now"));
  const nows = one > 0 ? [one] : [40_000, 27_500, 9_000];
  return (
    <main style={{ padding: 24, minHeight: "100vh", background: "var(--dsc-bg)", color: "var(--dsc-text)", display: "flex", flexDirection: "column", gap: 18, alignItems: "flex-start" }}>
      <h1 style={{ font: "400 22px var(--dsc-font-display)", margin: 0 }}>Floor bins · fixture</h1>
      <p style={{ margin: 0, fontSize: 12, color: "var(--dsc-muted)" }}>Dev only · sample data on the contract&apos;s band layout · not live</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
        {nows.map((n) => {
          const fx = floorFixture(33_333, 1_201, n);
          const v = buildFloorView(fx.info, fx.bands);
          return v ? <FloorBinsCard key={n} view={v} nowMcap={n} /> : null;
        })}
      </div>
    </main>
  );
}

export default function FloorFixturePage() {
  return <Suspense fallback={null}><Inner /></Suspense>;
}
