"use client";
/**
 * Leaving Turbo with fuel left (Add cash board 6, maker 2026-11-14: "they should have the option to keep fuel in turbo",
 * "keep the fee showing for now"): Keep fuel in Turbo (gold) or Move $x to cash (fee under it), plus "Don't ask again".
 * The saved answer lives in lib/turbo/leave (Settings › Flying › Turbo fuel when you leave). Practice fuel never counts
 * as cash, so practice says "Take fuel out" and nothing real moves.
 */
import { useEffect, useState } from "react";
import type { TurboAdapter } from "@/lib/turbo";
import { TURBO_COPY as C } from "@/lib/turbo/copy";
import { LEAVE_COPY as L, MOVE_FEE_EST_USD, saveLeavePref } from "@/lib/turbo/leave";
import { usd } from "@/lib/turbo/format";
import r from "./run.module.css";

const money = (v: number) => usd(v, 2);

export default function TurboLeaveSheet({ adapter, fuel, onLeave, onClose }: {
  adapter: TurboAdapter; fuel: number; onLeave: () => void; onClose: () => void;
}) {
  const practice = adapter.kind === "practice" || !adapter.kind;
  const unload = practice ? adapter.withdrawFuel : adapter.unloadFuel;
  const [dontAsk, setDontAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [fee, setFee] = useState(MOVE_FEE_EST_USD);
  useEffect(() => { if (!adapter.moveFeeUsd) return; let a = true; adapter.moveFeeUsd(fuel, "toCash").then((f) => { if (a && Number.isFinite(f)) setFee(f); }).catch(() => undefined); return () => { a = false; }; }, [adapter, fuel]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);

  const keep = () => { if (dontAsk) saveLeavePref("keep"); onLeave(); };
  const move = async () => {
    if (!unload) return keep();
    setErr(""); setBusy(true);
    try { await unload(fuel); if (dontAsk) saveLeavePref("move"); onLeave(); }
    catch { setErr(L.failed); setBusy(false); }
  };

  return (
    <div className={r.drawerDim} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={L.title} className={`${r.drawer} ${r.drTall}`} data-testid="turbo-leave-sheet">
        <div className={r.drHead}><span className={r.drTitle}>{L.title.toUpperCase()}</span>
          <button type="button" className={r.iconBtn} aria-label="Stay in Turbo" onClick={onClose}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg></button></div>
        <p className={r.drLead}>{L.body(money(fuel))}</p>
        <button type="button" className={r.drCopy} disabled={busy} onClick={keep} data-testid="turbo-leave-keep" data-autofocus>{L.keep.toUpperCase()}</button>
        <button type="button" className={r.lvSecond} disabled={busy} onClick={move} data-testid="turbo-leave-move">
          <span>{busy ? L.moving : practice ? C.takeFuelOut : L.move(money(fuel))}</span>
          {!practice && <small>{L.fee(money(fee))}</small>}
        </button>
        {err && <p role="alert" className={r.drLead}>{err}</p>}
        <label className={r.lvAsk}><input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} data-testid="turbo-leave-dontask" /> {L.dontAsk}</label>
      </div>
    </div>
  );
}
