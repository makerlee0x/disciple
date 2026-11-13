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
import ClaimSheet, { type ClaimRow } from "./ClaimSheet";

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

export type ConfirmLine = { label: string; raw: bigint; asset: Asset; sub?: string | null };
/** Is this asset cash (USDG, ~$1)? */
export const isCashAsset = (a: Asset) => a.symbol === "USDG" || (a.usd != null && Math.abs(a.usd - 1) < 0.05 && /USD/i.test(a.symbol));
/**
 * Claim confirm (the round 2 claim sheet, components/claims/ClaimSheet): "You get $x", the split, Claim. Old props stay
 * for callers; `to` and `note` are no longer shown (dollars and where they land, never addresses or contract names).
 */
export function ConfirmSheet({ title, lines, feeNote, busy, error, done, onConfirm, onClose, confirmLabel }: {
  title: string; lines: ConfirmLine[]; to?: string | null; note?: string; feeNote?: string | null; busy?: boolean; error?: string | null; done?: Hex | null;
  onConfirm: () => void; onClose: () => void; confirmLabel?: string;
}) {
  const rows: ClaimRow[] = lines.map((l) => ({ label: l.label, sub: l.sub ?? (isCashAsset(l.asset) ? null : `Paid in ${l.asset.symbol}`), usd: toUsd(l.raw, l.asset) ?? 0 }));
  return <ClaimSheet title={title} rows={rows} allCash={lines.every((l) => isCashAsset(l.asset))} feeNote={feeNote} busy={busy} error={error} done={done}
    onConfirm={onConfirm} onClose={onClose} confirmLabel={confirmLabel && confirmLabel !== "Confirm claim" ? confirmLabel : undefined} />;
}

export function SampleTag({ show }: { show: boolean }) {
  return show ? <span className="cl-sample" data-testid="sample-tag">SAMPLE DATA · not live</span> : null;
}
