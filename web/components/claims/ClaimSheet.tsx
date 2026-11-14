"use client";
/**
 * The claim moment (round 2 "Claims + Host earnings" board, maker 2026-11-13): one sheet for every payout (Rewards,
 * Host earnings, crew rewards on a rocket). Dollars and where they land, never contract names.
 *  1 Confirm: "You get $x", the split by where it came from, gold "Claim $x".
 *  2 Claiming: the gold button holds the state (spinner, "Claiming…").
 *  Problems: the network fee as a gold info note (maker: players pay the host-claim fee, "a small network fee");
 *    relay / server trouble as "Claiming is down for a moment…" (pink).
 *  3 Claimed: green check, "+$x", "Added to your cash. You now have $y.", Share / Done, View receipt.
 * ClaimBody is the box's content (for a popup that already has its own overlay, e.g. Rewards); ClaimSheet wraps it in
 * the shared Sheet (centred on desktop, bottom sheet on phones).
 */
import { useEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import { formatUnits } from "viem";
import Sheet from "@/components/profile/Sheet";
import { ACTIVE_CHAIN, deployment, isDeployed } from "@/lib/chains";
import { decimalsOf, publicClient, tokenBalance } from "@/lib/protocol-viem";
import { onWallet } from "@/lib/walletState";
import type { Address } from "@/lib/protocol";
import { CashHead, Check, ErrIcon, usd2 } from "@/components/cash/bits";

export const CLAIM_COPY = {
  youGet: "You get",
  lands: "Lands in your account right away.",
  claim: (v: string) => `Claim ${v}`,
  claiming: "Claiming…",
  fee: "Claiming host earnings has a small network fee. It's paid from your account when you claim.",
  down: "Claiming is down for a moment. Nothing was sent and your rewards are safe. Try again in a few minutes.",
  addedCash: "Added to your cash.",
  addedAccount: "Added to your account.",
  nowHave: (v: string) => <> You now have <b>{v}</b>.</>,
  share: "Share",
  done: "Done",
  receipt: "View receipt",
  shareText: (v: string) => `I just claimed ${v} on DISCIPLE.`,
  // the split rows
  fromFriends: "From friends", fromFriendsSub: "Your cut of their trades",
  hosted: "Rockets you host",
  hostedSub: (n: number, coin: string | null) => `${n} rocket${n === 1 ? "" : "s"}${coin ? ` · part paid in ${coin}` : ""}`,
  crew: "Crew rewards",
} as const;

export type ClaimRow = { label: string; sub?: string | null; usd: number };

/** A fee note for the sheet: a plain "Network fee $x" quote stays; anything else (a relay / dev message) is the fee line. */
export function feeLine(note: string | null | undefined): string | null {
  if (!note) return null;
  return /^Network fee \$[\d.,]+ in USDG\.$/.test(note.trim()) ? note.trim() : CLAIM_COPY.fee;
}
/** An error for the sheet: relay / server / network trouble reads as "down for a moment". */
export function claimProblem(text: string | null | undefined): string | null {
  if (!text) return null;
  return /relay|not configured|HTTP|fetch|network|timeout|temporar|server|unavailable|503|502|500/i.test(text) ? CLAIM_COPY.down : text;
}

function Chest() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><rect x="3" y="9" width="18" height="11" rx="2" /><path d="M3 13h18M12 9v11M7 9a3 3 0 0 1 5-3 3 3 0 0 1 5 3" /></svg>;
}

export type ClaimBodyProps = {
  title: string;
  rows: ClaimRow[];
  /** every row pays out in cash (USDG): the claimed line says "Added to your cash" and shows the new balance */
  allCash?: boolean;
  feeNote?: string | null;
  busy?: boolean;
  error?: string | null;
  done?: Hex | null;
  /** extra line under the claimed amount (e.g. "A few more are ready to claim next time.") */
  doneNote?: string | null;
  onConfirm: () => void;
  onClose: () => void;
  confirmLabel?: string;
};

export function ClaimBody({ title, rows, allCash = true, feeNote, busy, error, done, doneNote, onConfirm, onClose, confirmLabel }: ClaimBodyProps) {
  const live = rows.reduce((a, r) => a + (Number.isFinite(r.usd) ? r.usd : 0), 0);
  // the amount as it was when Claim was pressed (callers reload their numbers after the claim lands)
  const snap = useRef(live);
  if (!done && !busy) snap.current = live;
  const total = done || busy ? snap.current : live;
  const [cash, setCash] = useState<number | null>(null);
  const [shared, setShared] = useState(false);
  // the new cash balance, read once the claim lands
  useEffect(() => {
    if (!done || !allCash || !isDeployed()) return;
    let alive = true;
    const off = onWallet(async (a) => {
      if (!a) return;
      try {
        const pc = publicClient(), usdg = deployment().usdg as Address;
        const [b, d] = await Promise.all([tokenBalance(pc, usdg, a as Address), decimalsOf(pc, usdg)]);
        if (alive) setCash(Number(formatUnits(b, d)));
      } catch { /* rpc hiccup: no balance line */ }
    });
    return () => { alive = false; off(); };
  }, [done, allCash]);
  const fee = feeLine(feeNote);
  const problem = claimProblem(error);
  const base = ACTIVE_CHAIN.blockExplorers?.default.url;
  const share = async () => {
    const text = CLAIM_COPY.shareText(usd2(total)), url = window.location.origin;
    try {
      if (typeof navigator.share === "function") { await navigator.share({ title: "DISCIPLE", text, url }); return; }
      await navigator.clipboard.writeText(`${text} ${url}`); setShared(true); setTimeout(() => setShared(false), 1500);
    } catch { /* share sheet closed */ }
  };

  if (done) {
    return (
      <div className="r2-body cs-done" role="status" data-testid="claim-done">
        <div className="cs-donebloom" aria-hidden />
        <div className="r2-ok cs-ok"><Check size={34} /></div>
        <div className="r2-g cs-plus">+{usd2(total)}</div>
        <span className="cs-landed">{allCash ? CLAIM_COPY.addedCash : CLAIM_COPY.addedAccount}{allCash && cash != null && CLAIM_COPY.nowHave(usd2(cash))}</span>
        {doneNote && <span className="cx-fine">{doneNote}</span>}
        <div className="cx-row2 cs-acts">
          <button type="button" className="r2-btn" onClick={share}>{shared ? "Copied" : CLAIM_COPY.share}</button>
          <button type="button" className="r2-btn r2-white" onClick={onClose} data-autofocus>{CLAIM_COPY.done}</button>
        </div>
        {base && <a className="cs-receipt" href={`${base}/tx/${done}`} target="_blank" rel="noreferrer noopener">{CLAIM_COPY.receipt}</a>}
      </div>
    );
  }
  return (
    <>
      {!busy && <CashHead title={title} onClose={onClose} />}
      <div className={`r2-body${busy ? " cs-busy" : ""}`}>
        <div className="cs-pay">
          <span className="r2-lbl gold">{CLAIM_COPY.youGet}</span>
          <div className="r2-g cs-amt" data-testid="claim-total">{usd2(total)}</div>
          {!busy && <span className="cs-paysub">{CLAIM_COPY.lands}</span>}
        </div>
        {!busy && rows.length > 0 && (
          <div className="r2-box">
            {rows.map((r) => (
              <div key={r.label} className="r2-r"><div className="t"><b>{r.label}</b>{r.sub && <span>{r.sub}</span>}</div><span className="r2-g cs-v">{usd2(r.usd)}</span></div>
            ))}
          </div>
        )}
        {!busy && fee && <div className="r2-note warn" data-testid="claim-fee-note"><ErrIcon /><span>{fee}</span></div>}
        {!busy && problem && <div className="r2-note err" role="alert"><ErrIcon /><span>{problem}</span></div>}
        <button type="button" className={`r2-gold${busy ? " busy" : ""}`} disabled={busy || total <= 0} onClick={onConfirm} data-testid="claim-confirm-btn">
          {busy ? <><span className="r2-spin" aria-hidden />{CLAIM_COPY.claiming}</> : <><Chest />{confirmLabel ?? CLAIM_COPY.claim(usd2(total))}</>}
        </button>
      </div>
    </>
  );
}

export default function ClaimSheet(p: ClaimBodyProps) {
  return (
    <Sheet open onClose={p.onClose} label={p.title} className={`r2-modal cs-sheet${p.done ? " cs-claimed" : ""}`} testId="claim-confirm">
      <ClaimBody {...p} />
    </Sheet>
  );
}
