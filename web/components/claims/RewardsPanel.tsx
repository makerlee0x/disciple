"use client";
/**
 * Rewards panel (maker 2026-11-19, signed-off mockup): the private Hangar's fourth balance tile opens it. It replaces the
 * old Rewards popup and the banner's Rewards / Claim rewards button.
 *  - home: Ready to claim + one Claim for every source (hosting, crew, referral, bonus), the four source tiles,
 *    Rockets | History, invite link + Copy. No Share (the invite link is right there).
 *  - a rocket you host: its own Claim, Pays to (where its creator fees go: your wallet, another wallet or an @user),
 *    Coin info (image, description, links; name + ticker are locked on-chain), Transfer creator.
 * Claim logic, the confirm sheet and the referral deposit card are the old popup's (lib/claims/rewardsData.claimEverything,
 * lib/claims/referralGate). Coin admin calls: lib/claims/coinAdmin.
 * Bonus (treasury pushes) has no on-chain source yet: the tile shows $0 until one exists.
 */
import { useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import Sheet from "@/components/profile/Sheet";
import Icon from "@/components/icons/Icon";
import PairArt from "@/components/pairart/PairArt";
import { moneyParts, usd2 } from "@/components/profile/money";
import { useCoinIcons } from "@/lib/useCoinIcons";
import { deposit, depositNeeded, unlockLabel, unlocked, withdraw, withdrawCall } from "@/lib/claims/referralGate";
import { claimErrorText, preflight } from "@/lib/claims/common";
import { usdLabel, type HistoryRow, type RewardKind } from "@/lib/claims/rewards";
import { claimEverything, type RewardsData } from "@/lib/claims/rewardsData";
import type { CreatorRocket } from "@/lib/claims/creatorFees";
import { readCoinMeta, readPayTo, saveCoinMeta, setPayTo, transferCreatorTo, type CoinMeta, type PayTo } from "@/lib/claims/coinAdmin";
import { referralUrl } from "@/lib/profile";
import { refLabel } from "@/lib/referral";
import { clientGaslessMode } from "@/lib/aa/sponsorshipMode";
import { creatorClaimCalls, signedAnonClaimCalls } from "@/lib/claims/creatorFees";
import { partitionRelayableCalls, blockedCallsMessage } from "@/lib/trade/gaslessAction";
import { formatActionFeeNote, quoteGaslessAction } from "@/lib/trade/gaslessActionClient";
import { IMAGE_COPY, launchImageFrom, type ModerateResponse } from "@/lib/launchImage";
import SquareCrop, { cropSquare } from "@/components/create/SquareCrop";
import UserPicker, { RecipientCard } from "@/components/ui/UserPicker";
import type { Recipient } from "@/lib/send/recipient";
import { SampleTag, isCashAsset, pc, shortA } from "./ui";
import { CashHead, Check, ErrIcon } from "@/components/cash/bits";
import { CLAIM_COPY, ClaimBody, type ClaimRow } from "./ClaimSheet";
import type { Rewards } from "./useRewards";
import { isNativeApp } from "@/lib/native";

const ZERO_TX = `0x${"0".repeat(64)}` as Hex;
const lc = (a: string) => a.toLowerCase();

const T = {
  title: "Rewards",
  ready: "Ready to claim",
  allTime: "earned all time",
  week: "this week",
  claim: "Claim",
  tiles: { hosting: "Hosting", crew: "Crew", referral: "Referral", bonus: "Bonus" },
  rocketsN: (n: number) => `${n} ${n === 1 ? "rocket" : "rockets"}`,
  invitedN: (n: number) => `${n} invited`,
  rockets: "Rockets", history: "History",
  host: "Host", crewTag: "Crew", anon: "Anon", burn: "Burn", pool: "Pool",
  noRockets: "No rocket rewards yet.",
  noHistory: "No rewards yet.",
  kind: { creator: "Hosting", crew: "Crew", referral: "Referral" } as Record<RewardKind, string>,
  inviteLink: "Your invite link", copy: "Copy", copied: "Copied",
  payTo: "Pays to", yourWallet: "Your wallet", someoneElse: "Someone else", change: "Change", payToLabel: "Wallet or @username",
  payToWarn: (coin: string) => `$${coin} fees pay here. Sent rewards can't be pulled back.`,
  save: "Save", saving: "Saving…", saved: "Saved",
  coinPage: "Coin page", coinInfo: "Coin info", changeImage: "Change image", cropUse: "Use image", cropCancel: "Cancel", name: "Name", ticker: "Ticker",
  description: "Description", links: "Links", saveInfo: "Save info",
  creator: "Creator", transfer: "Transfer creator", newCreator: "New creator",
  transferWarn: (who: string) => `Unclaimed and future fees, coin info and creator rights move to ${who}. You can't undo this.`,
  transferNote: (v: string) => `${v} unclaimed goes with it`,
  hold: "Hold to transfer", holding: "Keep holding…", transferring: "Transferring…", transferred: "Transferred",
  sheetTitle: "Claim rewards", later: "A few more are ready to claim next time.",
  ok: "Done",
  // referral deposit (unchanged from the old popup)
  depositNote: "This is your own deposit, not earnings.",
  lock: "Lock it in", lockTitle: "Lock in your invite", lockAmt: (amt: string) => `Lock it in · ${amt}`, locking: "Locking it in…",
  depositLine: "Deposit", depositSub: "Confirms the friend who invited you",
  takeBack: (d: number) => `It's still yours: held ${d} days, then you can take it back here.`,
  lockDone: "Invite locked in", lockDoneSub: (d: number) => `Your deposit is held ${d} days, then it's yours to move.`,
  takeTitle: "Take back your deposit", takeBtn: "Take it back", taking: "Taking it back…", unlockedSub: "Unlocked",
  takeNote: "Only unlocked deposits come back. It lands in your cash.", takeDone: "Deposit back in your cash",
} as const;

type View = { v: "home" | "history" } | { v: "coin" | "payto" | "transfer"; token: string };
type DepSheet = { title: string; lines: { label: string; sub?: string; usd: string }[]; run: () => Promise<Hex>; note?: string; label: string; busyLabel: string; doneTitle: string; doneSub?: string } | null;
type ClaimScope = { token: string | null } | null;

function dayLabel(r: HistoryRow, nowSec: number) {
  const d = new Date(r.to * 1000), y = new Date(nowSec * 1000).getFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() !== y ? { year: "numeric" } : {}) });
}
function Big({ v }: { v: number }) {
  const { whole, cents } = moneyParts(v);
  return <span className={`p5-amt ${v < 0.005 ? "zero" : ""}`} data-testid="rewards-claimable-usd"><span className="s">$</span><span className="w">{whole}</span><span className="c">.{cents}</span></span>;
}
function Head({ title, onBack, onClose, right }: { title: React.ReactNode; onBack?: () => void; onClose: () => void; right?: React.ReactNode }) {
  return (
    <header className="p5-mhead">
      {onBack
        ? <button type="button" className="p5-icon" aria-label="Back" onClick={onBack}><Icon name="chevron-left" size={20} /></button>
        : <button type="button" className="p5-icon p5-phone" aria-label="Back" onClick={onClose}><Icon name="chevron-left" size={20} /></button>}
      <h2>{title}</h2>
      <div className="p5-mhead-acts">
        {right}
        <button type="button" className="p5-icon p5-desk" aria-label="Close" onClick={onClose}><Icon name="close" size={18} /></button>
      </div>
    </header>
  );
}

/** Press and hold (can't-undo steps): fills over `ms`, fires once, lets go = nothing happens. */
function HoldButton({ label, busyLabel, busy, disabled, onDone, ms = 1200, testId }: { label: string; busyLabel: string; busy: boolean; disabled?: boolean; onDone: () => void; ms?: number; testId?: string }) {
  const [p, setP] = useState(0);
  const t = useRef<number | null>(null);
  const stop = () => { if (t.current) cancelAnimationFrame(t.current); t.current = null; setP(0); };
  const start = () => {
    if (disabled || busy) return;
    const t0 = performance.now();
    const tick = () => {
      const x = Math.min(1, (performance.now() - t0) / ms);
      setP(x);
      if (x >= 1) { t.current = null; setP(0); onDone(); return; }
      t.current = requestAnimationFrame(tick);
    };
    t.current = requestAnimationFrame(tick);
  };
  useEffect(() => stop, []);
  return (
    <button type="button" className="p5-btn wide cp-danger" disabled={disabled || busy} data-testid={testId}
      onPointerDown={start} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}
      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); start(); } }}
      onKeyUp={(e) => { if (e.key === "Enter" || e.key === " ") stop(); }}>
      <span className="cp-fill" style={{ transform: `scaleX(${p})` }} aria-hidden />
      <span className="cp-hl">{busy ? <><span className="r2-spin" aria-hidden />{busyLabel}</> : p > 0 ? T.holding : label}</span>
    </button>
  );
}

/** Decode a picked file (object URL stays alive for the crop step; the caller revokes it). */
async function loadImage(f: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(f);
  return new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => { URL.revokeObjectURL(url); bad(new Error(IMAGE_COPY.upload)); }; i.src = url; });
}

/** Square-crop at the dragged position and store it through /api/moderate-image (same as the launch form). */
async function uploadCoinImage(img: HTMLImageElement, pos: { x: number; y: number }): Promise<string> {
  const fd = new FormData(); fd.append("uri", cropSquare(img, pos));
  const v = await fetch("/api/moderate-image", { method: "POST", body: fd, signal: AbortSignal.timeout?.(65_000) })
    .then(async (r) => (await r.json().catch(() => null)) as ModerateResponse).catch(() => null);
  const li = launchImageFrom(v);
  if (!li.ok) throw new Error(IMAGE_COPY[li.reason]);
  return li.uri;
}

export default function RewardsPanel({ open, onClose, r, start }: { open: boolean; onClose: () => void; r: Rewards; start?: View }) {
  const { me, caps, demo, data, gate, username, canClaim } = r;
  const [view, setView] = useState<View>(start ?? { v: "home" });
  const [copied, setCopied] = useState(false);
  // App Review 3.1.5(v): crypto apps can't pay for inviting people or posting. Inside the iPhone app the invite link, the
  // Referral tile and the referral deposit card stay hidden (earned referral funds still claim through Claim). Bonus has no
  // source yet ($0), so it goes too and the two tiles left fill the phone grid.
  const [app, setApp] = useState(false);
  useEffect(() => { setApp(isNativeApp()); }, []);
  // claim (all, or one rocket)
  const [claimScope, setClaimScope] = useState<ClaimScope>(null);
  const [feeNote, setFeeNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ usd: number; deferred: number; tx?: Hex | null } | null>(null);
  // referral deposit
  const [sheet, setSheet] = useState<DepSheet>(null);
  const [sBusy, setSBusy] = useState(false);
  const [sErr, setSErr] = useState<string | null>(null);
  const [sDone, setSDone] = useState<Hex | null>(null);
  const nowSec = Math.floor(Date.now() / 1000);
  const hosted = data?.hosted ?? [];
  const crewRows = (data?.rockets ?? []).filter((x) => x.kind === "crew");
  const icons = useCoinIcons(open ? [...hosted.map((x) => x.token), ...crewRows.map((x) => x.token)] : []);

  useEffect(() => { if (open) { setView(start ?? { v: "home" }); setCopied(false); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const scoped = (d: RewardsData, s: NonNullable<ClaimScope>): RewardsData["claim"] => s.token == null ? d.claim
    : { referral: [], crew: [], creator: d.claim.creator.filter((x) => lc(x.token) === lc(s.token!)) };

  useEffect(() => {
    if (!claimScope || !data || !me || !clientGaslessMode() || done || demo) return;
    let cancelled = false;
    void (async () => {
      try {
        const c = scoped(data, claimScope);
        const calls = [...creatorClaimCalls(c.creator, caps, me), ...(await signedAnonClaimCalls(pc(), c.creator, me))];
        const { relayable, blocked } = partitionRelayableCalls("anonClaim", calls.map((x) => ({ to: x.to, data: x.data })));
        const extraBlocked = (c.referral.length + c.crew.length) > 0;
        if (!relayable.length) { if (!cancelled) setFeeNote(blockedCallsMessage(blocked.length ? blocked : calls.map((x) => ({ to: x.to, data: x.data })))); return; }
        const q = await quoteGaslessAction({ kind: "anonClaim", signer: me, callCount: relayable.length });
        if (!cancelled) setFeeNote(formatActionFeeNote(q) + (blocked.length || extraBlocked ? " Some wallet, referral, or crew claims can't be relayed yet." : ""));
      } catch (e) { if (!cancelled) setFeeNote((e as Error).message ?? "Could not quote the network fee."); }
    })();
    return () => { cancelled = true; };
  }, [claimScope, data, me, caps, done, demo]); // eslint-disable-line react-hooks/exhaustive-deps

  const s = data?.summary;
  const claimUsd = s?.claimableUsd ?? 0;
  const ready = (kind: "creator" | "crew", token: string) => data?.readyUsd?.[`${kind}:${lc(token)}`] ?? 0;
  const link = me ? referralUrl(username || null, me) : null;
  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch (e) { console.warn("[disciple] rewards: copy failed", (e as Error)?.message ?? e); }
  };

  const openClaim = (token: string | null) => { setErr(null); setDone(null); setFeeNote(null); setClaimScope({ token }); };
  const scopeUsd = claimScope?.token ? ready("creator", claimScope.token) : claimUsd;
  const confirmClaim = async () => {
    if (!data || !claimScope || (!me && !demo)) return;
    setBusy(true); setErr(null);
    try {
      if (demo) { await new Promise((x) => setTimeout(x, 500)); setDone({ usd: scopeUsd, deferred: 0 }); return; }
      const res = await claimEverything(pc(), me!, caps, scoped(data, claimScope));
      console.warn("[disciple] rewards: claimed", { txHash: res.txHash, skipped: res.skipped, deferred: res.deferred, token: claimScope.token });
      setDone({ usd: scopeUsd, deferred: res.deferred, tx: (res.txHash as Hex | undefined) ?? null });
      void r.reload();
    } catch (e) { setErr(claimErrorText(e)); } finally { setBusy(false); }
  };
  const claimRows: ClaimRow[] = !data || !claimScope ? [] : (() => {
    const c = scoped(data, claimScope);
    const rows: ClaimRow[] = [];
    const ref = c.referral.length ? data.claimableByKind.referral : 0;
    if (ref > 0) rows.push({ label: T.tiles.referral, usd: ref });
    if (c.creator.length) {
      const usd = claimScope.token ? ready("creator", claimScope.token) : data.claimableByKind.creator;
      const coin = c.creator.map((x) => (!isCashAsset(x.quote) ? x.quote.symbol : x.tokenSide && x.tokenSide.claimable > BigInt(0) ? `$${x.ticker}` : null)).find(Boolean) ?? null;
      if (usd > 0) rows.push({ label: CLAIM_COPY.hosted, sub: CLAIM_COPY.hostedSub(c.creator.length, coin), usd });
    }
    if (c.crew.length && data.claimableByKind.crew > 0) {
      const names = c.crew.map((x) => data.rockets.find((y) => y.kind === "crew" && lc(y.token) === lc(x.token))?.name).filter(Boolean);
      rows.push({ label: CLAIM_COPY.crew, sub: names.slice(0, 2).join(", ") + (names.length > 2 ? ` +${names.length - 2}` : ""), usd: data.claimableByKind.crew });
    }
    return rows;
  })();
  const claimAllCash = !!data && !!claimScope && (() => { const c = scoped(data, claimScope); return c.crew.length === 0 && c.creator.every((x) => isCashAsset(x.quote) && !(x.tokenSide && x.tokenSide.claimable > BigInt(0))); })();

  const openDeposit = (x: NonNullable<DepSheet>) => { setSErr(null); setSDone(null); setSheet(x); };
  const confirmDeposit = async () => {
    if (!sheet) return;
    setSBusy(true); setSErr(null);
    try { const h = demo ? (await new Promise((x) => setTimeout(x, 500)), `0x${"cd".repeat(32)}` as Hex) : await sheet.run(); console.warn("[disciple] referral deposit: sent", { txHash: h }); setSDone(h); if (!demo) void r.reload(); }
    catch (e) { setSErr(claimErrorText(e)); } finally { setSBusy(false); }
  };

  const nHost = hosted.length, nCrew = crewRows.length;
  const tiles = [
    { k: "creator", label: T.tiles.hosting, usd: s?.byKind.creator.earnedUsd ?? 0, sub: T.rocketsN(nHost) },
    { k: "crew", label: T.tiles.crew, usd: s?.byKind.crew.earnedUsd ?? 0, sub: T.rocketsN(nCrew) },
    { k: "referral", label: T.tiles.referral, usd: s?.byKind.referral.earnedUsd ?? 0, sub: data?.friendsInvited != null ? T.invitedN(data.friendsInvited) : "" },
    { k: "bonus", label: T.tiles.bonus, usd: 0, sub: "" },
  ].filter((x) => !app || (x.k !== "referral" && x.k !== "bonus"));
  const coin = "token" in view ? hosted.find((x) => lc(x.token) === lc(view.token)) ?? null : null;
  const back = () => setView(view.v === "payto" || view.v === "transfer" ? { v: "coin", token: (view as { token: string }).token } : { v: "home" });
  const onSheetClose = () => {
    if (claimScope) { setClaimScope(null); return; }
    if (sheet) { setSheet(null); return; }
    if (view.v !== "home" && view.v !== "history") { back(); return; }
    onClose();
  };

  return (
    <Sheet open={open} onClose={onSheetClose} label={T.title} className={`p5-modal p5-rewards cp${coin ? " cp-coin" : ""}`} testId="rewards-popup">
      {(view.v === "home" || view.v === "history") && <>
        <Head title={<>{T.title}<SampleTag show={demo} /></>} onClose={onClose} />
        <div className="p5-rw-claim" data-testid="rewards-total">
          <div className="tx">
            <span className="k">{T.ready}</span>
            {s ? <Big v={claimUsd} /> : <span className="p5-skel big" />}
            {s && <span className="sub"><span data-testid="rewards-total-usd">{usd2(s.totalUsd)}</span> {T.allTime} · <b className="up" data-testid="rewards-week">+{usd2(s.weekUsd)} {T.week}</b></span>}
          </div>
          <button type="button" className="p5-rw-go" disabled={!canClaim} data-testid="claim-all-rewards" onClick={() => openClaim(null)}>{T.claim}</button>
        </div>
        <div className="p5-rw-tiles cp-tiles">
          {tiles.map((x) => <div key={x.k} className="p5-rw-tile" data-testid={`rewards-tile-${x.k}`}><span className="k">{x.label}</span><b>{s ? usd2(x.usd) : "—"}</b><span>{x.sub}</span></div>)}
        </div>
        <div className="p5-tabs3" role="tablist" aria-label={T.title}>
          {(["home", "history"] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={view.v === k} className={view.v === k ? "on" : ""} onClick={() => setView({ v: k })} data-testid={`rewards-tab-${k === "home" ? "rocket" : "history"}`}>
              {k === "home" ? T.rockets : T.history}
            </button>
          ))}
        </div>
        {view.v === "home" ? (
          <div className="p5-tabbody" data-testid="rewards-rocket">
            {!data ? <span className="p5-skel" /> : nHost + nCrew ? (
              <ul className="p5-plist cp-list">
                {hosted.map((x) => (
                  <li key={`h${x.token}`}>
                    <button type="button" className="p5-prow cp-prow" onClick={() => setView({ v: "coin", token: x.token })} aria-label={x.name || `$${x.ticker}`} data-testid="rewards-host-row">
                      <PairArt src={icons[x.token]} tk={x.ticker} size="list" px={40} />
                      <span className="n"><b>{x.name || `$${x.ticker}`}</b>{x.ticker && <span>${x.ticker}</span>}</span>
                      {x.anon && <span className="p5-tag cp-anon"><Icon name="lock" size={11} /><span className="t"> {T.anon}</span></span>}
                      {x.routed ? <span className="p5-tag">{x.routed === 2 ? T.burn : T.pool}</span> : <span className="p5-tag">{T.host}</span>}
                      <span className="v up">+{usd2(ready("creator", x.token))}</span>
                      <Icon name="chevron-right" size={18} className="cp-chev" />
                    </button>
                  </li>
                ))}
                {crewRows.map((x) => (
                  <li key={`c${x.token}`} className="p5-prow cp-prow">
                    <PairArt src={icons[x.token]} tk={x.ticker} size="list" px={40} />
                    <span className="n"><b>{x.name || `$${x.ticker}`}</b>{x.ticker && <span>${x.ticker}</span>}</span>
                    <span className="p5-tag">{T.crewTag}</span>
                    <span className="v up">+{usd2(ready("crew", x.token))}</span>
                    <span className="cp-chev sp" />
                  </li>
                ))}
              </ul>
            ) : <p className="p5-fine">{T.noRockets}</p>}
          </div>
        ) : (
          <div className="p5-tabbody" data-testid="rewards-history">
            {caps.referralGate && gate && !app && (
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
                        onClick={() => openDeposit({ title: T.lockTitle, label: T.lockAmt(usdLabel(need, gate.usdg)), busyLabel: T.locking,
                          lines: [{ label: T.depositLine, sub: T.depositSub, usd: usdLabel(need, gate.usdg) }],
                          note: T.takeBack(Math.round(gate.lockSec / 86400)), doneTitle: T.lockDone, doneSub: T.lockDoneSub(Math.round(gate.lockSec / 86400)),
                          run: async () => (await deposit(pc(), me!, need)).txHash })}>
                        {gate.balance < need ? `Add ${usdLabel(need, gate.usdg)} cash to lock it in` : T.lock}
                      </button>
                    );
                  })()}
                  <button type="button" className="p5-btn" disabled={!gate.escrows.some((e) => unlocked(e, nowSec))}
                    onClick={() => { const ok = gate.escrows.filter((e) => unlocked(e, nowSec)); openDeposit({ title: T.takeTitle, label: T.takeBtn, busyLabel: T.taking, doneTitle: T.takeDone,
                      lines: ok.map((e) => ({ label: T.depositLine, sub: T.unlockedSub, usd: usdLabel(e.amount, gate.usdg) })),
                      note: T.takeNote, run: async () => { await preflight(pc(), [withdrawCall(ok.map((e) => e.id))], me!); return (await withdraw(ok)).txHash; } }); }}>
                    {T.takeBtn}
                  </button>
                </div>
              </div>
            )}
            {!data ? <span className="p5-skel" /> : data.history.length ? (
              <ul className="p5-hist cp-hist">
                {data.history.map((h) => (
                  <li key={`${h.kind}${h.day}`} data-kind={h.kind}>
                    <span className="n"><b>{T.kind[h.kind]}</b><span>{dayLabel(h, nowSec)}</span></span>
                    <span className="v up">+{usd2(h.usd)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="p5-fine">{T.noHistory}</p>}
          </div>
        )}
        {!app && <div className="p5-rw-invite">
          <span className="lab">{T.inviteLink}</span>
          <div className="p5-ref" data-testid="referral-link">
            <span className="u">{me ? refLabel(username || null, me, typeof window !== "undefined" ? window.location.host : undefined) : "disciple.vip/r/you"}</span>
            <button type="button" className="p5-btn sm" onClick={copy} disabled={!link} data-testid="copy-ref"><Icon name="copy" size={16} /> {copied ? T.copied : T.copy}</button>
          </div>
        </div>}
      </>}

      {coin && view.v === "coin" && <CoinView key={coin.token} coin={coin} me={me} demo={demo} icon={icons[coin.token]} ready={ready("creator", coin.token)}
        onBack={back} onClose={onClose} onClaim={() => openClaim(coin.token)} onPayTo={() => setView({ v: "payto", token: coin.token })} onTransfer={() => setView({ v: "transfer", token: coin.token })}
        onSaved={() => void r.reload()} />}
      {coin && view.v === "payto" && <PayToView coin={coin} me={me} demo={demo} icon={icons[coin.token]} onBack={back} onClose={onClose} />}
      {coin && view.v === "transfer" && <TransferView coin={coin} me={me} demo={demo} icon={icons[coin.token]} ready={ready("creator", coin.token)} onBack={back} onClose={onClose}
        onDone={() => { void r.reload(); setView({ v: "home" }); }} />}

      {claimScope && data && (
        <div className="p5-inner cs-over">
          <section className={`ds-modal r2-modal cs-inner${done ? " cs-claimed" : ""}`} role="dialog" aria-modal="true" aria-label={T.sheetTitle} data-testid="claim-confirm">
            <ClaimBody title={T.sheetTitle} rows={claimRows} allCash={claimAllCash} feeNote={feeNote} busy={busy} error={err}
              done={done ? (done.tx ?? ZERO_TX) : null} doneNote={done && done.deferred > 0 ? T.later : null}
              onConfirm={confirmClaim} onClose={() => setClaimScope(null)} />
          </section>
        </div>
      )}
      {sheet && (
        <div className="p5-inner cs-over">
          <section className="ds-modal r2-modal cs-inner" role="dialog" aria-modal="true" aria-label={sheet.title} data-testid="deposit-confirm">
            {sDone ? (
              <div className="r2-body cx-sent" role="status">
                <div className="r2-ok"><Check /></div>
                <div className="r2-g cx-senth">{sheet.doneTitle}</div>
                {sheet.doneSub && <span className="cx-p14">{sheet.doneSub}</span>}
                <button type="button" className="r2-btn r2-white cx-wide" onClick={() => setSheet(null)} data-autofocus>{T.ok}</button>
              </div>
            ) : (
              <>
                {!sBusy && <CashHead title={sheet.title} onClose={() => setSheet(null)} />}
                <div className="r2-body">
                  <div className="r2-box">
                    {sheet.lines.map((l, i) => (
                      <div className="r2-r" key={i}><div className="t"><b>{l.label}</b>{l.sub && <span>{l.sub}</span>}</div><span className="r2-g cx-v26">{l.usd}</span></div>
                    ))}
                  </div>
                  {sheet.note && <span className="cx-fine left">{sheet.note}</span>}
                  {sErr && <div className="r2-note err" role="alert"><ErrIcon /><span>{sErr}</span></div>}
                  <button type="button" className="r2-gold" disabled={sBusy} onClick={confirmDeposit} data-testid="deposit-confirm-btn">
                    {sBusy ? <><span className="r2-spin" aria-hidden />{sheet.busyLabel}</> : sheet.label}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </Sheet>
  );
}

type CoinProps = { coin: CreatorRocket; me: Address | null; demo: boolean; icon?: string; onBack: () => void; onClose: () => void };
const coinTitle = (coin: CreatorRocket, icon?: string) => <span className="cp-ct"><PairArt src={icon} tk={coin.ticker} size="list" px={32} />{coin.name || `$${coin.ticker}`}</span>;
const coinRow = (coin: CreatorRocket, icon?: string) => <div className="cp-who cp-coinrow"><PairArt src={icon} tk={coin.ticker} size="list" px={40} /><span className="t"><b>{coin.name || `$${coin.ticker}`}</b><span>${coin.ticker}</span></span></div>;

function CoinView({ coin, me, demo, icon, ready, onClaim, onPayTo, onTransfer, onSaved, onBack, onClose }: CoinProps & { ready: number; onClaim: () => void; onPayTo: () => void; onTransfer: () => void; onSaved: () => void }) {
  const [meta, setMeta] = useState<CoinMeta | null>(null);
  const [draft, setDraft] = useState<CoinMeta | null>(null);
  const [pay, setPay] = useState<PayTo | null>(null);
  const [payName, setPayName] = useState<string>("");
  const [busy, setBusy] = useState<"img" | "save" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let alive = true;
    if (demo) { const m = { imageURI: icon ?? "", description: "", links: {} }; setMeta(m); setDraft(m); setPay(coin.routed || coin.anon ? { supported: false } : { supported: true, to: (me ?? "0x0") as Address, self: true }); return; }
    void readCoinMeta(pc(), coin.token).then((m) => { if (alive) { setMeta(m); setDraft(m); } }).catch((e) => console.warn("[disciple] rewards: coin info read failed", (e as Error)?.message ?? e));
    if (me) void readPayTo(pc(), me, coin).then(async (p) => {
      if (!alive) return; setPay(p);
      if (p.supported && !p.self) { const { lookup } = await import("@/lib/send/recipient"); const l = await lookup(p.to, { me, allowAddress: true }); if (alive && l.state === "found") setPayName(l.r.username ? `@${l.r.username}` : ""); }
    });
    return () => { alive = false; };
  }, [coin, me, demo]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!meta && !!draft && JSON.stringify(meta) !== JSON.stringify(draft);
  // drag-to-crop step for a non-square image before it uploads (maker 2026-11-20)
  const [crop, setCrop] = useState<{ img: HTMLImageElement; pos: { x: number; y: number } } | null>(null);
  const applyImage = async (im: HTMLImageElement, pos: { x: number; y: number }) => {
    setBusy("img"); setErr(null);
    try { const uri = demo ? cropSquare(im, pos) : await uploadCoinImage(im, pos); setDraft((d) => (d ? { ...d, imageURI: uri } : d)); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(null); URL.revokeObjectURL(im.src); }
  };
  const pickImage = async (f: File | undefined) => {
    if (!f) return;
    setErr(null);
    let im: HTMLImageElement;
    try { im = await loadImage(f); } catch (e) { setErr((e as Error).message); return; }
    if (im.naturalWidth !== im.naturalHeight) setCrop({ img: im, pos: { x: 0.5, y: 0.5 } });
    else void applyImage(im, { x: 0.5, y: 0.5 });
  };
  const save = async () => {
    if (!draft || !me && !demo) return;
    setBusy("save"); setErr(null);
    try {
      if (!demo) { const tx = await saveCoinMeta(pc(), me!, coin, draft); console.warn("[disciple] rewards: coin info saved", { token: coin.token, tx }); }
      setMeta(draft); setSaved(true); window.setTimeout(() => setSaved(false), 1600); onSaved();
    } catch (e) { setErr(claimErrorText(e)); } finally { setBusy(null); }
  };
  const img = draft?.imageURI && draft.imageURI !== meta?.imageURI ? draft.imageURI : icon;
  const link = (k: keyof CoinMeta["links"], v: string) => setDraft((d) => (d ? { ...d, links: { ...d.links, [k]: v } } : d));
  return <>
    <Head title={coinTitle(coin, icon)} onBack={onBack} onClose={onClose}
      right={<a className="p5-btn sm" href={`/coin/${coin.token}`}><span className="p5-desk">{T.coinPage}</span><Icon name="external-link" size={14} /></a>} />
    {!coin.routed && (
      <div className="p5-rw-claim cp-mini">
        <div className="tx"><span className="k">{T.ready}</span><b className="cp-v">{usd2(ready)}</b></div>
        <button type="button" className="p5-rw-go" disabled={ready < 0.005} onClick={onClaim} data-testid="coin-claim">{T.claim}</button>
      </div>
    )}
    {pay?.supported && (
      <button type="button" className="cp-payto" onClick={onPayTo} data-testid="cp-payto">
        <span className="k">{T.payTo}</span>
        <span className="who">{pay.self ? <Icon name="wallet" size={16} /> : <Icon name="profile" size={16} />}<b>{pay.self ? T.yourWallet : payName || shortA(pay.to)}</b><em>{shortA(pay.self ? me ?? "" : pay.to)}</em></span>
        <span className="go">{T.change}<Icon name="chevron-right" size={16} /></span>
      </button>
    )}
    <section className="cp-sec" aria-label={T.coinInfo}>
      <h3 className="cp-h">{T.coinInfo}</h3>
      <div className="cp-img">
        <PairArt src={img} tk={coin.ticker} size="list" px={64} />
        <button type="button" className="p5-btn sm" disabled={!!busy} onClick={() => file.current?.click()} data-testid="coin-image"><Icon name="refresh" size={14} /> {busy === "img" ? T.saving : T.changeImage}</button>
        <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { void pickImage(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
      {crop && (
        <div className="cp-crop" data-testid="coin-crop">
          <SquareCrop img={crop.img} pos={crop.pos} onChange={(pos) => setCrop((c) => (c ? { ...c, pos } : c))} size={200} />
          <div className="cp-crop-act">
            <button type="button" className="p5-btn sm" onClick={() => { URL.revokeObjectURL(crop.img.src); setCrop(null); }}>{T.cropCancel}</button>
            <button type="button" className="p5-btn sm primary" onClick={() => { const c = crop; setCrop(null); void applyImage(c.img, c.pos); }} data-testid="coin-crop-use">{T.cropUse}</button>
          </div>
        </div>
      )}
      <div className="cp-two">
        <div className="p5-fld"><span className="lab">{T.name}</span><span className="p5-inp cp-locked">{coin.name}<Icon name="lock" size={14} /></span></div>
        <div className="p5-fld"><span className="lab">{T.ticker}</span><span className="p5-inp cp-locked">${coin.ticker}<Icon name="lock" size={14} /></span></div>
      </div>
      <label className="p5-fld"><span className="lab">{T.description}</span>
        <textarea className="p5-inp ta" rows={3} maxLength={280} value={draft?.description ?? ""} disabled={!draft || !!busy} onChange={(e) => setDraft((d) => (d ? { ...d, description: e.target.value } : d))} data-testid="coin-desc" />
      </label>
      <div className="p5-fld" role="group" aria-label={T.links}><span className="lab">{T.links}</span>
        <div className="cp-links">
          <span className="p5-inp cp-li"><b>X</b><input value={draft?.links.twitter ?? ""} placeholder="x.com/…" maxLength={120} disabled={!draft || !!busy} onChange={(e) => link("twitter", e.target.value)} /></span>
          <span className="p5-inp cp-li"><b>TG</b><input value={draft?.links.telegram ?? ""} placeholder="t.me/…" maxLength={120} disabled={!draft || !!busy} onChange={(e) => link("telegram", e.target.value)} /></span>
          <span className="p5-inp cp-li"><b>Web</b><input value={draft?.links.website ?? ""} placeholder="https://" maxLength={120} disabled={!draft || !!busy} onChange={(e) => link("website", e.target.value)} /></span>
        </div>
      </div>
      {err && <div className="r2-note err" role="alert"><ErrIcon /><span>{err}</span></div>}
      <button type="button" className="p5-btn primary wide" disabled={!dirty || !!busy} onClick={save} data-testid="coin-save">{busy === "save" ? T.saving : saved ? T.saved : T.saveInfo}</button>
    </section>
    <section className="cp-sec">
      <h3 className="cp-h">{T.creator}</h3>
      <button type="button" className="cp-row" onClick={onTransfer} data-testid="coin-transfer"><Icon name="key" size={16} /><b>{T.transfer}</b><Icon name="chevron-right" size={18} /></button>
    </section>
  </>;
}

function PayToView({ coin, me, demo, icon, onBack, onClose }: CoinProps) {
  const [self, setSelf] = useState(true);
  const [to, setTo] = useState<Recipient | null>(null);
  const [cur, setCur] = useState<PayTo | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!me || demo) return;
    void readPayTo(pc(), me, coin).then(async (p) => {
      setCur(p);
      if (p.supported && !p.self) {
        setSelf(false);
        const { lookup } = await import("@/lib/send/recipient");
        const l = await lookup(p.to, { me, allowAddress: true });
        if (l.state === "found") setTo(l.r);
      }
    });
  }, [coin, me, demo]);
  const changed = cur?.supported ? (self ? !cur.self : !!to && lc(to.address) !== lc(cur.to)) : self ? false : !!to;
  const save = async () => {
    if (!me && !demo) return;
    setBusy(true); setErr(null);
    try {
      if (!demo) { const tx = await setPayTo(me!, coin, self ? null : (to!.address as Address), pc()); console.warn("[disciple] rewards: pays to set", { token: coin.token, tx }); }
      onBack();
    } catch (e) { setErr(claimErrorText(e)); } finally { setBusy(false); }
  };
  return <>
    <Head title={T.payTo} onBack={onBack} onClose={onClose} />
    {coinRow(coin, icon)}
    <div className="cp-opts" role="radiogroup" aria-label={T.payTo}>
      <button type="button" role="radio" aria-checked={self} className={`cp-opt${self ? " on" : ""}`} onClick={() => setSelf(true)}>
        <span className="dot" /><span className="t"><b>{T.yourWallet}</b><span className="mono">{me ? shortA(me) : ""}</span></span>
      </button>
      <button type="button" role="radio" aria-checked={!self} className={`cp-opt${!self ? " on" : ""}`} onClick={() => setSelf(false)} data-testid="payto-else">
        <span className="dot" /><span className="t"><b>{T.someoneElse}</b></span>
      </button>
    </div>
    {!self && (to ? <RecipientCard r={to} onClear={() => setTo(null)} /> : <UserPicker value={to} onChange={setTo} me={me} allowAddress label={T.payToLabel} id="payto-to" />)}
    {!self && <div className="cp-warn" role="note"><Icon name="warning" size={16} /><span>{T.payToWarn(coin.ticker)}</span></div>}
    {err && <div className="r2-note err" role="alert"><ErrIcon /><span>{err}</span></div>}
    <button type="button" className="p5-btn primary wide p5-gold" disabled={!changed || busy || (!self && !to)} onClick={save} data-testid="payto-save">{busy ? T.saving : T.save}</button>
  </>;
}

function TransferView({ coin, me, demo, icon, ready, onBack, onClose, onDone }: CoinProps & { ready: number; onDone: () => void }) {
  const [to, setTo] = useState<Recipient | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const who = to ? (to.username ? `@${to.username}` : shortA(to.address)) : "";
  const go = async () => {
    if (!to || (!me && !demo)) return;
    setBusy(true); setErr(null);
    try {
      if (!demo) { const tx = await transferCreatorTo(pc(), me!, coin, to.address as Address); console.warn("[disciple] rewards: creator transferred", { token: coin.token, tx }); }
      setDone(true); window.setTimeout(onDone, 1200);
    } catch (e) { setErr(claimErrorText(e)); } finally { setBusy(false); }
  };
  return <>
    <Head title={T.transfer} onBack={onBack} onClose={onClose} />
    {coinRow(coin, icon)}
    {to ? <RecipientCard r={to} onClear={done ? undefined : () => setTo(null)} /> : <UserPicker value={to} onChange={setTo} me={me} allowAddress label={T.newCreator} id="transfer-to" />}
    {to && <div className="cp-warn bad" role="note"><Icon name="warning" size={16} /><span>{T.transferWarn(who)}</span></div>}
    {to && ready > 0.005 && <span className="cx-fine left cp-fee">{T.transferNote(usd2(ready))}</span>}
    {err && <div className="r2-note err" role="alert"><ErrIcon /><span>{err}</span></div>}
    {done ? <div className="r2-note" role="status"><Check /><span>{T.transferred}</span></div>
      : <HoldButton label={T.hold} busyLabel={T.transferring} busy={busy} disabled={!to} onDone={() => void go()} testId="transfer-hold" />}
  </>;
}
