"use client";
/**
 * REDEPLOY (caps.referralGate): after a referral link, ReferralRegistry holds a pending referrer until the user
 * deposits the contract's minimum USDG through UsdgDepositNotifier (held LOCK_PERIOD, then withdrawable).
 * The amount comes from the contract (BelowMinimum(min)); nothing is hard-coded.
 */
import { useCallback, useEffect, useState } from "react";
import type { Hex } from "viem";
import { formatUnits } from "viem";
import { deposit, gateState, type GateState } from "@/lib/claims/referralGate";
import { claimErrorText } from "@/lib/claims/common";
import { demoGate } from "@/lib/claims/demo";
import { shortAddr } from "@/lib/referral";
import { ConfirmSheet, pc, useCaps, useWalletAddr } from "./ui";

const DISMISS = "disciple.refgate.dismiss";

export function depositLabel(g: Pick<GateState, "min" | "usdg">) {
  if (g.min == null) return null;
  const n = Number(formatUnits(g.min, g.usdg.decimals));
  const amt = n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `Deposit ${g.usdg.usd != null && Math.abs(g.usdg.usd - 1) < 0.05 ? "$" : ""}${amt} ${g.usdg.symbol} to lock your referrer`;
}

export default function ReferralOnboarding() {
  const me = useWalletAddr();
  const { caps, ready, demo } = useCaps();
  const [g, setG] = useState<GateState | null>(null);
  const [hidden, setHidden] = useState(true);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<Hex | null>(null);

  const load = useCallback(async () => {
    if (!caps.referralGate || !ready) return;
    if (demo) { if (new URLSearchParams(location.search).get("refgate") === "1") setG(demoGate(Math.floor(Date.now() / 1000))); return; }
    if (!me) return;
    try { setG(await gateState(pc(), me)); } catch { setG(null); }
  }, [caps.referralGate, ready, demo, me]);
  useEffect(() => { try { setHidden(sessionStorage.getItem(DISMISS) === "1"); } catch { setHidden(false); } void load(); }, [load]);

  if (!g || hidden || g.status !== "pending" || g.min == null) return null;
  const label = depositLabel(g)!;
  const days = Math.round(g.lockSec / 86400);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      if (demo) { await new Promise((r) => setTimeout(r, 500)); setDone(`0x${"aa".repeat(32)}` as Hex); return; }
      setDone((await deposit(pc(), me!, g.min!)).txHash); void load();
    } catch (e) { setErr(claimErrorText(e)); } finally { setBusy(false); }
  };
  return (
    <>
      <aside className="cl-onboard" data-testid="referral-onboarding" role="region" aria-label="Lock your referrer">
        <div>
          <div className="cl-eyebrow">Referred by {g.referrer ? shortAddr(g.referrer) : "a friend"}</div>
          <strong>{label}</strong>
          <p className="muted">Held {days} days, then you can withdraw it.</p>
        </div>
        <div className="cl-actions">
          <button type="button" className="cl-btn ghost sm" onClick={() => { try { sessionStorage.setItem(DISMISS, "1"); } catch { /* */ } setHidden(true); }}>Later</button>
          <button type="button" className="cl-btn primary sm" onClick={() => { setErr(null); setDone(null); setSheet(true); }}>Deposit</button>
        </div>
      </aside>
      {sheet && <ConfirmSheet title="Lock your referrer" lines={[{ label: "Deposit", raw: g.min, asset: g.usdg }]} to={null}
        note={`Held ${days} days in escrow, then withdraw it from your profile.`} confirmLabel="Approve & deposit"
        busy={busy} error={err} done={done} onConfirm={go} onClose={() => setSheet(false)} />}
    </>
  );
}
