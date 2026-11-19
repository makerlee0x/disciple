"use client";
/**
 * Edit profile → Holder wallets: link a Solana wallet (Disciples) and an Ethereum wallet (founder passes) to this profile.
 * Each link is signed by the holder wallet and by the profile wallet (/api/nft/link). No explainer copy (CLAUDE.md copy rule).
 */
import { useState } from "react";
import { linkHolder, short, unlinkHolder } from "@/lib/nft/client";
import { DISCIPLES_LIVE, type HolderChain, type HolderStatus } from "@/lib/nft/config";
import { evmConnect, evmSignMessage, solConnect, solSignMessage, type EvmWallet, type SolWallet } from "@/lib/nft/wallets";
import WalletChooser from "./WalletChooser";
import ChainLogo from "./ChainLogo";

/** Connect + link one holder wallet. Shared by Holder wallets and Connect NFT. */
export async function connectAndLink(profile: string, chain: HolderChain, w: SolWallet | EvmWallet) {
  if (w.kind === "sol") {
    const acc = await solConnect(w);
    return linkHolder(profile, "sol", acc.address, (m) => solSignMessage(w, acc, m));
  }
  const addr = await evmConnect(w);
  return linkHolder(profile, chain, addr, (m) => evmSignMessage(w, addr, m));
}

const LABEL: Record<HolderChain, string> = { sol: "Solana", eth: "Ethereum" };
/** Solana hidden until the Disciples hand-over (maker 2026-11-18); Ethereum (The Twelve) stays. */
const CHAINS: readonly HolderChain[] = DISCIPLES_LIVE ? ["sol", "eth"] : ["eth"];

/** tiles: render as compact grid tiles inside Edit profile's Linked accounts row (.p5-links), next to the X tile. */
export default function HolderWallets({ wallet, status, onChange, tiles = false }: { wallet: string | null; status: HolderStatus; onChange: (s: HolderStatus) => void; tiles?: boolean }) {
  const [open, setOpen] = useState<HolderChain | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!wallet) return null;

  async function pick(chain: HolderChain, w: SolWallet | EvmWallet) {
    setBusy(true); setErr("");
    try {
      const r = await connectAndLink(wallet!, chain, w);
      if (r.ok && r.status) { onChange(r.status); setOpen(null); } else setErr(r.reason || "Couldn't link that wallet.");
    } catch (e) { setErr(e instanceof Error && e.message ? e.message : "Couldn't link that wallet."); }
    setBusy(false);
  }
  async function remove(chain: HolderChain) {
    setBusy(true); setErr("");
    const r = await unlinkHolder(wallet!, chain);
    if (r.ok && r.status) onChange(r.status); else setErr(r.reason || "Couldn't remove that wallet.");
    setBusy(false);
  }

  const btn = (c: HolderChain) => status[c]
    ? <button type="button" className="p5-btn sm" disabled={busy} onClick={() => void remove(c)}>Remove</button>
    : <button type="button" className="p5-btn sm" disabled={busy} aria-expanded={open === c} onClick={() => setOpen(open === c ? null : c)}>Link</button>;
  const count = (c: HolderChain) => {
    const n = c === "sol" ? status.disciples : status.founders;
    if (!status[c] || n <= 0) return null;
    return <span className="nft-count">{n} {c === "sol" ? (n === 1 ? "Disciple" : "Disciples") : n === 1 ? "Access Key" : "Access Keys"}</span>;
  };
  const chooser = open && !status[open] ? <WalletChooser chain={open} busy={busy} onPick={(w) => void pick(open, w)} /> : null;

  if (tiles) return (
    <>
      {CHAINS.map((c) => (
        <div key={c} className={`p5-link${open === c ? " on" : ""}`} data-testid={`holder-${c}`}>
          <div className="p5-link-top">
            <ChainLogo chain={c} />
            <span className="u mono">{status[c] ? short(status[c]!) : LABEL[c]}</span>
          </div>
          {count(c)}
          {btn(c)}
        </div>
      ))}
      {chooser && <div className="p5-link-wide">{chooser}</div>}
      {err && <span className="p5-err p5-link-wide" role="alert">{err}</span>}
    </>
  );

  return (
    <div className="p5-fld" role="group" aria-label="Holder wallets" data-testid="holder-wallets">
      <span className="lab">Holder wallets</span>
      {CHAINS.map((c) => (
        <div key={c}>
          <div className="nft-hrow">
            <ChainLogo chain={c} />
            <span className="u">{status[c] ? short(status[c]!) : LABEL[c]}</span>
            {count(c)}
            {btn(c)}
          </div>
          {open === c && chooser}
        </div>
      ))}
      {err && <span className="p5-err" role="alert">{err}</span>}
    </div>
  );
}
