"use client";
/**
 * Private profile: Rewards & claims.
 *  - Creator: link to /creator when the user launched rockets
 *  - Referral rewards: FeeRouter.referrerAccrued(me, quote) + claimReferrerFees(quote) (referrer first); a calm note when
 *    FeeRouter.referralSink() is set (new referral shares go to the sink; existing balances stay claimable)
 *  - Referral deposit: UsdgDepositNotifier deposit (exact approve, minDeposit from chain) + escrow countdown + withdraw(ids)
 *  - Crew rewards: PVE BondingCurve.pendingRewards list + Launchpad.claim(token)
 * Every claim is eth_call-simulated first (common.preflight) so reverts show plain copy before signing.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Hex } from "viem";
import { createdRockets, creatorClaimable, referralBalances, referralClaimCalls, referralSink, type ReferralBalance } from "@/lib/claims/creatorFees";
import { crewClaimCall, crewPositions } from "@/lib/claims/crew";
import { deposit, depositNeeded, gateState, unlockLabel, unlocked, withdraw, withdrawCall, type GateState } from "@/lib/claims/referralGate";
import { claimErrorText, fmtUsd, preflight, toUsd, type Asset } from "@/lib/claims/common";
import { demoCrew, demoGate, demoReferral, demoRockets, demoRedeploy } from "@/lib/claims/demo";
import { execCalls } from "@/lib/wallet";
import { ConfirmSheet, Money, SampleTag, pc, useCaps, useWalletAddr, type ConfirmLine } from "./ui";
import type { Address } from "viem";

type Sheet = { title: string; lines: ConfirmLine[]; run: () => Promise<Hex>; note?: string; label?: string } | null;

export default function ProfileClaims() {
  const me = useWalletAddr();
  const { caps, ready, demo } = useCaps();
  const [creator, setCreator] = useState<{ n: number; usd: number } | null>(null);
  const [refs, setRefs] = useState<ReferralBalance[] | null>(null);
  const [sinkOn, setSinkOn] = useState(false);
  const [gate, setGate] = useState<GateState | null>(null);
  const [crew, setCrew] = useState<{ token: Address; ticker?: string; name?: string; quote: Asset; pending: bigint }[] | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<Hex | null>(null);

  const load = useCallback(async () => {
    if (demo) {
      const rs = demoRockets(demoRedeploy());
      setCreator({ n: rs.length, usd: rs.reduce((a, r) => a + (toUsd(r.claimable, r.quote) ?? 0), 0) });
      setRefs(demoReferral());
      if (caps.referralGate) setGate(demoGate(Math.floor(Date.now() / 1000)));
      if (caps.crew) setCrew(demoCrew());
      return;
    }
    if (!me || !ready) return;
    const c = pc();
    void createdRockets(c, me).then(async (rs) => {
      const vals = await Promise.all(rs.slice(0, 30).map((r) => creatorClaimable(c, r.token, me).catch(() => BigInt(0))));
      setCreator({ n: rs.length, usd: vals.some((v) => v > BigInt(0)) ? 1 : 0 }); // live: flag only (USD needs per-quote prices; the dashboard shows them)
    }).catch(() => setCreator({ n: 0, usd: 0 }));
    if (caps.referrerFees) void referralBalances(c, me).then(setRefs).catch(() => setRefs([]));
    if (caps.referrerFees) void referralSink(c).then((s) => setSinkOn(!!s)).catch(() => setSinkOn(false));
    if (caps.referralGate) void gateState(c, me).then(setGate).catch(() => setGate(null));
    if (caps.crew) void crewPositions(c, me).then(setCrew).catch(() => setCrew([]));
  }, [me, ready, demo, caps]);
  useEffect(() => { void load(); }, [load]);

  const open = (s: NonNullable<Sheet>) => { setErr(null); setDone(null); setSheet(s); };
  const confirm = async () => {
    if (!sheet) return;
    setBusy(true); setErr(null);
    try { setDone(demo ? (await new Promise((r) => setTimeout(r, 500)), `0x${"cd".repeat(32)}` as Hex) : await sheet.run()); if (!demo) void load(); }
    catch (e) { setErr(claimErrorText(e)); } finally { setBusy(false); }
  };

  if (!me && !demo) return null;
  const refOpen = (refs ?? []).filter((r) => r.claimable > BigInt(0));
  const refUsd = refOpen.reduce((a, r) => a + (toUsd(r.claimable, r.asset) ?? 0), 0);
  const crewOpen = (crew ?? []).filter((r) => r.pending > BigInt(0));
  const nowSec = Math.floor(Date.now() / 1000);

  return (
    <section className="cl-profile" data-testid="profile-claims" aria-label="Rewards and claims">
      <div className="cl-profile-head"><h2 className="cl-display sm">Rewards &amp; claims</h2><SampleTag show={demo} /></div>
      <div className="cl-grid three">
        {creator && creator.n > 0 && (
          <article className="cl-card cl-mini" data-testid="creator-link-card">
            <span className="cl-eyebrow">Creator</span>
            <h3 className="cl-display xs">{creator.n} rocket{creator.n === 1 ? "" : "s"} launched</h3>
            <p className="muted">{demo ? `${fmtUsd(creator.usd)} in fees to claim.` : creator.usd > 0 ? "You have fees to claim." : "See fees and claims."}</p>
            <Link className="cl-btn gold" href={demo ? "/creator?demo=1" : "/creator"}>Open creator dashboard</Link>
          </article>
        )}

        {caps.referrerFees && refs && (
          <article className="cl-card cl-mini" data-testid="referral-rewards">
            <span className="cl-eyebrow">Referral rewards</span>
            {refOpen.length ? refOpen.map((r) => <Money key={r.asset.address} raw={r.claimable} asset={r.asset} big={refOpen.length === 1} />) : sinkOn ? null : <p className="muted">Nothing yet. Share your link to earn from friends&apos; trades.</p>}
            {sinkOn && <p className="muted cl-fine" data-testid="referral-sink-note">Referral earnings have stopped growing for now. Anything already here stays yours to claim.</p>}
            <button type="button" className="cl-btn primary" disabled={!refOpen.length}
              onClick={() => open({ title: "Claim referral rewards", lines: refOpen.map((r) => ({ label: r.asset.symbol, raw: r.claimable, asset: r.asset })),
                run: async () => { const calls = referralClaimCalls(refOpen); await preflight(pc(), calls, me!); return (await execCalls(calls)).txHash; } })}>
              Claim{refOpen.length && refUsd ? ` ${fmtUsd(refUsd)}` : ""}
            </button>
          </article>
        )}

        {caps.referralGate && gate && (
          <article className="cl-card cl-mini" data-testid="referral-deposit">
            <span className="cl-eyebrow">Referral deposit</span>
            <div className="cl-verify-row"><span className={`cl-pill ${gate.status === "locked" ? "approved" : "pending"}`}>{gate.status === "locked" ? "Referrer locked" : gate.status === "pending" ? "Referrer pending" : "No referrer"}</span></div>
            {gate.escrows.length ? (
              <ul className="cl-escrows">
                {gate.escrows.map((e) => (
                  <li key={e.id}><Money raw={e.amount} asset={gate.usdg} /><span className={unlocked(e, nowSec) ? "cl-ok" : "muted"}>{unlockLabel(e.unlockAt, nowSec)}</span></li>
                ))}
              </ul>
            ) : <p className="muted">No deposits held.</p>}
            {gate.status === "pending" && depositNeeded(gate) != null && (() => {
              const need = depositNeeded(gate)!;
              return (
                <button type="button" className="cl-btn primary" disabled={gate.balance < need} data-testid="deposit-btn"
                  onClick={() => open({ title: "Lock your referrer", label: "Approve & deposit", lines: [{ label: "Deposit", raw: need, asset: gate.usdg }],
                    note: `Held ${Math.round(gate.lockSec / 86400)} days in escrow, then withdraw it here.`, run: async () => (await deposit(pc(), me!, need)).txHash })}>
                  {gate.balance < need ? `Need ${gate.usdg.symbol} to deposit` : "Deposit to qualify"}
                </button>
              );
            })()}
            <button type="button" className="cl-btn ghost" disabled={!gate.escrows.some((e) => unlocked(e, nowSec))}
              onClick={() => { const ok = gate.escrows.filter((e) => unlocked(e, nowSec)); open({ title: "Withdraw deposit", label: "Withdraw", lines: ok.map((e) => ({ label: `Deposit #${e.id}`, raw: e.amount, asset: gate.usdg })), run: async () => { await preflight(pc(), [withdrawCall(ok.map((e) => e.id))], me!); return (await withdraw(ok)).txHash; }, note: "Only unlocked deposits are withdrawn." }); }}>
              Withdraw unlocked
            </button>
          </article>
        )}

        {caps.crew && crew && (
          <article className="cl-card cl-mini wide" data-testid="crew-rewards">
            <span className="cl-eyebrow">Crew rewards</span>
            <p className="muted cl-fine">From the 0.777% profit tax on DUMPs in PVE rockets you hold.</p>
            {crewOpen.length ? (
              <ul className="cl-crew">
                {crewOpen.map((r) => (
                  <li key={r.token}>
                    <Link href={`/coin/${r.token}`}>${r.ticker ?? r.token.slice(0, 6)}</Link>
                    <Money raw={r.pending} asset={r.quote} />
                    <button type="button" className="cl-btn gold sm" onClick={() => open({ title: `Claim $${r.ticker ?? ""} crew rewards`, lines: [{ label: "Crew rewards", raw: r.pending, asset: r.quote }], run: async () => { await preflight(pc(), [crewClaimCall(r.token)], me!); return (await execCalls([crewClaimCall(r.token)])).txHash; } })}>Claim</button>
                  </li>
                ))}
              </ul>
            ) : <p className="muted">Nothing to claim yet.</p>}
          </article>
        )}
      </div>
      {sheet && <ConfirmSheet title={sheet.title} lines={sheet.lines} to={me ?? null} note={sheet.note} busy={busy} error={err} done={done} confirmLabel={sheet.label ?? "Confirm claim"} onConfirm={confirm} onClose={() => setSheet(null)} />}
    </section>
  );
}
