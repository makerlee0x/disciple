"use client";
/**
 * /market holder shelf (maker 2026-11-17): The Twelve (Ethereum founder passes, all the same art, traded on OpenSea), and the Disciples tile
 * (→ /mint). maker cut the sealed holders crate (2026-11-17).
 * Web only (the market already is).
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { withBase } from "@/lib/base-path";
import { fetchMintStatus, type MintStatus } from "@/lib/nft/client";
import { DISCIPLE_SUPPLY, FOUNDER_COUNT, FOUNDER_URL } from "@/lib/nft/config";

/** four disciples maker picked for the tile (2026-11-17) */
const MOSAIC = ["moses", "angel", "king", "knight"].map((n) => withBase(`/nft/disciple-${n}.webp`));

export default function HolderShelf() {
  const [mint, setMint] = useState<MintStatus | null>(null);
  const passVid = useRef<HTMLVideoElement>(null);
  // play the loop unless the player asked for reduced motion (then the poster still stays)
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    void passVid.current?.play().catch(() => {});
  }, []);
  useEffect(() => {
    let alive = true;
    void fetchMintStatus().then((m) => { if (alive) setMint(m); });
    return () => { alive = false; };
  }, []);

  return (
    <div className="nft-shelf" data-testid="holder-shelf">
      <section className="nft-twelve dsc3-panel" aria-labelledby="nft-twelve-h">
        <a className="nft-pass" href={FOUNDER_URL} target="_blank" rel="noopener noreferrer" aria-label="The Twelve on OpenSea">
          {/* founder pass loop (maker 2026-11-17); the still is the poster and the reduced-motion view */}
          <video src={withBase("/nft/the-twelve.mp4")} poster={withBase("/nft/the-twelve.webp")} ref={passVid} muted loop playsInline preload="metadata" aria-hidden />
        </a>
        <div className="nft-twelve-tx">
          <h2 id="nft-twelve-h">The Twelve</h2>
          <span className="nft-twelve-chips">
            <span className="nft-chip">Ethereum</span>
            <span className="nft-chip">{FOUNDER_COUNT} Moonwalkers</span>
          </span>
          <a className="dsc3-btn dsc3-btn-ghost nft-os" href={FOUNDER_URL} target="_blank" rel="noopener noreferrer">OpenSea ↗</a>
        </div>
      </section>

      <div className="nft-pair">
        <Link href="/mint" className="nft-disc dsc3-panel" data-testid="shelf-mint">
          <span className="nft-mosaic" aria-hidden>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {MOSAIC.map((u) => <img key={u} src={u} alt="" loading="lazy" />)}
          </span>
          <span className="nft-disc-tx">
            <b>Disciples</b>
            <span className="nft-chip">Solana</span>
            {mint?.minted != null && <span className="nft-count-lg">{mint.minted} / {DISCIPLE_SUPPLY}</span>}
          </span>
          <span className="dsc3-btn dsc3-btn-primary">Mint</span>
        </Link>
      </div>
    </div>
  );
}
