"use client";
/**
 * /creator = Host earnings (round 2 "Claims + Host earnings" board, maker 2026-11-13). You earn a cut of every boost and
 * dump on the rockets you launched; each rocket gets its own bay card. Dollars first; the coin it's paid in is a small
 * note. Ready to claim + Claim all, Earned all time, Already claimed; per rocket: Ready, Claim $x (or Share it to get a
 * crew), earned / claimed, Latest, and the verification row (Get verified popup).
 *   wallet launches  FeeRouter creatorAccrued + claimCreatorFees, creatorTokenAccrued + claimCreatorTokenFees
 *   private          the coin's AnonLauncher (v2, or v1 legacy) pending(token) + claimMany / claimManyBySig (stealth key)
 * Every claim is eth_call-simulated first so a revert shows plain copy before anything is signed. Claim logic unchanged.
 * Tier, crew and difficulty come from the lobby data (/api/home); Boost / Dump and names in Latest from /api/trades.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Hex } from "viem";
import { creatorClaimCalls, creatorDashboard, sendCreatorClaims, signedAnonClaimCalls, type CreatorRocket } from "@/lib/claims/creatorFees";
import { myStealthCoins, myStealthKeys } from "@/lib/privateLaunch";
import { claimErrorText, preflight, toUsd } from "@/lib/claims/common";
import { demoRockets, demoRedeploy } from "@/lib/claims/demo";
import { rocketsListView, walletPending, type WalletPhase } from "@/lib/claims/rocketsListView";
import { connectedAddress, connectPrivy, onWallet, restoreSmart } from "@/lib/wallet";
import { aaSession, onPrivy, privyAuthenticated, privyReady } from "@/lib/aa/session";
import { withBase } from "@/lib/base-path";
import { ROCKET_SRC, tierProgress, type HomeCoin, type HomeData } from "@/lib/home/trending";
import { difficultyOf } from "@/lib/difficulty";
import { lightOf } from "@/components/home/rocketBits";
import { lookupName } from "@/lib/nameLookup";
import { displayName } from "@/lib/defaultUsername";
import { usd2 } from "@/components/cash/bits";
import { ConfirmSheet, SampleTag, isCashAsset, pc, useCaps, type ConfirmLine } from "./ui";
import { clientGaslessMode } from "@/lib/aa/sponsorshipMode";
import { partitionRelayableCalls, blockedCallsMessage } from "@/lib/trade/gaslessAction";
import { formatActionFeeNote, quoteGaslessAction } from "@/lib/trade/gaslessActionClient";
import VerifyRequest from "./VerifyRequest";

export const HOST_COPY = {
  eyebrow: "Host earnings",
  title: "Host earnings",
  sub: "You earn a cut of every boost and dump on the rockets you launched. Each rocket gets its own bay card.",
  back: "Back to your Hangar",
  ready: "Ready to claim",
  claimAll: (v: string) => `Claim all ${v}`,
  claimAllShort: "Claim all",
  fromN: (n: number) => (n === 1 ? "From 1 rocket." : `From ${n} rockets, in one go.`),
  earned: "Earned all time", earnedShort: "All time",
  claimed: "Already claimed", claimedShort: "Claimed",
  readyRow: "Ready",
  paidCash: "Paid in cash",
  paidIn: (coin: string, share: boolean) => `Paid in ${coin}${share ? ", plus a rocket share" : ""}`,
  paidShare: "Paid in cash, plus a rocket share",
  paidPrivate: "Claimed privately to this account",
  nothing: "Nothing new since your last claim",
  claim: (v: string) => `Claim ${v}`,
  claimShort: "Claim",
  share: "Share it to get a crew",
  shared: "Link copied",
  earnedCard: "Earned all time", claimedCard: "Claimed",
  latest: "Latest",
  noBoosts: "No boosts yet. Earnings show up with the first one.",
  privateFeed: "Private rocket. Earnings are claimed privately to this account.",
  boost: (who: string) => `Boost by ${who}`,
  dump: (who: string) => `Dump by ${who}`,
  from: (who: string) => `From ${who}`,
  legacy: "Part of this rocket's share sits on the older private launcher and can't be claimed.",
  sheetAll: "Claim host earnings",
  sheetOne: (name: string) => `Claim ${name}`,
  signInTitle: "Sign in to see your host earnings",
  signIn: "Sign in",
  emptyTitle: "No rockets yet",
  emptyBody: "Launch one and you earn a cut of every boost and dump on it.",
  launch: "Launch a rocket",
  pad: "On the pad",
  tier: (n: number) => `Tier ${n}`,
  aboard: (n: number) => `${n} aboard`,
} as const;

type Pending = { rows: CreatorRocket[]; title: string } | null;
type Feed = { kind: "buy" | "sell" | null; who: string; usd: number; tx: string };

function useSettledWallet(): { me: ReturnType<typeof connectedAddress>; phase: WalletPhase } {
  const [me, setMe] = useState(() => connectedAddress());
  const [restored, setRestored] = useState(false);
  const [privy, setPrivy] = useState(() => privyReady());
  useEffect(() => onWallet(setMe), []);
  useEffect(() => onPrivy(() => setPrivy(true)), []);
  useEffect(() => { void restoreSmart().finally(() => setRestored(true)); }, []);
  const pending = walletPending(me, privy, privyAuthenticated() || !!aaSession(), restored);
  const phase: WalletPhase = me ? "in" : pending ? "unknown" : "none";
  return { me, phase };
}

const ZERO = BigInt(0);
const tokUsd = (r: CreatorRocket, on: boolean) => (on && r.tokenSide ? toUsd(r.tokenSide.claimable, r.tokenSide.asset) ?? 0 : 0);

/** Lobby facts for the bay cards (tier, crew, difficulty), from the home data. */
function useLobbyFacts(tokens: string[]) {
  const [m, setM] = useState<Map<string, HomeCoin>>(new Map());
  const key = tokens.join(",");
  useEffect(() => {
    if (!key) return;
    let alive = true;
    fetch(withBase("/api/home")).then((r) => (r.ok ? r.json() : null)).then((d: HomeData | null) => {
      if (alive && d) setM(new Map(d.coins.map((c) => [c.token.toLowerCase(), c])));
    }).catch(() => {});
    return () => { alive = false; };
  }, [key]);
  return m;
}

/** Latest earnings with Boost / Dump and the pilot's name (trade index, by tx). */
function useFeed(r: CreatorRocket) {
  const [feed, setFeed] = useState<Feed[] | null>(null);
  useEffect(() => {
    let alive = true;
    const rows = r.recent.slice(0, 3);
    if (!rows.length) { setFeed([]); return; }
    (async () => {
      const sides = new Map<string, "buy" | "sell">();
      try {
        const j = await fetch(withBase(`/api/trades?coin=${r.token}&limit=60&order=desc`)).then((x) => (x.ok ? x.json() : null)) as { fills?: { tx: string; side: "buy" | "sell" }[] } | null;
        for (const f of j?.fills ?? []) sides.set(f.tx.toLowerCase(), f.side);
      } catch { /* no index: "From …" */ }
      const out = await Promise.all(rows.map(async (a) => {
        const n = await lookupName(a.trader).catch(() => null);
        const asset = a.side === "token" && r.tokenSide ? r.tokenSide.asset : r.quote;
        return { kind: sides.get(a.tx.toLowerCase()) ?? null, who: displayName(n, a.trader), usd: toUsd(a.amount, asset) ?? 0, tx: a.tx };
      }));
      if (alive) setFeed(out);
    })();
    return () => { alive = false; };
  }, [r]);
  return feed;
}

function BayCard({ r, facts, tokenOn, onClaim, demo }: { r: CreatorRocket; facts?: HomeCoin; tokenOn: boolean; onClaim: () => void; demo: boolean }) {
  const feed = useFeed(r);
  const [copied, setCopied] = useState(false);
  const readyUsd = (toUsd(r.claimable, r.quote) ?? 0) + tokUsd(r, tokenOn);
  const earned = toUsd(r.lifetime, r.quote) ?? 0, claimed = toUsd(r.claimed, r.quote) ?? 0;
  const can = r.claimable > ZERO || (tokenOn && (r.tokenSide?.claimable ?? ZERO) > ZERO);
  const share = tokenOn && (r.tokenSide?.claimable ?? ZERO) > ZERO;
  const paid = r.anon ? HOST_COPY.paidPrivate : !can ? HOST_COPY.nothing : isCashAsset(r.quote) ? (share ? HOST_COPY.paidShare : HOST_COPY.paidCash) : HOST_COPY.paidIn(r.quote.symbol, share);
  const tier = facts ? tierProgress(facts.mcapUsd).index : null;
  const diff = facts ? difficultyOf(facts.mode, facts.graduated) : null;
  const rest = [tier == null ? null : tier === 0 ? HOST_COPY.pad : HOST_COPY.tier(tier), facts?.stats?.crew != null ? HOST_COPY.aboard(facts.stats.crew) : null].filter(Boolean).join(" · ");
  const shareLink = async () => {
    const url = `${window.location.origin}${withBase(`/coin/${r.token}`)}`;
    try {
      if (typeof navigator.share === "function") { await navigator.share({ title: r.name, url }); return; }
      await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500);
    } catch { /* closed */ }
  };
  return (
    <article className="he-rk" data-testid="creator-rocket">
      <div className={`he-bay${tier === 0 ? " pad" : ""}`}>
        <span className="he-bl" style={{ background: lightOf(r.token) }} aria-hidden />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={withBase(ROCKET_SRC)} alt={`${r.name} rocket`} loading="lazy" decoding="async" />
      </div>
      <div className="he-rkbody">
        <div className="he-rkhead">
          <div className="he-rkname">
            <Link href={`/coin/${r.token}`} className="r2-g">{r.name}</Link>
            <span><span className="he-tk">${r.ticker}{rest ? " · " : ""}</span>{rest}</span>
          </div>
          {diff && <span className={`he-tag ${diff.key}`}>{diff.label}</span>}
        </div>
        <div className="r2-box he-ready">
          <div className="r2-r"><div className="t"><b>{HOST_COPY.readyRow}</b><span>{paid}</span></div><span className={`r2-g he-readyv${can ? "" : " zero"}`}>{usd2(readyUsd)}</span></div>
        </div>
        <div className="he-pclaim">
          <span className="r2-g">{usd2(readyUsd)}</span>
          {can ? <button type="button" className="r2-gold" onClick={onClaim}>{HOST_COPY.claimShort}</button>
            : <button type="button" className="r2-btn" onClick={shareLink}>{copied ? HOST_COPY.shared : HOST_COPY.share}</button>}
        </div>
        <div className="he-dclaim">
          {can ? <button type="button" className="r2-gold he-claimbtn" onClick={onClaim} data-testid="claim-one">{HOST_COPY.claim(usd2(readyUsd))}</button>
            : <button type="button" className="r2-btn he-sharebtn" onClick={shareLink}>{copied ? HOST_COPY.shared : HOST_COPY.share}</button>}
        </div>
        <div className="he-ec"><span>{HOST_COPY.earnedCard} <b>{usd2(earned)}</b></span><span>{HOST_COPY.claimedCard} <b>{usd2(claimed)}</b></span></div>
        {r.anon && r.tokenUnclaimable && <span className="he-fine">{HOST_COPY.legacy}</span>}
        <div className="he-latest">
          <span className="r2-lbl">{HOST_COPY.latest}</span>
          {feed && feed.length ? feed.map((f) => (
            <div key={f.tx + f.who} className="he-feed"><span>{f.kind === "buy" ? HOST_COPY.boost(f.who) : f.kind === "sell" ? HOST_COPY.dump(f.who) : HOST_COPY.from(f.who)}</span><b>+{usd2(f.usd)}</b></div>
          )) : feed ? <p className="he-none">{r.anon ? HOST_COPY.privateFeed : HOST_COPY.noBoosts}</p> : null}
        </div>
        <VerifyRequest token={r.token} name={r.name} demo={demo} />
      </div>
    </article>
  );
}

export default function CreatorDashboard() {
  const { me, phase } = useSettledWallet();
  const { caps, demo } = useCaps();
  const [rows, setRows] = useState<CreatorRocket[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [sheetErr, setSheetErr] = useState<string | null>(null);
  const [feeNote, setFeeNote] = useState<string | null>(null);
  const [done, setDone] = useState<Hex | null>(null);

  const load = useCallback(async () => {
    if (demo) { setRows(demoRockets(demoRedeploy())); return; }
    if (!me) return;
    setErr(null);
    // private launches: coins announced to this account's stealth keys (one silent owner signature; none on the EOA path)
    const stealth = caps.anonClaims ? await myStealthKeys().then((k) => myStealthCoins(pc(), k)).catch(() => []) : [];
    try { setRows(await creatorDashboard(pc(), me, caps, 6, stealth)); } catch (e) { setErr(claimErrorText(e)); setRows([]); }
  }, [me, demo, caps]);
  useEffect(() => { void load(); }, [load]);
  const facts = useLobbyFacts((rows ?? []).map((r) => r.token.toLowerCase()));

  const tokenOn = (r: CreatorRocket) => !!(r.anon || caps.creatorTokenFees);
  const totals = useMemo(() => {
    const t = { claimable: 0, lifetime: 0, claimed: 0, open: 0 };
    for (const r of rows ?? []) {
      t.claimable += (toUsd(r.claimable, r.quote) ?? 0) + tokUsd(r, tokenOn(r)); t.lifetime += toUsd(r.lifetime, r.quote) ?? 0; t.claimed += toUsd(r.claimed, r.quote) ?? 0;
      if (r.claimable > ZERO || (tokenOn(r) && (r.tokenSide?.claimable ?? ZERO) > ZERO)) t.open++;
    }
    return t;
  }, [rows, caps]); // eslint-disable-line react-hooks/exhaustive-deps

  const linesOf = (rs: CreatorRocket[]): ConfirmLine[] => rs.flatMap((r) => [
    ...(r.claimable > ZERO ? [{ label: r.name || `$${r.ticker}`, sub: isCashAsset(r.quote) ? null : `Paid in ${r.quote.symbol}`, raw: r.claimable, asset: r.quote }] : []),
    ...(tokenOn(r) && r.tokenSide && r.tokenSide.claimable > ZERO ? [{ label: `${r.name || `$${r.ticker}`} rocket share`, sub: `Paid in $${r.ticker}`, raw: r.tokenSide.claimable, asset: r.tokenSide.asset }] : []),
  ]);
  const open = (rs: CreatorRocket[], title: string) => {
    setSheetErr(null); setDone(null); setFeeNote(null); setPending({ rows: rs, title });
    if (clientGaslessMode() && me) {
      void (async () => {
        try {
          const calls = [...creatorClaimCalls(rs, caps, me), ...(await signedAnonClaimCalls(pc(), rs, me))];
          const { relayable, blocked } = partitionRelayableCalls("anonClaim", calls.map((c) => ({ to: c.to, data: c.data })));
          if (!relayable.length) { setFeeNote(blockedCallsMessage(blocked.length ? blocked : calls.map((c) => ({ to: c.to, data: c.data })))); return; }
          const q = await quoteGaslessAction({ kind: "anonClaim", signer: me, callCount: relayable.length });
          setFeeNote(blocked.length ? blockedCallsMessage(blocked) : formatActionFeeNote(q));
        } catch (e) { setFeeNote((e as Error).message ?? "fee quote failed"); }
      })();
    }
  };
  const confirm = async () => {
    if (!pending) return;
    setBusy(true); setSheetErr(null);
    try {
      if (demo) { await new Promise((r) => setTimeout(r, 600)); setDone(`0x${"ab".repeat(32)}` as Hex); return; }
      const calls = creatorClaimCalls(pending.rows, caps, me ?? undefined);
      if (me) calls.push(...(await signedAnonClaimCalls(pc(), pending.rows, me)));
      if (me) await preflight(pc(), calls, me);
      const r = await sendCreatorClaims(calls);
      setDone(r.txHash);
      void load();
    } catch (e) { setSheetErr(claimErrorText(e)); } finally { setBusy(false); }
  };
  const canClaim = (r: CreatorRocket) => r.claimable > ZERO || (tokenOn(r) && (r.tokenSide?.claimable ?? ZERO) > ZERO);
  const claimable = (rows ?? []).filter(canClaim);
  const view = rocketsListView(phase, rows, demo);

  return (
    <div className="he-page" data-testid="creator-dashboard" data-list={view}>
      <header className="he-head">
        <div>
          <h1 className="r2-g">{HOST_COPY.title}</h1>
          <p>{HOST_COPY.sub}</p>
          <SampleTag show={demo} />
        </div>
        <Link href="/profile" className="he-back">{HOST_COPY.back}</Link>
      </header>

      {view === "signin" ? (
        <section className="he-card he-empty" data-testid="rockets-signin">
          <b className="r2-g">{HOST_COPY.signInTitle}</b>
          <button type="button" className="r2-gold he-auto" onClick={() => connectPrivy()}>{HOST_COPY.signIn}</button>
        </section>
      ) : view === "loading" ? (
        <section className="he-card he-empty" data-testid="rockets-loading" aria-busy="true"><div className="he-skel" /><div className="he-skel short" /></section>
      ) : view === "empty" ? (
        <section className="he-card he-empty" data-testid="rockets-empty">
          <b className="r2-g">{HOST_COPY.emptyTitle}</b>
          <span>{HOST_COPY.emptyBody}</span>
          <Link className="r2-gold he-auto" href="/create">{HOST_COPY.launch}</Link>
          {err && <div className="r2-note err" role="alert"><span>{err}</span></div>}
        </section>
      ) : (
        <>
          <section className="he-stats">
            <div className="he-stat hero">
              <span className="r2-lbl gold">{HOST_COPY.ready}</span>
              <div className="he-herorow">
                <b>{usd2(totals.claimable)}</b>
                <button type="button" className="r2-gold he-auto" disabled={!claimable.length} onClick={() => open(claimable, HOST_COPY.sheetAll)} data-testid="claim-all">
                  <span className="tp-d">{HOST_COPY.claimAll(usd2(totals.claimable))}</span><span className="tp-p">{HOST_COPY.claimAllShort}</span>
                </button>
              </div>
              {totals.open > 0 && <span className="he-herosub">{HOST_COPY.fromN(totals.open)}</span>}
            </div>
            <div className="he-stat"><span className="r2-lbl"><span className="tp-d">{HOST_COPY.earned}</span><span className="tp-p">{HOST_COPY.earnedShort}</span></span><b>{usd2(totals.lifetime)}</b></div>
            <div className="he-stat"><span className="r2-lbl"><span className="tp-d">{HOST_COPY.claimed}</span><span className="tp-p">{HOST_COPY.claimedShort}</span></span><b>{usd2(totals.claimed)}</b></div>
          </section>
          <div className="he-grid">
            {(rows ?? []).map((r) => (
              <BayCard key={r.token} r={r} facts={facts.get(r.token.toLowerCase())} tokenOn={tokenOn(r)} demo={demo} onClaim={() => open([r], HOST_COPY.sheetOne(r.name || `$${r.ticker}`))} />
            ))}
          </div>
        </>
      )}

      {pending && (
        <ConfirmSheet title={pending.title} lines={linesOf(pending.rows)} feeNote={feeNote} busy={busy} error={sheetErr} done={done} onConfirm={confirm} onClose={() => setPending(null)} />
      )}
    </div>
  );
}
