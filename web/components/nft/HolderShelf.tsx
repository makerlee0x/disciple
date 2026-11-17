"use client";
/**
 * /market holder shelf (maker 2026-11-17): The Twelve (Ethereum founder passes, traded on OpenSea), the Disciples tile
 * (→ /mint) and a sealed holders crate. The crate is a tease only: no words about what's inside or when, ever.
 * Web only (the market already is).
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { withBase } from "@/lib/base-path";
import { crateArt } from "@/lib/collection";
import { fetchFounders, fetchMintStatus, type FounderPass, type MintStatus } from "@/lib/nft/client";
import { DISCIPLE_SUPPLY, FOUNDER_COUNT, FOUNDER_URL, IMAGE_BASE } from "@/lib/nft/config";

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
/** a few revealed disciples for the tile mosaic */
const MOSAIC = [0, 181, 412, 776].map((i) => `${IMAGE_BASE}${i}`);

export default function HolderShelf() {
  const [passes, setPasses] = useState<FounderPass[] | null>(null);
  const [mint, setMint] = useState<MintStatus | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchFounders().then((f) => { if (alive) setPasses(f?.passes ?? null); });
    void fetchMintStatus().then((m) => { if (alive) setMint(m); });
    return () => { alive = false; };
  }, []);
  const tiles = passes?.length ? passes.slice(0, FOUNDER_COUNT) : null;

  return (
    <div className="nft-shelf" data-testid="holder-shelf">
      <section className="nft-twelve dsc3-panel" aria-labelledby="nft-twelve-h">
        <header>
          <h2 id="nft-twelve-h">The Twelve</h2>
          <span className="nft-chip">Ethereum</span>
          <span className="nft-chip">{FOUNDER_COUNT} passes</span>
          <a className="dsc3-btn dsc3-btn-ghost nft-os" href={FOUNDER_URL} target="_blank" rel="noopener noreferrer">OpenSea ↗</a>
        </header>
        <div className="nft-twelve-row">
          {tiles
            ? tiles.map((p) => (
              <a key={p.id} className="nft-pass" href={p.url} target="_blank" rel="noopener noreferrer" aria-label={p.name}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {p.image ? <img src={p.image} alt="" loading="lazy" /> : <i>{p.id}</i>}
              </a>
            ))
            : ROMAN.map((r) => <a key={r} className="nft-pass sealed" href={FOUNDER_URL} target="_blank" rel="noopener noreferrer" aria-label={`Founder pass ${r}`}><i>{r}</i></a>)}
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
        <div className="nft-sealed dsc3-panel" data-testid="shelf-sealed">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={withBase(crateArt("mythic"))} alt="" />
          <span className="nft-sealed-tx"><b>Holders</b><span aria-label="watching">👀</span></span>
          <span className="nft-sealed-marks" aria-hidden><i>◎</i><i>Ξ</i></span>
        </div>
      </div>
    </div>
  );
}
