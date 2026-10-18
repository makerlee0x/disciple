"use client";
/** Shared bits for the claim screens: wallet/caps hooks, money line, confirm sheet, tx link. Lunar v2 styling (app/claims.css). */
import { useEffect, useState, type ReactNode } from "react";
import type { Address, Hex, PublicClient } from "viem";
import { ACTIVE_CHAIN, isDeployed } from "@/lib/chains";
import { onWallet } from "@/lib/wallet";
import { publicClient } from "@/lib/protocol-viem";
import { probeCaps, staticCaps, type Caps } from "@/lib/claims/capabilities";
import { DEMO_CAPS, demoEnabled, demoRedeploy } from "@/lib/claims/demo";
import { fmtAmount, fmtUsd, toUsd, type Asset } from "@/lib/claims/common";

let pcInst: PublicClient | null = null;
export const pc = () => (pcInst ??= publicClient());

/** Connected trading account (smart account in one-tap mode, else the EOA). */
export function useWalletAddr(): Address | null {
  const [a, setA] = useState<Address | null>(null);
  useEffect(() => onWallet((x) => setA(x)), []);
  return a;
}

const NONE: Caps = { creatorFees: false, referrerFees: false, creatorTokenFees: false, crew: false, referralGate: false, anonClaims: false };
/** Capabilities after the on-chain probe (redeploy features stay off until it passes). Demo mode: sample caps. */
export function useCaps(): { caps: Caps; ready: boolean; demo: boolean } {
  const [st, setSt] = useState<{ caps: Caps; ready: boolean; demo: boolean }>({ caps: NONE, ready: false, demo: false });
  useEffect(() => {
    if (demoEnabled()) { setSt({ caps: DEMO_CAPS(demoRedeploy()), ready: true, demo: true }); return; }
    if (!isDeployed()) { setSt({ caps: NONE, ready: true, demo: false }); return; }
    const s = staticCaps();
    setSt({ caps: { ...s, creatorTokenFees: false, crew: false, referralGate: false }, ready: false, demo: false });
    let alive = true;
    probeCaps(pc()).then((c) => { if (alive) setSt({ caps: c, ready: true, demo: false }); }).catch(() => { if (alive) setSt((x) => ({ ...x, ready: true })); });
    return () => { alive = false; };
  }, []);
  return st;
}

export function Money({ raw, asset, big }: { raw: bigint; asset: Asset; big?: boolean }) {
  const usd = toUsd(raw, asset);
  return (
    <span className={"cl-money" + (big ? " big" : "")}>
      <span className="amt">{fmtAmount(raw, asset)}</span>
      {usd != null && <span className="usd">≈ {fmtUsd(usd)}</span>}
    </span>
  );
}

export const shortA = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export function TxLink({ hash, children }: { hash: Hex | string; children?: ReactNode }) {
  const base = ACTIVE_CHAIN.blockExplorers?.default.url;
  return base ? <a className="cl-tx" href={`${base}/tx/${hash}`} target="_blank" rel="noreferrer noopener">{children ?? shortA(hash)}</a> : <span className="cl-tx">{children ?? shortA(hash)}</span>;
}

export type ConfirmLine = { label: string; raw: bigint; asset: Asset };
/** Claim confirm state: what lands where, then Confirm. */
export function ConfirmSheet({ title, lines, to, note, busy, error, done, onConfirm, onClose, confirmLabel = "Confirm claim" }: {
  title: string; lines: ConfirmLine[]; to: string | null; note?: string; busy?: boolean; error?: string | null; done?: Hex | null;
  onConfirm: () => void; onClose: () => void; confirmLabel?: string;
}) {
  return (
    <div className="cl-sheet-wrap" role="dialog" aria-modal="true" aria-label={title} data-testid="claim-confirm">
      <div className="cl-sheet">
        <div className="cl-eyebrow">{done ? "Done" : "Confirm"}</div>
        <h3 className="cl-display">{done ? "Claimed" : title}</h3>
        <ul className="cl-lines">
          {lines.map((l, i) => (
            <li key={i}><span className="muted">{l.label}</span><Money raw={l.raw} asset={l.asset} /></li>
          ))}
        </ul>
        {to && <div className="cl-to"><span className="muted">To</span><code>{shortA(to)}</code></div>}
        {note && !done && <p className="cl-note">{note}</p>}
        {error && <p className="cl-err" role="alert">{error}</p>}
        {done && <p className="cl-ok">Sent · <TxLink hash={done} /></p>}
        <div className="cl-actions">
          <button type="button" className="cl-btn ghost" onClick={onClose}>{done ? "Close" : "Cancel"}</button>
          {!done && <button type="button" className="cl-btn primary" disabled={busy} onClick={onConfirm} data-testid="claim-confirm-btn">{busy ? "Sending…" : confirmLabel}</button>}
        </div>
      </div>
    </div>
  );
}

export function SampleTag({ show }: { show: boolean }) {
  return show ? <span className="cl-sample" data-testid="sample-tag">SAMPLE DATA · not live</span> : null;
}
