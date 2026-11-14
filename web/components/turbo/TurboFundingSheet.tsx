"use client";
/**
 * Load fuel (Add cash board 5, maker signed off 2026-11-14): fuel comes from your cash, no addresses, no chains.
 * Pick $10 / $20 / $30 / All → "Load $20 fuel" → "Loading fuel…" → "Fuel loaded". The move fee shows (maker: "keep the
 * fee showing for now"): the adapter's quote when it has one, else LEAVE MOVE_FEE_EST_USD. Fuel already in the tank
 * can go back to cash from here too.
 *  - Real adapter with loadFuel/unloadFuel: real moves (USDG → USDC on Arbitrum via Across, lib/bridge/across).
 *  - Practice adapter: the same screens on practice fuel (device only, addFuel/withdrawFuel). Nothing real moves, and it
 *    says so.
 *  - A real adapter with deposits only (no loadFuel): Nova's own "send USDC on Arbitrum" card, the old sheet.
 * A right drawer on desktop, a bottom sheet on phone (run.module.css drawer).
 */
import { useEffect, useMemo, useState } from "react";
import type { DepositInfo, TurboAdapter } from "@/lib/turbo";
import { RUN_COPY as RC, TURBO_COPY as C } from "@/lib/turbo/copy";
import { LOAD_COPY as L, LEAVE_COPY, MOVE_FEE_EST_USD, loadPicks } from "@/lib/turbo/leave";
import { usd } from "@/lib/turbo/format";
import { useCashUsd } from "@/lib/useCashUsd";
import { openCash } from "@/lib/cashLink";
import s from "./turbo.module.css";
import r from "./run.module.css";

const PRACTICE_POT = 100;
const money = (v: number) => usd(v, 2);

function useMoveFee(adapter: TurboAdapter, amt: number, dir: "toTurbo" | "toCash") {
  const [fee, setFee] = useState(MOVE_FEE_EST_USD);
  useEffect(() => {
    if (!adapter.moveFeeUsd || !(amt > 0)) return;
    let alive = true;
    adapter.moveFeeUsd(amt, dir).then((f) => { if (alive && Number.isFinite(f)) setFee(f); }).catch(() => undefined);
    return () => { alive = false; };
  }, [adapter, amt, dir]);
  return fee;
}

function DepositOnly({ adapter }: { adapter: TurboAdapter }) {
  const info: DepositInfo = adapter.depositInfo?.() ?? { token: "USDC", network: "Arbitrum", address: null };
  const [copied, setCopied] = useState(false);
  const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
  return <>
    <p className={r.drLead}>{RC.fundLead}</p>
    <div className={r.drCard}>
      <div><span>{C.fundNetwork}</span><b>{C.fundNetworkValue}</b></div>
      <div><span>{C.fundToken}</span><b>{C.fundTokenValue}</b></div>
      <div><span>{RC.yourAddress}</span>{info.address ? <code data-testid="turbo-deposit-address" title={info.address}>{short(info.address)}</code>
        : <em data-testid="turbo-deposit-address">{C.fundNoAddress}</em>}</div>
    </div>
    <button type="button" className={r.drCopy} disabled={!info.address}
      onClick={async () => { if (!info.address) return; try { await navigator.clipboard.writeText(info.address); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* ignore */ } }}>
      {(copied ? C.fundCopied : C.fundCopy).toUpperCase()}</button>
    <div className={r.drNote}><i />{info.address ? RC.fundWatching : C.fundConfirm}</div>
  </>;
}

export default function TurboFundingSheet({ adapter, fuel, onClose }: { adapter: TurboAdapter; fuel?: number | null; onClose: () => void }) {
  const practice = adapter.kind === "practice" || !adapter.kind;
  const load = practice ? adapter.addFuel : adapter.loadFuel;
  const unload = practice ? adapter.withdrawFuel : adapter.unloadFuel;
  const cash = useCashUsd();
  const pot = practice ? PRACTICE_POT : cash.usd ?? 0;
  const picks = useMemo(() => loadPicks(pot), [pot]);
  const [amt, setAmt] = useState(20);
  const [step, setStep] = useState<"pick" | "moving" | "done">("pick");
  const [err, setErr] = useState("");
  const [backBusy, setBackBusy] = useState(false);
  const fee = useMoveFee(adapter, amt, "toTurbo");
  const backFee = useMoveFee(adapter, fuel ?? 0, "toCash");
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);

  const over = !practice && amt > pot + 1e-9;
  const go = async () => {
    if (!load || !(amt > 0)) return;
    if (over) { setErr(L.notEnough); return; }
    setErr(""); setStep("moving");
    try { await load(amt); if (!practice) cash.refresh(); setStep("done"); }
    catch (e) { setStep("pick"); setErr(e instanceof Error && e.message ? e.message : C.failed); }
  };
  const back = async () => {
    if (!unload || !fuel) return;
    setErr(""); setBackBusy(true);
    try { await unload(fuel); if (!practice) cash.refresh(); } catch { setErr(LEAVE_COPY.failed); } finally { setBackBusy(false); }
  };

  return (
    <div className={r.drawerDim} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={L.title} className={`${r.drawer} ${r.drTall}`} data-testid="turbo-funding-sheet" data-step={step}>
        <div className={r.drHead}><span className={r.drTitle}>{(step === "done" ? L.loaded : step === "moving" ? L.moving : L.title).toUpperCase()}</span>
          <button type="button" className={r.iconBtn} aria-label="Close" onClick={onClose}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg></button></div>

        {!load ? <DepositOnly adapter={adapter} /> : step === "pick" ? <>
          <p className={r.drLead}>{practice ? L.leadPractice : L.lead}</p>
          <div className={r.lfAmt} data-testid="turbo-load-amount">{usd(amt, Number.isInteger(amt) ? 0 : 2)}</div>
          <div className={r.lfPicks} role="group" aria-label="Fuel amount">
            {picks.map((p) => <button key={p.label} type="button" className={amt === p.usd ? r.on : ""} aria-pressed={amt === p.usd}
              disabled={!(p.usd > 0)} onClick={() => { setErr(""); setAmt(p.usd); }} data-testid={`turbo-load-pick-${p.label}`}>{p.label}</button>)}
          </div>
          <div className={r.lfBox}>
            <div><span>{practice ? L.practiceCash : L.yourCash}</span><b>{practice ? money(PRACTICE_POT) : cash.usd == null ? "—" : money(cash.usd)}</b></div>
            {!practice && <div><span>{L.fee}</span><b data-testid="turbo-load-fee">{L.feeVal(money(fee))}</b></div>}
          </div>
          {err && <p className={s.err} role="alert">{err}{over && <> <button type="button" className={r.lfLink} onClick={() => { onClose(); openCash("add"); }}>{L.addCash}</button></>}</p>}
          <button type="button" className={r.drCopy} disabled={!(amt > 0)} onClick={go} data-testid="turbo-load-btn">{L.load(usd(amt, Number.isInteger(amt) ? 0 : 2)).toUpperCase()}</button>
          <span className={r.lfSub}>{L.sub}</span>
        </> : step === "moving" ? <div className={r.lfCenter} role="status">
          <i className={r.lfSpin} aria-hidden />
          <span>{L.movingSub(usd(amt, Number.isInteger(amt) ? 0 : 2))}</span>
        </div> : <>
          <div className={r.lfCenter} role="status" data-testid="turbo-load-done">
            <span>{L.loadedSub(usd(amt, Number.isInteger(amt) ? 0 : 2))}</span>
          </div>
          <button type="button" className={r.drCopy} onClick={onClose} data-autofocus>{L.fly.toUpperCase()}</button>
        </>}

        <span className={r.grow} />
        {load && step === "pick" && <div className={r.drBal}>
          <span>{L.inTank}</span><b>{fuel == null ? "—" : usd(fuel, fuel >= 100 || Number.isInteger(fuel) ? 0 : 2)}</b>
        </div>}
        {load && step === "pick" && unload && !!fuel && fuel >= 0.01 && <button type="button" className={r.drGhost} disabled={backBusy} onClick={back} data-testid="turbo-move-to-cash">
          {(backBusy ? LEAVE_COPY.moving : practice ? C.takeFuelOut : `${LEAVE_COPY.move(money(fuel))} · ${money(backFee)}`).toUpperCase()}</button>}
      </div>
    </div>
  );
}
