"use client";
/** Dev gallery: every base pair at every PairArt size (header / grid / list / icon). */
import PairArt from "@/components/pairart/PairArt";
import { withBase } from "@/lib/base-path";
import { BASE_PAIRS, SAMPLE_SQUARES, SAYLOR_SQUARE } from "@/lib/pairArt";

export default function PairArtGallery() {
  return (
    <main style={{ padding: 24, color: "#fff7df", background: "#070914", minHeight: "100vh" }}>
      <h1 style={{ font: "bold 22px Georgia, serif", margin: "0 0 4px" }}>Pair art</h1>
      <p style={{ opacity: 0.6, fontSize: 12, margin: "0 0 18px" }}>header 220 · grid 150 · list 40 · icon 24 / 16</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
        {BASE_PAIRS.map((p, i) => {
          const src = withBase(i === 0 ? SAYLOR_SQUARE : SAMPLE_SQUARES[i % SAMPLE_SQUARES.length]);
          return (
            <div key={p.tk} style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
              {i === 0 ? <PairArt src={src} pair={p.sym} size="header" eager /> : <PairArt src={src} pair={p.sym} size="grid" eager />}
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <PairArt src={src} pair={p.sym} size="list" eager />
                <PairArt src={src} pair={p.sym} size="icon" eager />
                <PairArt src={src} pair={p.sym} size="icon" px={16} eager />
                <span style={{ fontSize: 12 }}>{p.sym}{p.real ? "" : " · placeholder"}</span>
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
