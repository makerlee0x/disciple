"use client";
/**
 * v4 deposit-to-qualify (caps.referralGate): after a referral link, ReferralRegistry holds a pending referrer until
 * the wallet's USDG deposits through UsdgDepositNotifier reach ReferralRegistry.usdgGate. Each deposit is ≥
 * UsdgDepositNotifier.minDeposit(), sits in escrow LOCK_PERIOD (7 days), then can be withdrawn.
 * Amounts come from the contracts; nothing is hard-coded. attest() is not used.
 *
 * Look (round 2 "Cash" board, maker 2026-11-13): the "Lock in your invite" toast (bottom right on desktop, above the tab
 * bar on phones, never over the hero) and the "Lock in your invite" confirm in the Cash popup style. Dollars, never the
 * token symbol.
 */
import { useCallback, useEffect, useState } from "react";
import type { Hex } from "viem";
import { formatUnits } from "viem";
import Sheet from "@/components/profile/Sheet";
import { deposit, depositNeeded, gateState, type GateState } from "@/lib/claims/referralGate";
import { claimErrorText } from "@/lib/claims/common";
import { demoGate } from "@/lib/claims/demo";
import { lookupName } from "@/lib/nameLookup";
import { CashHead, Check, ErrIcon, usd2 } from "@/components/cash/bits";
import { pc, useCaps, useWalletAddr } from "./ui";

const DISMISS = "disciple.refgate.dismiss";

const money = (raw: bigint, dec: number) => Number(formatUnits(raw, dec));
/** $10 (whole dollars) or $10.50 */
const usdShort = (n: number) => (Math.abs(n - Math.round(n)) < 0.005 ? `$${Math.round(n).toLocaleString("en-US")}` : usd2(n));

export const INVITE_COPY = {
  eyebrow: (who: string | null) => `Invited by ${who ?? "a friend"}`,
  title: "Lock in your invite",
  body: (amt: string, who: string | null, days: number) => `Add ${amt} to confirm ${who ?? "your friend"} brought you in. It's still yours: held ${days} days, then you can move it.`,
  bodyPhone: (amt: string, days: number) => `Add ${amt} to confirm it. Held ${days} days, then it's yours to move.`,
  later: "Later",
  lock: "Lock it in",
  deposit: "Deposit",
  depositSub: (who: string | null) => `Confirms ${who ?? "your friend"} invited you`,
  heldFor: "Held for",
  heldSub: "Then it's yours to move",
  days: (d: number) => `${d} days`,
  yourCash: "Your cash",
  takeBack: (d: number) => `You can take it back after ${d} days from Rewards in your Hangar.`,
  lockAmt: (amt: string) => `Lock it in · ${amt}`,
  locking: "Locking it in…",
  short: (amt: string) => `You need ${amt} in your cash first. Add cash, then lock it in.`,
  done: "Invite locked in",
  doneSub: (days: number) => `Your deposit is held ${days} days, then it's yours to move.`,
  ok: "Done",
} as const;

/** Old label helper (kept for callers): "Lock in your invite · $10". */
export function depositLabel(g: Pick<GateState, "min" | "gate" | "deposited" | "usdg">) {
  const need = depositNeeded(g);
  if (need == null) return null;
  return INVITE_COPY.lockAmt(usdShort(money(need, g.usdg.decimals)));
}

export default function ReferralOnboarding() {
  const me = useWalletAddr();
  const { caps, ready, demo } = useCaps();
  const [g, setG] = useState<GateState | null>(null);
  const [who, setWho] = useState<string | null>(null);
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
  useEffect(() => {
    if (!g?.referrer) { setWho(null); return; }
    let alive = true;
    lookupName(g.referrer).then((n) => { if (alive) setWho(n ? `@${n.replace(/^@/, "")}` : null); }).catch(() => {});
    return () => { alive = false; };
  }, [g?.referrer]);

  const need = g ? depositNeeded(g) : null;
  if (!g || need == null || (!sheet && (hidden || g.status !== "pending"))) return null;
  const dec = g.usdg.decimals;
  const amt = usdShort(money(need, dec));
  const bal = money(g.balance, dec);
  const short = g.balance < need;
  const days = Math.round(g.lockSec / 86400);
  const initial = (who ?? "?").replace(/^@/, "").charAt(0).toUpperCase() || "?";
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      if (demo) { await new Promise((r) => setTimeout(r, 500)); setDone(`0x${"aa".repeat(32)}` as Hex); return; }
      setDone((await deposit(pc(), me!, need)).txHash); void load();
    } catch (e) { setErr(claimErrorText(e)); } finally { setBusy(false); }
  };
  const close = () => { setSheet(false); if (done) setHidden(true); };
  return (
    <>
      {!sheet && !done && (
        <aside className="cx-toast" data-testid="referral-onboarding" role="region" aria-label={INVITE_COPY.title}>
          <div className="cx-toasthead">
            <span className="cx-ring" aria-hidden>{initial}</span>
            <div className="cx-toastt">
              <span className="r2-eb">{INVITE_COPY.eyebrow(who)}</span>
              <b className="r2-g">{INVITE_COPY.title}</b>
            </div>
          </div>
          <span className="cx-toastbody cx-d">{INVITE_COPY.body(amt, who, days)}</span>
          <span className="cx-toastbody cx-p">{INVITE_COPY.bodyPhone(amt, days)}</span>
          <div className="cx-toastacts">
            <button type="button" className="r2-btn" onClick={() => { try { sessionStorage.setItem(DISMISS, "1"); } catch { /* */ } setHidden(true); }}>{INVITE_COPY.later}</button>
            <button type="button" className="r2-btn r2-goldsm" onClick={() => { setErr(null); setDone(null); setSheet(true); }}>{INVITE_COPY.lock}</button>
          </div>
        </aside>
      )}
      <Sheet open={sheet} onClose={close} label={INVITE_COPY.title} className="r2-modal" testId="claim-confirm">
        {done ? (
          <div className="r2-body cx-sent" role="status">
            <div className="r2-ok"><Check /></div>
            <div className="r2-g cx-senth">{INVITE_COPY.done}</div>
            <span className="cx-p14">{INVITE_COPY.doneSub(days)}</span>
            <button type="button" className="r2-btn r2-white cx-wide" onClick={close} data-autofocus>{INVITE_COPY.ok}</button>
          </div>
        ) : (
          <>
            <CashHead title={INVITE_COPY.title} onClose={close} />
            <div className="r2-body">
              <div className="r2-box">
                <div className="r2-r"><div className="t"><b>{INVITE_COPY.deposit}</b><span>{INVITE_COPY.depositSub(who)}</span></div><span className="r2-g cx-v26">{usd2(money(need, dec))}</span></div>
                <div className="r2-r"><div className="t"><b>{INVITE_COPY.heldFor}</b><span>{INVITE_COPY.heldSub}</span></div><span className="cx-v14">{INVITE_COPY.days(days)}</span></div>
                <div className="r2-r"><div className="t"><b>{INVITE_COPY.yourCash}</b></div><span className="cx-fee">{usd2(bal)} <span className="cx-arrow">→</span> <b>{usd2(Math.max(0, bal - money(need, dec)))}</b></span></div>
              </div>
              <span className="cx-fine left">{INVITE_COPY.takeBack(days)}</span>
              {short && <div className="r2-note err" role="alert"><ErrIcon /><span>{INVITE_COPY.short(amt)}</span></div>}
              {err && <div className="r2-note err" role="alert"><ErrIcon /><span>{err}</span></div>}
              <button type="button" className="r2-gold" disabled={busy || short} onClick={go} data-testid="claim-confirm-btn">
                {busy ? <><span className="r2-spin" aria-hidden />{INVITE_COPY.locking}</> : INVITE_COPY.lockAmt(amt)}
              </button>
            </div>
          </>
        )}
      </Sheet>
    </>
  );
}
