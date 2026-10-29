"use client";
/**
 * Private profile: Rewards (lee 2026-10-24: "these rewards can just all be combined … a feed history of what the rewards
 * are and what type they came from").
 *  - one Total earned + this week, one Claim that claims everything claimable in ONE smart-account op
 *    (lib/claims/rewardsData.claimEverything: referral + creator (wallet and private rockets) + crew)
 *  - referral link + copy
 *  - small per-type split (Referral / Creator / Crew) and a History feed (one row per type per day, dollars)
 *  - Referral deposit stays its own card: it is the player's own USDG held in escrow to lock their referrer
 *    (UsdgDepositNotifier deposit / withdraw), not earnings, so it is never part of the total.
 * Data: lib/claims/rewardsData.loadRewards (live reads only). Sums / mapping / claim list: lib/claims/rewards.ts.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Hex } from "viem";
import { deposit, depositNeeded, gateState, unlockLabel, unlocked, withdraw, withdrawCall, type GateState } from "@/lib/claims/referralGate";
import { claimErrorText, fmtUsd, preflight } from "@/lib/claims/common";
import { REWARD_KINDS, REWARD_LABEL, usdLabel, type HistoryRow, type RewardKind } from "@/lib/claims/rewards";
import { claimEverything, hasClaimable, loadRewards, type RewardsData } from "@/lib/claims/rewardsData";
import { demoGate, demoRewards } from "@/lib/claims/demo";
import { myStealthCoins, myStealthKeys } from "@/lib/privateLaunch";
import { fetchUsernameStatus, localUsername, referralUrl } from "@/lib/profile";
import { refLabel } from "@/lib/referral";
import { SampleTag, pc, useCaps, useWalletAddr } from "./ui";

/* Copy (new strings are listed verbatim in the PR body under "Copy pending lee approval"). */
const T = {
  total: "Total earned",
  week: "this week",
  link: "Your referral link",
  history: "History",
  empty: "Nothing yet. Share your link to earn from friends' trades.",
  nothing: "Nothing to claim yet.",
  paused: "Referral earnings have stopped growing for now. Anything already here stays yours to claim.",
  sheetTitle: "Claim rewards",
  claimed: "Claimed",
  landed: "It's in your wallet.",
  later: "A few more are ready to claim next time.",
  depositNote: "This is your own deposit, not earnings.",
} as const;

/** Referral deposit confirm: dollar lines only (no token amounts, no address). */
type Sheet = { title: string; lines: { label: string; usd: string }[]; run: () => Promise<Hex>; note?: string; label?: string } | null;

function dayLabel(r: HistoryRow, nowSec: number) {
  const d = new Date(r.to * 1000), y = new Date(nowSec * 1000).getFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() !== y ? { year: "numeric" } : {}) });
}

export default function ProfileClaims() {
  const me = useWalletAddr();
  const { caps, ready, demo } = useCaps();
  const [data, setData] = useState<RewardsData | null>(null);
  const [gate, setGate] = useState<GateState | null>(null);
  const [username, setUsername] = useState("");
  const [copied, setCopied] = useState(false);
  // combined claim
  const [claimOpen, setClaimOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ usd: number; deferred: number } | null>(null);
  // referral deposit (separate)
  const [sheet, setSheet] = useState<Sheet>(null);
  const [sBusy, setSBusy] = useState(false);
  const [sErr, setSErr] = useState<string | null>(null);
  const [sDone, setSDone] = useState<Hex | null>(null);
  const nowSec = Math.floor(Date.now() / 1000);

  const load = useCallback(async () => {
    if (demo) { setData(demoRewards(Math.floor(Date.now() / 1000))); if (caps.referralGate) setGate(demoGate(Math.floor(Date.now() / 1000))); return; }
    if (!me || !ready) return;
    const c = pc();
    if (caps.referralGate) void gateState(c, me).then(setGate).catch(() => setGate(null));
    // private launches announced to this account's stealth keys (same silent signature the creator dashboard uses)
    const stealth = caps.anonClaims ? await myStealthKeys().then((k) => myStealthCoins(c, k)).catch(() => []) : [];
    try { setData(await loadRewards(c, me, caps, stealth)); }
    catch (e) { console.warn("[disciple] rewards: load failed", (e as Error)?.message ?? e); setData(null); }
  }, [me, ready, demo, caps]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    setUsername(localUsername());
    let alive = true;
    void fetchUsernameStatus(me).then((s) => { if (alive && s.username && !localUsername()) setUsername(s.username); }).catch(() => {});
    return () => { alive = false; };
  }, [me]);

  if (!me && !demo) return null;

  const s = data?.summary;
  const kinds = REWARD_KINDS.filter((k) => (k === "referral" ? caps.referrerFees : k === "crew" ? caps.crew : caps.creatorFees || caps.creatorTokenFees || caps.anonClaims));
  const canClaim = !!data && hasClaimable(data.claim);
  const claimUsd = s?.claimableUsd ?? 0;
  const link = me ? referralUrl(username || null, me) : null;
  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch (e) { console.warn("[disciple] rewards: copy failed", (e as Error)?.message ?? e); }
  };

  const confirmClaim = async () => {
    if (!data || !me && !demo) return;
    setBusy(true); setErr(null);
    try {
      if (demo) { await new Promise((r) => setTimeout(r, 500)); setDone({ usd: claimUsd, deferred: 0 }); return; }
      const r = await claimEverything(pc(), me!, caps, data.claim);
      console.warn("[disciple] rewards: claimed", { txHash: r.txHash, skipped: r.skipped, deferred: r.deferred });
      setDone({ usd: claimUsd, deferred: r.deferred });
      void load();
    } catch (e) { setErr(claimErrorText(e)); } finally { setBusy(false); }
  };

  const openDeposit = (x: NonNullable<Sheet>) => { setSErr(null); setSDone(null); setSheet(x); };
  const confirmDeposit = async () => {
    if (!sheet) return;
    setSBusy(true); setSErr(null);
    try { const h = demo ? (await new Promise((r) => setTimeout(r, 500)), `0x${"cd".repeat(32)}` as Hex) : await sheet.run(); console.warn("[disciple] referral deposit: sent", { txHash: h }); setSDone(h); if (!demo) void load(); }
    catch (e) { setSErr(claimErrorText(e)); } finally { setSBusy(false); }
  };

  return (
    <section className="cl-profile" data-testid="profile-claims" aria-label="Rewards and claims">
      <div className="cl-profile-head"><h2 className="cl-display sm">Rewards &amp; claims</h2><SampleTag show={demo} /></div>

      <div className="cl-rw">
        <article className="cl-card cl-rw-total" data-testid="rewards-total">
          <span className="cl-eyebrow">{T.total}</span>
          {s ? <>
            <strong className="cl-rw-big" data-testid="rewards-total-usd">{fmtUsd(s.totalUsd)}</strong>
            <span className="cl-rw-week" data-testid="rewards-week"><b>+{fmtUsd(s.weekUsd)}</b> {T.week}</span>
          </> : <><div className="cl-skel" /><div className="cl-skel short" /></>}
          <button type="button" className="cl-btn gold lg" data-testid="claim-all-rewards" disabled={!canClaim}
            onClick={() => { setErr(null); setDone(null); setClaimOpen(true); }}>
            Claim{canClaim && claimUsd > 0 ? ` ${fmtUsd(claimUsd)}` : ""}
          </button>
          {data && !canClaim && <p className="muted cl-fine">{T.nothing}</p>}
          {data?.referralPaused && <p className="muted cl-fine" data-testid="referral-sink-note">{T.paused}</p>}
        </article>

        <div className="cl-rw-side">
          <article className="cl-card cl-rw-link" data-testid="referral-link">
            <span className="cl-eyebrow">{T.link}</span>
            <div className="cl-rw-linkrow">
              <span className="cl-mono">{me ? refLabel(username || null, me, typeof window !== "undefined" ? window.location.host : undefined) : "disciple.vip/r/you"}</span>
              <button type="button" className="cl-btn sm" onClick={copy} disabled={!link} data-testid="copy-ref">{copied ? "Copied" : "Copy link"}</button>
            </div>
          </article>
          {!!kinds.length && (
            <div className="cl-rw-split" data-testid="rewards-split">
              {kinds.map((k) => (
                <div key={k} className="cl-rw-kind" data-kind={k}>
                  <span className="cl-rw-kname"><i className={`cl-rw-dot ${k}`} aria-hidden="true" />{REWARD_LABEL[k]}</span>
                  <strong>{s ? fmtUsd(s.byKind[k].earnedUsd) : "—"}</strong>
                  {k === "creator" && !!data?.launched && <Link className="cl-tx" href={demo ? "/creator?demo=1" : "/creator"}>Open creator dashboard</Link>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <article className="cl-card cl-rw-history" data-testid="rewards-history">
        <h3 className="cl-display xs">{T.history}</h3>
        {!data ? <div className="cl-skel" /> : data.history.length ? (
          <ul className="cl-rw-feed">
            {data.history.map((r) => (
              <li key={`${r.kind}${r.day}`} data-kind={r.kind}>
                <i className={`cl-rw-dot ${r.kind}`} aria-hidden="true" />
                <span className="cl-rw-what"><b>{REWARD_LABEL[r.kind]}</b><span className="muted">{dayLabel(r, nowSec)}</span></span>
                <span className="cl-rw-amt">+{fmtUsd(r.usd)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="muted" data-testid="rewards-empty">{T.empty}</p>}
      </article>

      {caps.referralGate && gate && (
        <article className="cl-card cl-mini cl-rw-deposit" data-testid="referral-deposit">
          <span className="cl-eyebrow">Referral deposit</span>
          <p className="muted cl-fine">{T.depositNote}</p>
          <div className="cl-verify-row"><span className={`cl-pill ${gate.status === "locked" ? "approved" : "pending"}`}>{gate.status === "locked" ? "Referrer locked" : gate.status === "pending" ? "Referrer pending" : "No referrer"}</span></div>
          {gate.escrows.length ? (
            <ul className="cl-escrows">
              {gate.escrows.map((e) => (
                <li key={e.id}><span className="cl-rw-usd" data-testid="deposit-usd">{usdLabel(e.amount, gate.usdg)}</span><span className={unlocked(e, nowSec) ? "cl-ok" : "muted"}>{unlockLabel(e.unlockAt, nowSec)}</span></li>
              ))}
            </ul>
          ) : <p className="muted">No deposits held.</p>}
          <div className="cl-actions">
            {gate.status === "pending" && depositNeeded(gate) != null && (() => {
              const need = depositNeeded(gate)!;
              return (
                <button type="button" className="cl-btn primary" disabled={gate.balance < need} data-testid="deposit-btn"
                  onClick={() => openDeposit({ title: "Lock your referrer", label: "Approve & deposit", lines: [{ label: "Deposit", usd: usdLabel(need, gate.usdg) }],
                    note: `Held ${Math.round(gate.lockSec / 86400)} days in escrow, then withdraw it here.`, run: async () => (await deposit(pc(), me!, need)).txHash })}>
                  {gate.balance < need ? `Need ${gate.usdg.symbol} to deposit` : "Deposit to qualify"}
                </button>
              );
            })()}
            <button type="button" className="cl-btn ghost" disabled={!gate.escrows.some((e) => unlocked(e, nowSec))}
              onClick={() => { const ok = gate.escrows.filter((e) => unlocked(e, nowSec)); openDeposit({ title: "Withdraw deposit", label: "Withdraw", lines: ok.map((e) => ({ label: `Deposit #${e.id}`, usd: usdLabel(e.amount, gate.usdg) })), run: async () => { await preflight(pc(), [withdrawCall(ok.map((e) => e.id))], me!); return (await withdraw(ok)).txHash; }, note: "Only unlocked deposits are withdrawn." }); }}>
              Withdraw unlocked
            </button>
          </div>
        </article>
      )}

      {claimOpen && data && (
        <div className="cl-sheet-wrap" role="dialog" aria-modal="true" aria-label={T.sheetTitle} data-testid="claim-confirm">
          <div className="cl-sheet">
            <div className="cl-eyebrow">{done ? "Done" : "Confirm"}</div>
            <h3 className="cl-display">{done ? T.claimed : T.sheetTitle}</h3>
            <ul className="cl-lines">
              {kinds.filter((k) => data.claimableByKind[k] > 0).map((k: RewardKind) => (
                <li key={k}><span className="muted">{REWARD_LABEL[k]}</span><span className="cl-rw-amt">{fmtUsd(data.claimableByKind[k])}</span></li>
              ))}
            </ul>
            {done && <p className="cl-ok">{fmtUsd(done.usd)} · {T.landed}</p>}
            {done && done.deferred > 0 && <p className="cl-note">{T.later}</p>}
            {err && <p className="cl-err" role="alert">{err}</p>}
            <div className="cl-actions">
              <button type="button" className="cl-btn ghost" onClick={() => setClaimOpen(false)}>{done ? "Close" : "Cancel"}</button>
              {!done && <button type="button" className="cl-btn primary" disabled={busy} onClick={confirmClaim} data-testid="claim-confirm-btn">{busy ? "Sending…" : "Confirm claim"}</button>}
            </div>
          </div>
        </div>
      )}
      {sheet && (
        <div className="cl-sheet-wrap" role="dialog" aria-modal="true" aria-label={sheet.title} data-testid="deposit-confirm">
          <div className="cl-sheet">
            <div className="cl-eyebrow">{sDone ? "Done" : "Confirm"}</div>
            <h3 className="cl-display">{sheet.title}</h3>
            <ul className="cl-lines">
              {sheet.lines.map((l, i) => <li key={i}><span className="muted">{l.label}</span><span className="cl-rw-usd">{l.usd}</span></li>)}
            </ul>
            {sheet.note && !sDone && <p className="cl-note">{sheet.note}</p>}
            {sErr && <p className="cl-err" role="alert">{sErr}</p>}
            <div className="cl-actions">
              <button type="button" className="cl-btn ghost" onClick={() => setSheet(null)}>{sDone ? "Close" : "Cancel"}</button>
              {!sDone && <button type="button" className="cl-btn primary" disabled={sBusy} onClick={confirmDeposit}>{sBusy ? "Sending…" : sheet.label ?? "Confirm"}</button>}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
