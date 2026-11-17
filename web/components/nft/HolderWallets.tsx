"use client";
/**
 * Edit profile → Holder wallets: link a Solana wallet (Disciples) and an Ethereum wallet (founder passes) to this profile.
 * Each link is signed by the holder wallet and by the profile wallet (/api/nft/link). No explainer copy (CLAUDE.md copy rule).
 */
import { useState } from "react";
import { linkHolder, short, unlinkHolder } from "@/lib/nft/client";
import type { HolderChain, HolderStatus } from "@/lib/nft/config";
import { evmConnect, evmSignMessage, solConnect, solSignMessage, type EvmWallet, type SolWallet } from "@/lib/nft/wallets";
import WalletChooser from "./WalletChooser";

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

export default function HolderWallets({ wallet, status, onChange }: { wallet: string | null; status: HolderStatus; onChange: (s: HolderStatus) => void }) {
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

  return (
    <div className="p5-fld" role="group" aria-label="Holder wallets" data-testid="holder-wallets">
      <span className="lab">Holder wallets</span>
      {(["sol", "eth"] as const).map((c) => {
        const linked = status[c];
        const n = c === "sol" ? status.disciples : status.founders;
        return (
          <div key={c}>
            <div className="nft-hrow">
              <span className={`nft-chain ${c}`} aria-hidden>{c === "sol" ? "◎" : "Ξ"}</span>
              <span className="u">{linked ? short(linked) : LABEL[c]}</span>
              {linked && n > 0 && <span className="nft-count">{n} {c === "sol" ? (n === 1 ? "Disciple" : "Disciples") : n === 1 ? "pass" : "passes"}</span>}
              {linked
                ? <button type="button" className="p5-btn sm" disabled={busy} onClick={() => void remove(c)}>Remove</button>
                : <button type="button" className="p5-btn sm" disabled={busy} aria-expanded={open === c} onClick={() => setOpen(open === c ? null : c)}>Link</button>}
            </div>
            {open === c && !linked && <WalletChooser chain={c} busy={busy} onPick={(w) => void pick(c, w)} />}
          </div>
        );
      })}
      {err && <span className="p5-err" role="alert">{err}</span>}
    </div>
  );
}
