"use client";
/**
 * /creator — Rocket creator dashboard (v4): per rocket claimable fees (quote coin + USD), launch-token share
 * (post-grad), lifetime earned, claimed so far, recent accruals, Claim / Claim all, and verified-badge requests.
 *   wallet launches  FeeRouter creatorAccrued + claimCreatorFees, creatorTokenAccrued + claimCreatorTokenFees
 *   private          the coin's AnonLauncher (v2, or v1 legacy) pending(token) + claimMany / claimManyBySig (stealth key)
 * Every claim is eth_call-simulated first so a revert shows plain copy before anything is signed.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Hex } from "viem";
import { anonSigClaimCalls, creatorClaimCalls, creatorDashboard, sendCreatorClaims, type CreatorRocket } from "@/lib/claims/creatorFees";
import { myStealthCoins, myStealthKeys, stealthKeyFor } from "@/lib/privateLaunch";
import { claimErrorText, fmtUsd, preflight, toUsd } from "@/lib/claims/common";
import { demoRockets, demoRedeploy } from "@/lib/claims/demo";
import { connectPrivy } from "@/lib/wallet";
import VerifiedBadge from "@/components/VerifiedBadge";
import { ConfirmSheet, Money, SampleTag, TxLink, pc, shortA, useCaps, useWalletAddr, type ConfirmLine } from "./ui";
import VerifyRequest from "./VerifyRequest";

type Pending = { rows: CreatorRocket[]; title: string } | null;

export default function CreatorDashboard() {
  const me = useWalletAddr();
  const { caps, ready, demo } = useCaps();
  const [rows, setRows] = useState<CreatorRocket[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [sheetErr, setSheetErr] = useState<string | null>(null);
  const [done, setDone] = useState<Hex | null>(null);

  const load = useCallback(async () => {
    if (demo) { setRows(demoRockets(demoRedeploy())); return; }
    if (!me || !ready) return;
    setErr(null);
    // private launches: coins announced to this account's stealth keys (one silent owner signature; none on the EOA path)
    const stealth = caps.anonClaims ? await myStealthKeys().then((k) => myStealthCoins(pc(), k)).catch(() => []) : [];
    try { setRows(await creatorDashboard(pc(), me, caps, 6, stealth)); } catch (e) { setErr(claimErrorText(e)); setRows([]); }
  }, [me, ready, demo, caps]);
  useEffect(() => { void load(); }, [load]);

  const totals = useMemo(() => {
    const t = { claimable: 0, lifetime: 0, claimed: 0, open: 0 };
    for (const r of rows ?? []) {
      t.claimable += toUsd(r.claimable, r.quote) ?? 0; t.lifetime += toUsd(r.lifetime, r.quote) ?? 0; t.claimed += toUsd(r.claimed, r.quote) ?? 0;
      if (r.claimable > BigInt(0) || (r.tokenSide?.claimable ?? BigInt(0)) > BigInt(0)) t.open++;
    }
    return t;
  }, [rows]);

  const linesOf = (rs: CreatorRocket[]): ConfirmLine[] => rs.flatMap((r) => [
    ...(r.claimable > BigInt(0) ? [{ label: `$${r.ticker} fees`, raw: r.claimable, asset: r.quote }] : []),
    ...((r.anon || caps.creatorTokenFees) && r.tokenSide && r.tokenSide.claimable > BigInt(0) ? [{ label: `$${r.ticker} token share`, raw: r.tokenSide.claimable, asset: r.tokenSide.asset }] : []),
  ]);
  const open = (rs: CreatorRocket[], title: string) => { setSheetErr(null); setDone(null); setPending({ rows: rs, title }); };
  const confirm = async () => {
    if (!pending) return;
    setBusy(true); setSheetErr(null);
    try {
      if (demo) { await new Promise((r) => setTimeout(r, 600)); setDone(`0x${"ab".repeat(32)}` as Hex); return; }
      const calls = creatorClaimCalls(pending.rows, caps, me ?? undefined);
      if (me && pending.rows.some((r) => r.stealth)) { const k = await myStealthKeys(); calls.push(...(await anonSigClaimCalls(pc(), pending.rows, me, (eph) => stealthKeyFor(k, eph)))); }
      if (me) await preflight(pc(), calls, me);
      const r = await sendCreatorClaims(calls);
      setDone(r.txHash);
      void load();
    } catch (e) { setSheetErr(claimErrorText(e)); } finally { setBusy(false); }
  };
  const hasTok = (r: CreatorRocket) => (r.anon || caps.creatorTokenFees) && (r.tokenSide?.claimable ?? BigInt(0)) > BigInt(0);
  const canClaim = (r: CreatorRocket) => r.claimable > BigInt(0) || hasTok(r);
  const claimable = (rows ?? []).filter(canClaim);

  return (
    <div className="cl-page" data-testid="creator-dashboard">
      <header className="cl-head">
        <div>
          <div className="cl-eyebrow">Creator</div>
          <h1 className="cl-display">Your rockets</h1>
          <p className="muted">Fees from every BOOST and DUMP on rockets you launched. Claim any time.</p>
        </div>
        <SampleTag show={demo} />
      </header>

      {!me && !demo ? (
        <section className="cl-card cl-empty">
          <h3 className="cl-display sm">Sign in to see your rockets</h3>
          <button type="button" className="cl-btn primary" onClick={() => connectPrivy()}>Sign in</button>
        </section>
      ) : rows == null ? (
        <section className="cl-card cl-empty"><div className="cl-skel" /><div className="cl-skel short" /></section>
      ) : !rows.length ? (
        <section className="cl-card cl-empty">
          <h3 className="cl-display sm">No rockets yet</h3>
          <p className="muted">Launch one and its fees show up here.</p>
          <Link className="cl-btn primary" href="/create">Launch a rocket</Link>
          {err && <p className="cl-err">{err}</p>}
        </section>
      ) : (
        <>
          <section className="cl-summary">
            <div className="cl-stat hero"><span>Claimable now</span><strong>{fmtUsd(totals.claimable) || "—"}</strong><em>{totals.open} rocket{totals.open === 1 ? "" : "s"}</em></div>
            <div className="cl-stat"><span>Lifetime earned</span><strong>{fmtUsd(totals.lifetime) || "—"}</strong></div>
            <div className="cl-stat"><span>Claimed so far</span><strong>{fmtUsd(totals.claimed) || "—"}</strong></div>
            <button type="button" className="cl-btn primary lg" disabled={!claimable.length} onClick={() => open(claimable, "Claim all creator fees")} data-testid="claim-all">
              Claim all creator fees
            </button>
          </section>
          <p className="cl-fine muted">USD uses the live quote price. One transaction for Claim all.</p>

          <div className="cl-grid">
            {rows.map((r) => (
              <article key={r.token} className="cl-card cl-rocket" data-testid="creator-rocket">
                <div className="cl-rocket-top">
                  <div>
                    <Link href={`/coin/${r.token}`} className="cl-rocket-name">{r.name} <VerifiedBadge token={r.token} size={14} /></Link>
                    <div className="muted cl-mono">${r.ticker} · {shortA(r.token)}{r.anon && <span className="cl-pill">Private</span>}</div>
                  </div>
                  <button type="button" className="cl-btn gold" disabled={!canClaim(r)}
                    onClick={() => open([r], `Claim $${r.ticker} creator fees`)} data-testid="claim-one">Claim creator fees</button>
                </div>
                <div className="cl-claimable">
                  <span className="cl-eyebrow">Claimable</span>
                  <Money raw={r.claimable} asset={r.quote} big />
                  {(r.anon || caps.creatorTokenFees) && r.tokenSide && (
                    <div className="cl-token-side"><span className="muted">Token share</span><Money raw={r.tokenSide.claimable} asset={r.tokenSide.asset} /></div>
                  )}
                  {r.anon && r.tokenUnclaimable && (
                    <div className="cl-token-side cl-pending-upgrade" data-testid="unclaimable-legacy"
                      title="This coin launched on the legacy AnonLauncher (v1), which can't claim its post-ascension token share."
                      aria-label="Token share unclaimable: legacy launcher.">
                      <span className="muted">Token share <span className="cl-pill">Unclaimable (legacy launcher)</span></span>
                      <Money raw={r.tokenUnclaimable.raw} asset={r.tokenUnclaimable.asset} />
                    </div>
                  )}
                </div>
                <dl className="cl-kv">
                  <div><dt>Lifetime earned</dt><dd><Money raw={r.lifetime} asset={r.quote} /></dd></div>
                  <div><dt>Claimed so far</dt><dd><Money raw={r.claimed} asset={r.quote} /></dd></div>
                </dl>
                <div className="cl-recent">
                  <div className="cl-eyebrow">Recent fees</div>
                  {r.recent.length ? (
                    <ul>
                      {r.recent.map((a) => (
                        <li key={`${a.tx}${a.trader}${a.side}`}><span className="cl-mono muted">{shortA(a.trader)}</span><Money raw={a.amount} asset={a.side === "token" && r.tokenSide ? r.tokenSide.asset : r.quote} /><TxLink hash={a.tx}>tx</TxLink></li>
                      ))}
                    </ul>
                  ) : <p className="muted">{r.anon ? "Private rocket. Fees are claimed privately to this account." : "No trades yet."}</p>}
                </div>
                <VerifyRequest token={r.token} demo={demo} />
              </article>
            ))}
          </div>
        </>
      )}

      {pending && (
        <ConfirmSheet title={pending.title} lines={linesOf(pending.rows)} to={me ?? (demo ? "0x5a3c7743d365f770710fe15f4bbf1cec7bc41006" : null)}
          note={pending.rows.length > 1 ? `${pending.rows.length} rockets in one transaction.` : pending.rows[0]?.anon ? "Claimed privately, paid to this account." : "Fees go to the wallet that launched the rocket."}
          busy={busy} error={sheetErr} done={done} onConfirm={confirm} onClose={() => setPending(null)} />
      )}
    </div>
  );
}
