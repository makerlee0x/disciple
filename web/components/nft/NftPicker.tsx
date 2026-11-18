"use client";
/**
 * Edit profile → Connect NFT. Grid of the Disciples in the linked Solana wallet (links one first if needed); picking one
 * copies its art in (/api/nft/pfp) and puts it in the picture draft. Only the Disciple collection is offered or accepted.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchOwned, pickNftPfp } from "@/lib/nft/client";
import type { HolderStatus, OwnedNft } from "@/lib/nft/config";
import WalletChooser from "./WalletChooser";
import { connectAndLink } from "./HolderWallets";

export default function NftPicker({ wallet, status, onStatus, onPicked, onClose }: {
  wallet: string; status: HolderStatus; onStatus: (s: HolderStatus) => void;
  onPicked: (imageId: string, name: string) => void; onClose: () => void;
}) {
  const [owned, setOwned] = useState<OwnedNft[] | null | undefined>(undefined);
  const [busy, setBusy] = useState<string>("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!status.sol) { setOwned(undefined); return; }
    let alive = true;
    setOwned(undefined);
    void fetchOwned(wallet).then((o) => { if (alive) setOwned(o); });
    return () => { alive = false; };
  }, [wallet, status.sol]);

  async function choose(n: OwnedNft) {
    setBusy(n.id); setErr("");
    const r = await pickNftPfp(wallet, n.id);
    setBusy("");
    if (r.imageId) onPicked(r.imageId, n.name); else setErr(r.reason || "Couldn't use that NFT.");
  }

  return (
    <div className="nft-pick" data-testid="nft-picker">
      <div className="nft-pick-h">
        <b>Connect NFT</b>
        <button type="button" className="p5-btn sm" onClick={onClose}>Back</button>
      </div>
      {!status.sol ? (
        <WalletChooser chain="sol" busy={!!busy} onPick={async (w) => {
          setBusy("link"); setErr("");
          try { const r = await connectAndLink(wallet, "sol", w); if (r.ok && r.status) onStatus(r.status); else setErr(r.reason || "Couldn't link that wallet."); }
          catch (e) { setErr(e instanceof Error && e.message ? e.message : "Couldn't link that wallet."); }
          setBusy("");
        }} />
      ) : owned === undefined ? (
        <div className="nft-grid" aria-busy="true">{[0, 1, 2, 3].map((i) => <span key={i} className="nft-cell nft-pulse" />)}</div>
      ) : owned === null ? (
        <p className="nft-none">Couldn&apos;t reach Solana. Try again.</p>
      ) : owned.length === 0 ? (
        <div className="nft-empty"><b>No Disciples here</b><Link href="/mint" className="p5-btn sm p5-gold">Mint</Link></div>
      ) : (
        <div className="nft-grid">
          {owned.map((n) => (
            <button key={n.id} type="button" className="nft-cell" disabled={!!busy} onClick={() => void choose(n)} aria-label={n.name} aria-busy={busy === n.id}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={n.thumb || n.image} alt="" loading="lazy" />
              <span>{n.name.replace(/^disciple\s*/i, "")}</span>
            </button>
          ))}
        </div>
      )}
      {err && <p className="p5-err" role="alert">{err}</p>}
    </div>
  );
}
