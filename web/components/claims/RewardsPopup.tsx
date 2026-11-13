"use client";
/**
 * Rewards popup (profile r3, lee's list): opened by the chest or "Claim now" on your own profile. Rewards take no space
 * on the page itself.
 *  - top: Rewards · Share · close, Total earned, "+$x this week", gold Claim $x (only when something is ready), invite link + Copy
 *  - tabs: Referral rewards (Earned from friends · Friends invited) · Rocket rewards (Creator / Crew, then each rocket) · History
 * Claim logic, the confirm sheet and the referral deposit card are the old on-page Rewards section's, unchanged
 * (lib/claims/rewardsData.claimEverything, lib/claims/referralGate). Share lives only here.
 * Referral tab shows totals only: fee events (FeeRouter.TradeFeeRouted) do not name the trading friend, so earnings
 * can't be honestly split per friend from existing on-chain data.
 */
import { useEffect, useState } from "react";
import type { Hex } from "viem";
import Sheet from "@/components/profile/Sheet";
import Icon from "@/components/icons/Icon";
import PairArt from "@/components/pairart/PairArt";
import { ChestGlyph } from "@/components/profile/Glyphs";
import { moneyParts, usd2 } from "@/components/profile/money";
import { useCoinIcons } from "@/lib/useCoinIcons";
import { deposit, depositNeeded, unlockLabel, unlocked, withdraw, withdrawCall } from "@/lib/claims/referralGate";
import { claimErrorText, preflight } from "@/lib/claims/common";
import { REWARD_KINDS, REWARD_LABEL, usdLabel, type HistoryRow, type RewardKind } from "@/lib/claims/rewards";
import { claimEverything } from "@/lib/claims/rewardsData";
import { referralUrl } from "@/lib/profile";
import { refLabel } from "@/lib/referral";
import { clientGaslessMode } from "@/lib/aa/sponsorshipMode";
import { creatorClaimCalls, signedAnonClaimCalls } from "@/lib/claims/creatorFees";
import { partitionRelayableCalls, blockedCallsMessage } from "@/lib/trade/gaslessAction";
import { formatActionFeeNote, quoteGaslessAction } from "@/lib/trade/gaslessActionClient";
import { SampleTag, isCashAsset, pc } from "./ui";
import { CLAIM_COPY, ClaimBody, type ClaimRow } from "./ClaimSheet";

const ZERO_TX = `0x${"0".repeat(64)}` as Hex;
import type { Rewards } from "./useRewards";

const T = {
  title: "Rewards",
  share: "Share",
  total: "Total earned",
  week: "this week",
  copy: "Copy",
  copied: "Copied",
  tabs: { referral: ["Referral rewards", "Referral"], rocket: ["Rocket rewards", "Rockets"], history: ["History", "History"] },
  fromFriends: "Earned from friends",
  invited: "Friends invited",
  creator: "Creator", creatorSub: "rockets you launched",
  crew: "Crew", crewSub: "rockets you hold",
  empty: "Nothing yet. Share your link to earn from friends' trades.",
  noRockets: "No rocket rewards yet.",
  noHistory: "No rewards yet.",
  paused: "Referral earnings have stopped growing for now. Anything already here stays yours to claim.",
  sheetTitle: "Claim rewards",
  claimed: "Claimed",
  landed: "It's in your wallet.",
  later: "A few more are ready to claim next time.",
  depositNote: "This is your own deposit, not earnings.",
  linkCopied: "Link copied",
} as const;
type Tab = keyof typeof T.tabs;

type DepSheet = { title: string; lines: { label: string; usd: string }[]; run: () => Promise<Hex>; note?: string; label?: string } | null;

function dayLabel(r: HistoryRow, nowSec: number) {
  const d = new Date(r.to * 1000), y = new Date(nowSec * 1000).getFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() !== y ? { year: "numeric" } : {}) });
}

function Big({ v }: { v: number }) {
  const { whole, cents } = moneyParts(v);
  return <span className={`p5-amt ${v < 0.005 ? "zero" : ""}`} data-testid="rewards-total-usd"><span className="s">$</span><span className="w">{whole}</span><span className="c">.{cents}</span></span>;
}

export default function RewardsPopup({ open, onClose, r }: { open: boolean; onClose: () => void; r: Rewards }) {
  const { me, caps, demo, data, gate, username, canClaim } = r;
  const [tab, setTab] = useState<Tab>("referral");
  const [copied, setCopied] = useState("");
  // combined claim
  const [claimOpen, setClaimOpen] = useState(false);
  const [feeNote, setFeeNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ usd: number; deferred: number; tx?: Hex | null } | null>(null);
  // referral deposit (separate)
  const [sheet, setSheet] = useState<DepSheet>(null);
  const [sBusy, setSBusy] = useState(false);
  const [sErr, setSErr] = useState<string | null>(null);
  const [sDone, setSDone] = useState<Hex | null>(null);
  const nowSec = Math.floor(Date.now() / 1000);
  const icons = useCoinIcons(open ? (data?.rockets ?? []).map((x) => x.token) : []);

  useEffect(() => { if (open) { setTab("referral"); setCopied(""); } }, [open]);

  useEffect(() => {
    if (!claimOpen || !data || !me || !clientGaslessMode() || done) return;
    let cancelled = false;
    void (async () => {
      try {
        const calls = [...creatorClaimCalls(data.claim.creator, caps, me), ...(await signedAnonClaimCalls(pc(), data.claim.creator, me))];
        const { relayable, blocked } = partitionRelayableCalls("anonClaim", calls.map((c) => ({ to: c.to, data: c.data })));
        const extraBlocked = (data.claim.referral.length + data.claim.crew.length) > 0;
        if (!relayable.length) { if (!cancelled) setFeeNote(blockedCallsMessage(blocked.length ? blocked : calls.map((c) => ({ to: c.to, data: c.data })))); return; }
        const q = await quoteGaslessAction({ kind: "anonClaim", signer: me, callCount: relayable.length });
        if (!cancelled) setFeeNote(formatActionFeeNote(q) + (blocked.length || extraBlocked ? " Some wallet, referral, or crew claims can't be relayed yet." : ""));
      } catch (e) { if (!cancelled) setFeeNote((e as Error).message ?? "Could not quote the network fee."); }
    })();
    return () => { cancelled = true; };
  }, [claimOpen, data, me, caps, done]);

  const s = data?.summary;
  const kinds = REWARD_KINDS.filter((k) => (k === "referral" ? caps.referrerFees : k === "crew" ? caps.crew : caps.creatorFees || caps.creatorTokenFees || caps.anonClaims));
  const claimUsd = s?.claimableUsd ?? 0;
  const link = me ? referralUrl(username || null, me) : null;
  const flash = (k: string) => { setCopied(k); window.setTimeout(() => setCopied(""), 1500); };
  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); flash("link"); } catch (e) { console.warn("[disciple] rewards: copy failed", (e as Error)?.message ?? e); }
  };
  const share = async () => {
    if (!link) return;
    try {
      if (typeof navigator.share === "function") { await navigator.share({ title: "DISCIPLE", url: link }); return; }
      await navigator.clipboard.writeText(link); flash("share");
    } catch { /* share sheet closed */ }
  };

  const confirmClaim = async () => {
    if (!data || (!me && !demo)) return;
    setBusy(true); setErr(null);
    try {
      if (demo) { await new Promise((x) => setTimeout(x, 500)); setDone({ usd: claimUsd, deferred: 0 }); return; }
      const res = await claimEverything(pc(), me!, caps, data.claim);
      console.warn("[disciple] rewards: claimed", { txHash: res.txHash, skipped: res.skipped, deferred: res.deferred });
      setDone({ usd: claimUsd, deferred: res.deferred, tx: (res.txHash as Hex | undefined) ?? null });
      void r.reload();
    } catch (e) { setErr(claimErrorText(e)); } finally { setBusy(false); }
  };
  const openDeposit = (x: NonNullable<DepSheet>) => { setSErr(null); setSDone(null); setSheet(x); };
  const confirmDeposit = async () => {
    if (!sheet) return;
    setSBusy(true); setSErr(null);
    try { const h = demo ? (await new Promise((x) => setTimeout(x, 500)), `0x${"cd".repeat(32)}` as Hex) : await sheet.run(); console.warn("[disciple] referral deposit: sent", { txHash: h }); setSDone(h); if (!demo) void r.reload(); }
    catch (e) { setSErr(claimErrorText(e)); } finally { setSBusy(false); }
  };

  // the claim sheet's split (round 2 board): from friends, rockets you host, crew rewards
  const claimRows: ClaimRow[] = !data ? [] : kinds.filter((k) => data.claimableByKind[k] > 0).map((k) => {
    if (k === "referral") return { label: CLAIM_COPY.fromFriends, sub: CLAIM_COPY.fromFriendsSub, usd: data.claimableByKind[k] };
    if (k === "creator") {
      const coin = data.claim.creator.map((x) => (!isCashAsset(x.quote) ? x.quote.symbol : x.tokenSide && x.tokenSide.claimable > BigInt(0) ? `$${x.ticker}` : null)).find(Boolean) ?? null;
      return { label: CLAIM_COPY.hosted, sub: CLAIM_COPY.hostedSub(data.claim.creator.length, coin), usd: data.claimableByKind[k] };
    }
    const names = data.claim.crew.map((c) => data.rockets.find((x) => x.kind === "crew" && x.token.toLowerCase() === c.token.toLowerCase())?.name).filter(Boolean);
    return { label: CLAIM_COPY.crew, sub: names.slice(0, 2).join(", ") + (names.length > 2 ? ` +${names.length - 2}` : ""), usd: data.claimableByKind[k] };
  });
  const claimAllCash = !!data && data.claim.crew.length === 0 && data.claim.creator.every((x) => isCashAsset(x.quote) && !(x.tokenSide && x.tokenSide.claimable > BigInt(0)));
  const creatorUsd = s?.byKind.creator.earnedUsd ?? 0, crewUsd = s?.byKind.crew.earnedUsd ?? 0, refUsd = s?.byKind.referral.earnedUsd ?? 0;

  return (
    <Sheet open={open} onClose={() => { if (claimOpen) { setClaimOpen(false); return; } if (sheet) { setSheet(null); return; } onClose(); }} label={T.title} className="p5-modal p5-rewards" testId="rewards-popup">
      <header className="p5-mhead">
        <h2>{T.title}<SampleTag show={demo} /></h2>
        <div className="p5-mhead-acts">
          <button type="button" className="p5-btn sm" onClick={share} disabled={!link} data-testid="rewards-share"><Icon name="share" size={16} /> {copied === "share" ? T.linkCopied : T.share}</button>
          <button type="button" className="p5-icon" aria-label="Close" onClick={onClose}><Icon name="close" size={18} /></button>
        </div>
      </header>

      <div className="p5-rw-hero" data-testid="rewards-total">
        <span className="p5-l">{T.total}</span>
        {s ? <Big v={s.totalUsd} /> : <span className="p5-skel big" />}
        {s && <span className="p5-week" data-testid="rewards-week"><b>+{usd2(s.weekUsd)}</b> {T.week}</span>}
        {canClaim && (
          <button type="button" className="p5-btn gold wide" data-testid="claim-all-rewards"
            onClick={() => { setErr(null); setDone(null); setFeeNote(null); setClaimOpen(true); }}>
            <ChestGlyph size={18} /> Claim{claimUsd > 0 ? ` ${usd2(claimUsd)}` : ""}
          </button>
        )}
        {data?.referralPaused && <p className="p5-fine" data-testid="referral-sink-note">{T.paused}</p>}
      </div>

      <div className="p5-ref" data-testid="referral-link">
        <span className="u">{me ? refLabel(username || null, me, typeof window !== "undefined" ? window.location.host : undefined) : "disciple.vip/r/you"}</span>
        <button type="button" className="p5-btn sm" onClick={copy} disabled={!link} data-testid="copy-ref"><Icon name="copy" size={16} /> {copied === "link" ? T.copied : T.copy}</button>
      </div>

      <div className="p5-tabs3" role="tablist" aria-label="Rewards">
        {(Object.keys(T.tabs) as Tab[]).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)} data-testid={`rewards-tab-${k}`}>
            <span className="p5-desk">{T.tabs[k][0]}</span><span className="p5-phone">{T.tabs[k][1]}</span>
          </button>
        ))}
      </div>

      {tab === "referral" && (
        <div className="p5-tabbody" data-testid="rewards-referral">
          <div className="p5-mini">
            <div><span className="p5-l">{T.fromFriends}</span><span className="p5-v" data-testid="referral-earned">{s ? usd2(refUsd) : "—"}</span></div>
            <div><span className="p5-l">{T.invited}</span><span className="p5-v" data-testid="referral-friends">{data?.friendsInvited ?? "—"}</span></div>
          </div>
          {data && refUsd < 0.005 && <p className="p5-fine" data-testid="rewards-empty">{T.empty}</p>}
          {caps.referralGate && gate && (
            <div className="p5-card p5-deposit" data-testid="referral-deposit">
              <span className="p5-l">Referral deposit</span>
              <p className="p5-fine">{T.depositNote}</p>
              <span className={`p5-pill ${gate.status === "locked" ? "on" : ""}`}>{gate.status === "locked" ? "Referrer locked" : gate.status === "pending" ? "Referrer pending" : "No referrer"}</span>
              {gate.escrows.length ? (
                <ul className="p5-escrows">
                  {gate.escrows.map((e) => <li key={e.id}><span data-testid="deposit-usd">{usdLabel(e.amount, gate.usdg)}</span><span className={unlocked(e, nowSec) ? "" : "muted"}>{unlockLabel(e.unlockAt, nowSec)}</span></li>)}
                </ul>
              ) : <p className="p5-fine">No deposits held.</p>}
              <div className="p5-actions">
                {gate.status === "pending" && depositNeeded(gate) != null && (() => {
                  const need = depositNeeded(gate)!;
                  return (
                    <button type="button" className="p5-btn" disabled={gate.balance < need} data-testid="deposit-btn"
                      onClick={() => openDeposit({ title: "Lock your referrer", label: "Approve & deposit", lines: [{ label: "Deposit", usd: usdLabel(need, gate.usdg) }],
                        note: `Held ${Math.round(gate.lockSec / 86400)} days in escrow, then withdraw it here.`, run: async () => (await deposit(pc(), me!, need)).txHash })}>
                      {gate.balance < need ? `Need ${gate.usdg.symbol} to deposit` : "Deposit to qualify"}
                    </button>
                  );
                })()}
                <button type="button" className="p5-btn" disabled={!gate.escrows.some((e) => unlocked(e, nowSec))}
                  onClick={() => { const ok = gate.escrows.filter((e) => unlocked(e, nowSec)); openDeposit({ title: "Withdraw deposit", label: "Withdraw", lines: ok.map((e) => ({ label: `Deposit #${e.id}`, usd: usdLabel(e.amount, gate.usdg) })), run: async () => { await preflight(pc(), [withdrawCall(ok.map((e) => e.id))], me!); return (await withdraw(ok)).txHash; }, note: "Only unlocked deposits are withdrawn." }); }}>
                  Withdraw unlocked
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "rocket" && (
        <div className="p5-tabbody" data-testid="rewards-rocket">
          <div className="p5-mini">
            <div><span className="p5-l"><Icon name="rocket" size={14} /> {T.creator} · {T.creatorSub}</span><span className="p5-v">{s ? usd2(creatorUsd) : "—"}</span></div>
            <div><span className="p5-l"><Icon name="crew" size={14} /> {T.crew} · {T.crewSub}</span><span className="p5-v">{s ? usd2(crewUsd) : "—"}</span></div>
          </div>
          {data && (data.rockets.length ? (
            <ul className="p5-plist">
              {data.rockets.map((x) => (
                <li key={`${x.kind}${x.token}`} className="p5-prow">
                  <PairArt src={icons[x.token]} tk={x.ticker} size="list" px={40} />
                  <span className="n"><b>{x.name || `$${x.ticker}`}</b>{x.ticker && <span>${x.ticker}</span>}</span>
                  <span className="p5-tag">{x.kind === "creator" ? T.creator : T.crew}</span>
                  <span className="v up">+{usd2(x.usd)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="p5-fine">{T.noRockets}</p>)}
        </div>
      )}

      {tab === "history" && (
        <div className="p5-tabbody" data-testid="rewards-history">
          {!data ? <span className="p5-skel" /> : data.history.length ? (
            <ul className="p5-hist">
              {data.history.map((h) => (
                <li key={`${h.kind}${h.day}`} data-kind={h.kind}>
                  <span className="n"><b>{REWARD_LABEL[h.kind]}</b><span>{dayLabel(h, nowSec)}</span></span>
                  <span className="v up">+{usd2(h.usd)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="p5-fine">{T.noHistory}</p>}
        </div>
      )}

      {claimOpen && data && (
        <div className="p5-inner cs-over">
          <section className={`ds-modal r2-modal cs-inner${done ? " cs-claimed" : ""}`} role="dialog" aria-modal="true" aria-label={T.sheetTitle} data-testid="claim-confirm">
            <ClaimBody title={T.sheetTitle} rows={claimRows} allCash={claimAllCash} feeNote={feeNote} busy={busy} error={err}
              done={done ? (done.tx ?? ZERO_TX) : null} doneNote={done && done.deferred > 0 ? T.later : null}
              onConfirm={confirmClaim} onClose={() => setClaimOpen(false)} />
          </section>
        </div>
      )}
      {sheet && (
        <div className="p5-inner" role="dialog" aria-modal="true" aria-label={sheet.title} data-testid="deposit-confirm">
          <div className="p5-inner-box">
            <span className="p5-l">{sDone ? "Done" : "Confirm"}</span>
            <h3>{sheet.title}</h3>
            <ul className="p5-lines">{sheet.lines.map((l, i) => <li key={i}><span className="muted">{l.label}</span><span>{l.usd}</span></li>)}</ul>
            {sheet.note && !sDone && <p className="p5-fine">{sheet.note}</p>}
            {sErr && <p className="p5-err" role="alert">{sErr}</p>}
            <div className="p5-actions">
              <button type="button" className="p5-btn" onClick={() => setSheet(null)}>{sDone ? "Close" : "Cancel"}</button>
              {!sDone && <button type="button" className="p5-btn primary" disabled={sBusy} onClick={confirmDeposit}>{sBusy ? "Sending…" : sheet.label ?? "Confirm"}</button>}
            </div>
          </div>
        </div>
      )}
    </Sheet>
  );
}
