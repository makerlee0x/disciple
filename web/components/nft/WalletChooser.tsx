"use client";
/** Pick an installed Solana or Ethereum wallet. Phone with no Solana wallet: reopen the page in Phantom. */
import { useEffect, useState } from "react";
import { evmWallets, isPhone, onSolanaWallets, phantomBrowseUrl, solanaWallets, type EvmWallet, type SolWallet } from "@/lib/nft/wallets";

export function useWallets(chain: "sol" | "eth") {
  const [list, setList] = useState<(SolWallet | EvmWallet)[] | null>(null);
  useEffect(() => {
    let alive = true;
    if (chain === "sol") { const read = () => alive && setList(solanaWallets()); read(); const off = onSolanaWallets(read); return () => { alive = false; off(); }; }
    void evmWallets().then((w) => { if (alive) setList(w); });
    return () => { alive = false; };
  }, [chain]);
  return list;
}

export default function WalletChooser({ chain, busy, onPick }: { chain: "sol" | "eth"; busy?: boolean; onPick: (w: SolWallet | EvmWallet) => void }) {
  const list = useWallets(chain);
  if (list === null) return <div className="nft-wl" aria-busy="true"><span className="nft-pulse" /></div>;
  if (!list.length) {
    if (chain === "sol" && isPhone()) return <div className="nft-wl"><a className="nft-wbtn" href={phantomBrowseUrl(window.location.href)}>Open in Phantom</a></div>;
    return <div className="nft-wl"><p className="nft-none">{chain === "sol" ? "No Solana wallet found" : "No Ethereum wallet found"}</p></div>;
  }
  return (
    <div className="nft-wl" role="group" aria-label="Wallets">
      {list.map((w) => (
        <button key={w.name} type="button" className="nft-wbtn" disabled={busy} onClick={() => onPick(w)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {w.icon ? <img src={w.icon} alt="" width={22} height={22} /> : null}
          <span>{w.name}</span>
        </button>
      ))}
    </div>
  );
}
