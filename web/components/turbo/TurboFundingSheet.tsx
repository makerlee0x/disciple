"use client";
/**
 * Add fuel — follows Nova's "Fund your Nova wallet." sheet (lee's screenshot fund-nova-wallet.png): USDC, Arbitrum only,
 * copy the deposit address, funds appear automatically once confirmed. No Privy, no private-key export, no "deposit any
 * crypto", no bridge, no login. No address is shown until Nova provides one (adapter.depositInfo().address).
 * While the stand-in adapter answers, a separate box adds stand-in fuel on this device so the screens can be tried;
 * it never pretends an on-chain deposit confirmed.
 * v2.1 (Nov 13 2026 canvas, "Desktop · Add fuel as a side drawer"): a right drawer on desktop so the pad stays in view,
 * a bottom sheet on phone. The QR box waits for a real address (no QR library ships yet), so it is left out until then.
 */
import { useEffect, useState } from "react";
import type { DepositInfo, TurboAdapter } from "@/lib/turbo";
import { RUN_COPY as RC, TURBO_COPY as C } from "@/lib/turbo/copy";
import { usd } from "@/lib/turbo/format";
import s from "./turbo.module.css";
import r from "./run.module.css";

const STAND_IN_ADD = 100;

function TakeOut({ adapter, onErr }: { adapter: TurboAdapter; onErr: (m: string) => void }) {
  const [amt, setAmt] = useState("");
  return (
    <form onSubmit={async (e) => { e.preventDefault(); const n = +amt; if (!(n > 0)) return; onErr(""); try { await adapter.withdrawFuel!(n); setAmt(""); } catch (err) { onErr(err instanceof Error ? err.message : C.failed); } }}>
      <label className={s.field} style={{ marginBottom: 8 }}><span>$</span>
        <input inputMode="decimal" aria-label={C.takeFuelOut} placeholder="0.00" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
      </label>
      <button type="submit" className={r.drGhost} style={{ width: "100%" }} data-testid="turbo-take-fuel-out">{C.takeFuelOut.toUpperCase()}</button>
    </form>
  );
}

export default function TurboFundingSheet({ adapter, fuel, onClose }: { adapter: TurboAdapter; fuel?: number | null; onClose: () => void }) {
  const info: DepositInfo = adapter.depositInfo?.() ?? { token: "USDC", network: "Arbitrum", address: null };
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);
  const copy = async () => { if (!info.address) return; try { await navigator.clipboard.writeText(info.address); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* ignore */ } };
  const standIn = adapter.kind === "practice" && !!adapter.addFuel;
  const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
  return (
    <div className={r.drawerDim} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={C.addFuel} className={r.drawer} data-testid="turbo-funding-sheet">
        <div className={r.drHead}><span className={r.drTitle}>{C.addFuel.toUpperCase()}</span>
          <button type="button" className={r.iconBtn} aria-label="Close" onClick={onClose}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg></button></div>
        <p className={r.drLead}>{RC.fundLead}</p>
        <div className={r.drCard}>
          <div><span>{C.fundNetwork}</span><b>{C.fundNetworkValue}</b></div>
          <div><span>{C.fundToken}</span><b>{C.fundTokenValue}</b></div>
          <div><span>{RC.yourAddress}</span>{info.address ? <code data-testid="turbo-deposit-address" title={info.address}>{short(info.address)}</code>
            : <em data-testid="turbo-deposit-address">{C.fundNoAddress}</em>}</div>
        </div>
        <button type="button" className={r.drCopy} disabled={!info.address} onClick={copy}>{(copied ? C.fundCopied : C.fundCopy).toUpperCase()}</button>
        <div className={r.drNote}><i />{info.address ? RC.fundWatching : C.fundConfirm}</div>
        {standIn && <div className={r.drStandIn} data-testid="turbo-standin-fuel">
          <b>{C.fundStandInTitle}</b>
          <p>{C.fundStandInBody}</p>
          <button type="button" className={r.drGhost} onClick={async () => { setErr(""); try { await adapter.addFuel!(STAND_IN_ADD); onClose(); } catch (e) { setErr(e instanceof Error ? e.message : C.failed); } }}>
            {C.fundStandInButton(usd(STAND_IN_ADD, 0))}</button>
          {err && <p className={s.err}>{err}</p>}
        </div>}
        <span className={r.grow} />
        <div className={r.drBal}><span>{RC.fundBalance}</span><b>{fuel == null ? "—" : usd(fuel, fuel >= 100 || Number.isInteger(fuel) ? 0 : 2)}</b></div>
        {standIn && adapter.withdrawFuel && <TakeOut adapter={adapter} onErr={setErr} />}
      </div>
    </div>
  );
}
