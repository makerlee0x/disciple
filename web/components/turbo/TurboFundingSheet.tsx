"use client";
/**
 * Add fuel — follows Nova's "Fund your Nova wallet." sheet (lee's screenshot fund-nova-wallet.png): USDC, Arbitrum only,
 * copy the deposit address, funds appear automatically once confirmed. No Privy, no private-key export, no "deposit any
 * crypto", no bridge, no login. No address is shown until Nova provides one (adapter.depositInfo().address).
 * While the stand-in adapter answers, a separate box adds stand-in fuel on this device so the screens can be tried;
 * it never pretends an on-chain deposit confirmed.
 */
import { useEffect, useState } from "react";
import type { DepositInfo, TurboAdapter } from "@/lib/turbo";
import { TURBO_COPY as C } from "@/lib/turbo/copy";
import { usd } from "@/lib/turbo/format";
import s from "./turbo.module.css";

const STAND_IN_ADD = 100;

export default function TurboFundingSheet({ adapter, onClose }: { adapter: TurboAdapter; onClose: () => void }) {
  const info: DepositInfo = adapter.depositInfo?.() ?? { token: "USDC", network: "Arbitrum", address: null };
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);
  const copy = async () => { if (!info.address) return; try { await navigator.clipboard.writeText(info.address); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* ignore */ } };
  const standIn = adapter.kind === "practice" && !!adapter.addFuel;
  return (
    <div className={s.dim} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={C.addFuel} className={s.sheet} data-testid="turbo-funding-sheet">
        <button type="button" className={s.x} aria-label="Close" onClick={onClose}>×</button>
        <div className={s.fundPath}><span className={s.pill}>{C.fundTokenValue}</span><span className={s.dash} /><span className={s.pill}>{C.fuel}</span></div>
        <h2 className={s.fundTitle}><span>{C.fundTitle1}</span><br />{C.fundTitle2}</h2>
        <div className={s.fundCard}>
          <div className={s.fundRow}>
            <div className={s.qr} aria-hidden>{info.address ? "QR" : "—"}</div>
            <div className={s.fundFacts}>
              <div className={s.k}>{C.fundNetwork}</div><div className={s.v}>{C.fundNetworkValue}</div>
              <div className={s.sep} />
              <div className={s.k}>{C.fundToken}</div><div className={s.v}>{C.fundTokenValue}</div>
            </div>
          </div>
          <div className={s.addr} data-testid="turbo-deposit-address">{info.address ?? C.fundNoAddress}</div>
          <button type="button" className={s.copyBtn} disabled={!info.address} onClick={copy}>{copied ? C.fundCopied : C.fundCopy}</button>
        </div>
        <p className={s.fundNote}>{C.fundConfirm}</p>
        {standIn && <div className={s.standIn} data-testid="turbo-standin-fuel">
          <div className={s.k}>{C.fundStandInTitle}</div>
          <p>{C.fundStandInBody}</p>
          <button type="button" className={s.ghostBtn} onClick={async () => { setErr(""); try { await adapter.addFuel!(STAND_IN_ADD); onClose(); } catch (e) { setErr(e instanceof Error ? e.message : C.failed); } }}>
            {C.fundStandInButton(usd(STAND_IN_ADD, 0))}</button>
          {err && <p className={s.err}>{err}</p>}
        </div>}
      </div>
    </div>
  );
}
