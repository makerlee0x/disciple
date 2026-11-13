"use client";

import { useEffect, useRef, useState } from "react";
import { fmtUsd, HOLD_BONUS } from "@/lib/config";
import { applyExactFill, applyFill, bookPending, emptyPosition, pnlKey, positionFromFills, type ChainFill, type ChainTransfer, reconcileFill, shrinkToWallet, view, walletView, type ExactFill, type PendingFill, type Position, type PositionView, type WalletView, fmtMoney, fmtPct, fmtPnl, fmtTokens, DEFAULT_SUPPLY, rebase, redFromBuyFees } from "@/lib/pnl";
import { useT } from "@/lib/game/i18n";
import { onWallet } from "@/lib/wallet";
import { isDeployed } from "@/lib/chains";
import { withBase } from "@/lib/base-path";
import { POINTS_ENABLED } from "@/lib/features";
import { useDomCard } from "@/lib/game/cardLayoutStore";
import { useHudMode } from "@/lib/game/hudMode";
import { HUD, hudLabel } from "@/lib/game/hudStyle";

/** protocol trade fee (contracts/src/libraries/Constants.sol TRADE_FEE_BPS = 100): the "Dump all now" estimate */
const TRADE_FEE = 0.01;

type Fill = { side: "buy" | "sell"; usd: number; mcap: number; supply: number; /** always 0 (no per-trade gas line in the ledger) */ gas?: number; at?: number; frac?: number; session?: string | null; live?: boolean; txHash?: string };
type Receipt = ExactFill & { txHash: string; side: "buy" | "sell" };
type Mark = { mcap: number; supply: number; session?: string | null };
/** LIVE wallet balance of this coin (TradeBridge 'disciple:holdings'; null detail = paper / sim ⇒ the ledger is the position) */
type Wallet = { tokens: number; settled: boolean };
type FlightWin = {
  __flight?: { S?: { confirmed?: { mcap?: number | null } }; source?: { supply?: number }; markMcap?: () => number };
  __entryMcap?: number;
  __pnl?: { fill(f: Fill): void; reset(): void };
};

const DEFAULT_KEY = "disciple.pnl.";
const usd = fmtPnl;
const pct = (v: number) => (v > 0 ? "▲ " : v < 0 ? "▼ " : "") + Math.abs(v).toFixed(1) + "%";
const GREEN = "#5FF0A0", RED = "#FF7FB3", FLAT = "#F2F3F7";
/** phone-first HUD active (components/flight/PhoneHud.tsx sets html.ap-phone at ≤760px) */
const isPhone = () => typeof document !== "undefined" && document.documentElement.classList.contains("ap-phone");
const col = (x: number) => (x > 0.005 ? GREEN : x < -0.005 ? RED : FLAT);

/** Smoothly tweened number: animates text in place via rAF (no React re-render per frame). */
function Num({ value, fmt, style }: { value: number; fmt: (v: number) => string; style?: React.CSSProperties }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  const fmtRef = useRef(fmt);
  fmtRef.current = fmt;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = shown.current, to = value;
    if (!Number.isFinite(from) || from === to || document.hidden) { shown.current = to; el.textContent = fmtRef.current(to); return; }
    const t0 = performance.now(), dur = 420;
    let raf = 0;
    const tick = (now: number) => {
      const u = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - u, 3);
      shown.current = from + (to - from) * e;
      el.textContent = fmtRef.current(shown.current);
      if (u < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span ref={ref} style={style}>{fmt(shown.current)}</span>;
}

/**
 * Holdings / PnL HUD — PnL is the game. PAPER ledger now; ProtocolClient.getPosition later.
 * Marks are pushed by the engine (`disciple:mark`, on change, ≤10/s); no polling. ONLY the signed-in account's own
 * ledger for this coin (lib/pnl pnlKey): no cross-coin / cross-account "Other rockets" total (lee, Oct 30), and a sign-out
 * or account switch swaps the ledger (the previous account's numbers never stay on screen).
 */
/** storagePrefix: the SIMULATOR passes its own namespace so sim positions never mix with real/paper profiles.
 *  syncEvent: the SIMULATOR's ledger is authoritative (tramp/wall fills and wall escrow move tokens without a swap),
 *  so it pushes the whole position on this event ({ pos, supply }) and paper fills are not re-booked here. */
export default function PnlHud({ coin, storagePrefix = DEFAULT_KEY, modeLabel, syncEvent }: { coin: string; storagePrefix?: string; modeLabel?: string; syncEvent?: string }) {
  const t = useT();
  const hud = useHudMode();
  // Pro rows: the coin's hold limit (disciple:coinrules from TradeBridge: capBps of supply, null = no cap) and live cash (disciple:cash)
  const [capBps, setCapBps] = useState<number | null>(null), [rules, setRules] = useState(""), [cash, setCash] = useState<number | null>(null);
  useEffect(() => {
    const r = (e: Event) => { const d = (e as CustomEvent<{ capBps?: number | null; modeName?: string } | null>).detail; setCapBps(d && typeof d.capBps === "number" ? d.capBps : null); setRules(d?.modeName ? String(d.modeName) : ""); };
    const c = (e: Event) => { const u = (e as CustomEvent<{ usd?: number | null }>).detail?.usd; setCash(typeof u === "number" && Number.isFinite(u) ? u : null); };
    addEventListener("disciple:coinrules", r); addEventListener("disciple:cash", c);
    return () => { removeEventListener("disciple:coinrules", r); removeEventListener("disciple:cash", c); };
  }, []);
  // the signed-in account (lib/wallet onWallet: the smart account, null when signed out). The SIMULATOR (syncEvent) keeps
  // its own run ledger, not per account.
  const [account, setAccount] = useState<string | null>(null);
  useEffect(() => (syncEvent ? undefined : onWallet((a) => setAccount(a ? a.toLowerCase() : null))), [syncEvent]);
  const KEY = pnlKey(storagePrefix, account, coin);
  const [pos, setPos] = useState<Position>(emptyPosition);
  const [mark, setMark] = useState<Mark>({ mcap: 0, supply: DEFAULT_SUPPLY });
  const [open, setOpenS] = useState(true);
  // phone HUD (components/flight/PhoneHud.tsx): the header asks for the POSITION sheet (id "run") instead of expanding in place
  const setOpen = (f: boolean | ((o: boolean) => boolean)) => (isPhone() && typeof f === "function" ? dispatchEvent(new CustomEvent("disciple:phonesheet-req", { detail: { req: "run" } })) : setOpenS(f));
  const posRef = useRef(pos);
  posRef.current = pos;
  // LIVE: the position is the WALLET (maker lee: "should be from actual wallet balance"); null ⇒ paper / sim ledger
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const walletRef = useRef(wallet);
  walletRef.current = wallet;
  // sign-out / account switch: drop the previous account's live wallet balance (YOUR POSITION never shows it for another account)
  useEffect(() => { walletRef.current = null; setWallet(null); }, [account]);

  // this account's ledger for this coin; another account / signed out ⇒ its own (often empty) ledger, never the last one's
  useEffect(() => {
    let next = emptyPosition();
    try { const s = localStorage.getItem(KEY); if (s) next = JSON.parse(s); } catch { /* ignore */ }
    posRef.current = next; setPos(next);
  }, [KEY]);
  useEffect(() => {
    // short desktop (lee, Oct 30: the open card covered the price chart): start collapsed; the chart sits under it either way
    if (window.matchMedia?.("(max-width: 760px)").matches || window.matchMedia?.("(max-height: 767px)").matches) setOpenS(false);
    // phone HUD: the full card only while the POSITION sheet is open, else the one-line strip
    const onSheet = (e: Event) => { if (isPhone()) setOpenS(((e as CustomEvent).detail || {}).id === "run"); };
    addEventListener("disciple:phonesheet", onSheet);
    return () => { removeEventListener("disciple:phonesheet", onSheet); };
  }, []);

  useEffect(() => {
    const w = window as unknown as FlightWin;
    const commit = (next: Position) => { posRef.current = next; setPos(next); try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ } };
    // Fix 3 — LIVE fills (txHash): book the optimistic estimate now, keep it pending, and replace it with the EXACT receipt
    // amounts (USDG in/out, tokens; lib/flight/fills via TradeBridge 'disciple:fillreceipt') when the receipt lands.
    // A receipt that beats its fill event waits in `early`. Paper / sim fills keep applyFill's curve-average booking.
    let pending: PendingFill[] = [];
    const early = new Map<string, Receipt>();
    const onFill = (f: Fill) => {
      const supply = f.supply || DEFAULT_SUPPLY, price = f.mcap / supply;
      let cur = rebase(posRef.current, supply);
      if (f.session !== undefined && cur.session !== undefined && cur.session !== f.session && cur.size > 0) cur = { ...emptyPosition(), realized: 0 };   // mock restarted: drop the stale bag
      const meta = { supply, session: f.session ?? null };
      if (f.live && f.txHash) {
        const at = f.at ?? Date.now(), rc = early.get(f.txHash);
        if (rc) { early.delete(f.txHash); return commit({ ...applyExactFill(cur, f.side, rc, 0, at), ...meta }); }
        pending = pending.filter((e) => at - e.est.at < 180_000);   // a receipt that never came: its estimate stays booked
        // live sell estimate: split tracked / untracked by the last wallet balance (the receipt's exact bag replaces it)
        const w = walletRef.current, bag = f.side === "sell" && w ? w.tokens : undefined;
        const r = bookPending(cur, pending, { id: f.txHash, side: f.side, est: { usd: f.usd, price, gas: 0, at, frac: f.frac, bag } });
        pending = r.pending;
        return commit({ ...r.pos, ...meta });
      }
      commit({ ...applyFill(cur, f.side, f.usd, price, 0, f.at, f.frac), ...meta });
    };
    const onReceipt = (e: Event) => { const d = (e as CustomEvent<Receipt>).detail; if (!d?.txHash || !(d.tokens > 0)) return;
      mine.add(d.txHash.toLowerCase()); clearTimeout(chainT); chainT = setTimeout(() => chainLoad(), 2500);
      const r = reconcileFill(pending, d.txHash, d);
      if (!r) { early.set(d.txHash, d); if (early.size > 20) early.delete(early.keys().next().value as string); return; }
      pending = r.pending;
      commit({ ...r.pos, supply: posRef.current.supply, session: posRef.current.session ?? null });
    };
    addEventListener("disciple:fillreceipt", onReceipt);
    // ON-CHAIN history (lee, Oct 30): avg entry / realized / uPnL rebuilt from this account's indexed trades in this coin
    // (curve buys + sells, then the v4 pool swaps after graduation; /api/trades, read-only) PLUS the coins that came or went
    // by transfer, priced at the coin's price at the transfer block (lib/chainTransfers, read-only logs + pinned reads) —
    // on load / account switch and after each own receipt. Applied only when nothing is in flight and every receipt seen
    // this session is indexed (else retried), so a lagging index never rolls back a fill the HUD already booked exactly.
    let alive = true, chainT: ReturnType<typeof setTimeout> | undefined, xferT: ReturnType<typeof setTimeout> | undefined;
    const mine = new Set<string>();
    let xfers: ChainTransfer[] | null = null, xferTries = 0;   // read once per account (own trades never add transfers)
    const coinTrades = () => fetch(withBase(`/api/trades?coin=${coin}&limit=5000`)).then((r) => (r.ok ? r.json() : null))
      .then((j: { fills?: { block?: number; logIndex?: number; priceUsd?: number }[] } | null) => (Array.isArray(j?.fills) ? j!.fills : []));
    const loadXfers = async (tradeTxs: Set<string>): Promise<ChainTransfer[] | null> => {
      if (xfers) return xfers;
      try { const { accountTransfers } = await import("@/lib/chainTransfers");
        xfers = await accountTransfers(coin as `0x${string}`, account as `0x${string}`, tradeTxs, coinTrades); return xfers; }
      catch { // logs unreadable right now: trades-only for now, retry the transfer scan (twice, 20 s apart)
        if (xferTries++ < 2) { clearTimeout(xferT); xferT = setTimeout(() => chainLoad(), 20_000); }
        return null; }
    };
    const chainLoad = (tries = 0) => {
      if (syncEvent || !account || !isDeployed()) return;
      clearTimeout(chainT);
      fetch(withBase(`/api/trades?coin=${coin}&wallet=${account}&limit=5000`)).then((r) => (r.ok ? r.json() : null)).catch(() => null)
        .then((j: { fills?: (ChainFill & { tx?: string })[] } | null) => {
          if (!alive || !j || !Array.isArray(j.fills)) return;
          const have = new Set(j.fills.map((f) => String(f.tx || "").toLowerCase()));
          if (pending.length || [...mine].some((h) => !have.has(h))) { if (tries < 5) chainT = setTimeout(() => chainLoad(tries + 1), 3000); return; }
          const fills = j.fills;
          return loadXfers(have).then((xs) => {
            if (!alive || pending.length) return;
            const supply = posRef.current.supply || DEFAULT_SUPPLY;
            commit(rebase(positionFromFills(fills, DEFAULT_SUPPLY, xs ?? []), supply));
          });
        });
    };
    chainLoad();
    // LIVE wallet balance (same read DUMP sizes from). Settled + nothing pending + wallet below the ledger ⇒ tokens left the
    // wallet outside the game: shrink the ledger pro-rata (lib/pnl shrinkToWallet), never grow it (untracked stays untracked).
    const onHoldings = (e: Event) => { const d = (e as CustomEvent<{ tokens?: number; settled?: boolean } | null>).detail;
      if (!d || typeof d.tokens !== "number" || !(d.tokens >= 0)) { walletRef.current = null; setWallet(null); return; }
      const next = { tokens: d.tokens, settled: !!d.settled }; walletRef.current = next; setWallet(next);
      if (next.settled && pending.length === 0) { const p = posRef.current, s = shrinkToWallet(p, next.tokens); if (s !== p) commit(s); } };
    addEventListener("disciple:holdings", onHoldings);
    const h = (e: Event) => { if (!syncEvent) onFill((e as CustomEvent<Fill>).detail); };
    const onSync = (e: Event) => { const d = (e as CustomEvent<{ pos: Position; supply: number }>).detail; if (!d?.pos) return;
      const next = { ...d.pos, supply: d.supply || DEFAULT_SUPPLY, session: null }; posRef.current = next; setPos(next);
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ } };
    if (syncEvent) addEventListener(syncEvent, onSync);
    const onMark = (e: Event) => { const d = (e as CustomEvent<Mark>).detail; if (!(d && d.mcap > 0)) return;
      const supply = d.supply || DEFAULT_SUPPLY; setMark({ mcap: d.mcap, supply, session: d.session });
      const p = posRef.current;
      // ephemeral mock market restarted since this bag was booked → drop it (its entry belongs to another price history)
      if (p.size > 0 && d.session && p.session !== d.session) { const n = emptyPosition(); posRef.current = n; setPos(n); try { localStorage.removeItem(KEY); } catch { /* */ } return; }
      if (p.size > 0 && (p.supply || supply) !== supply) { const n = rebase(p, supply); posRef.current = n; setPos(n); } };
    addEventListener("disciple:paperfill", h);
    addEventListener("disciple:mark", onMark);
    const m0 = w.__flight?.S?.confirmed?.mcap;
    const m0s = w.__flight?.markMcap?.() || m0;   // same shown price the HUD/rocket use (paper: × sim offset)
    if (m0s) setMark({ mcap: m0s, supply: w.__flight?.source?.supply || DEFAULT_SUPPLY });
    w.__pnl = { fill: onFill, reset: () => { posRef.current = emptyPosition(); setPos(posRef.current); localStorage.removeItem(KEY); } };
    return () => { alive = false; clearTimeout(chainT); clearTimeout(xferT); removeEventListener("disciple:holdings", onHoldings); removeEventListener("disciple:fillreceipt", onReceipt); removeEventListener("disciple:paperfill", h); removeEventListener("disciple:mark", onMark); if (syncEvent) removeEventListener(syncEvent, onSync); };
  }, [coin, KEY, syncEvent, account]);

  // the engine's desktop chart starts under this card (engine.js chartDeskRect ← window.__pnlBottom, px from the canvas
  // wrap's top). null on the phone / when hidden (the POSITION sheet and the CHART sheet are separate drawer tabs there).
  const asideRef = useRef<HTMLElement>(null);
  const card = useDomCard("pnl", asideRef);   // pass 3 #4: movable / minimizable / closable card
  const cardDy = card.dy, cardHidden = card.hidden;
  useEffect(() => {
    const el = asideRef.current, w = window as unknown as { __pnlBottom?: number | null };
    if (!el) return;
    const pub = () => { const r = el.getBoundingClientRect(), top = document.getElementById("wrap")?.getBoundingClientRect().top ?? 0;
      w.__pnlBottom = !isPhone() && !cardHidden && r.height > 0 ? Math.round(r.bottom - top - cardDy) : null; };   // the card's BASE spot (a dragged card doesn't drag the chart)
    pub();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(pub) : null; ro?.observe(el);
    addEventListener("resize", pub);
    return () => { ro?.disconnect(); removeEventListener("resize", pub); w.__pnlBottom = null; };
  }, [cardDy, cardHidden]);
  const price = mark.mcap / mark.supply;
  // LIVE: holdings = the wallet's real balance × mark; PnL only on the tracked (known-cost) part. Paper / sim: the ledger.
  const wv: WalletView | null = wallet ? walletView(pos, wallet.tokens, price, mark.supply) : null;
  const v: PositionView = wv ?? view(pos, price, mark.supply);
  const basis = wv ? wv.costBasis : pos.costBasis;
  const tracked = wv ? wv.tracked > 0 : v.size > 0;
  useEffect(() => {
    (window as unknown as FlightWin).__entryMcap = tracked ? v.entryMcap : undefined;
  }, [tracked, v.entryMcap]);
  // position for the ammo bar's % sell buttons (same ledger, same real mark)
  useEffect(() => {
    // live: size / valueUsd = the wallet (what DUMP sells); costBasis = the tracked part's basis
    dispatchEvent(new CustomEvent("disciple:position", { detail: { size: v.size, valueUsd: v.valueUsd, costBasis: basis } }));
  }, [v.size, v.valueUsd, basis]);
  // the engine's rocket position tag reads the SAME view() (P toggles it)
  useEffect(() => {
    const detail = v.size > 0 ? { size: v.size, valueUsd: v.valueUsd, entryMcap: v.entryMcap, uPnl: v.uPnl, pnlPct: v.pnlPct, realized: v.realized,
      txt: { pnl: fmtPnl(v.uPnl), pct: fmtPct(v.pnlPct), pos: fmtMoney(v.valueUsd), realized: fmtPnl(v.realized) } } : null;
    (window as unknown as { __pnlView?: unknown }).__pnlView = detail;   // late listeners (phone HUD PnL line) read the current view
    dispatchEvent(new CustomEvent("disciple:pnlview", { detail }));
  }, [v.size, v.valueUsd, v.entryMcap, v.uPnl, v.pnlPct, v.realized]);

  const holding = v.size > 0;
  // red only because of the buy fee inside the cost basis (price hasn't moved enough to cover it): say so, in dollars
  const feeNote = redFromBuyFees({ ...pos, costBasis: basis }, { size: tracked ? v.size : 0, uPnl: v.uPnl });
  const maxMult = 1 + HOLD_BONUS.maxBoost;
  const share = Math.max(0, Math.min(1, (v.bonus - 1) / HOLD_BONUS.maxBoost));
  const label = { color: HUD.dim, fontSize: 12 } as const;
  const row = { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 } as const;
  const line = { ...row, padding: "4px 0", borderTop: "1px solid rgba(46,50,58,.7)" } as const;
  const big = { font: `700 16px/1.2 ${HUD.game}` } as const;
  // YOUR BAG (approved mockup option A, Nov 12): what it is worth, what you put in, what you banked, what a full dump pays.
  // Pilot = that card. Pro (and the phone POSITION sheet) add the trader rows: tokens + share of supply, entry, hold limit, cash.
  const proRows = open && (hud === "pro" || isPhone());
  const putIn = tracked ? basis : 0;
  const gainShare = holding && v.valueUsd > 0 ? Math.max(0, Math.min(1, (v.valueUsd - putIn) / v.valueUsd)) : 0;
  const lossShare = holding && putIn > 0 ? Math.max(0, Math.min(1, (putIn - v.valueUsd) / putIn)) : 0;
  const dumpAll = holding ? v.valueUsd * (1 - TRADE_FEE) : 0;
  const supplyPct = holding && mark.supply > 0 ? (v.size / mark.supply) * 100 : 0;

  return (
    <aside ref={asideRef} aria-label="Holdings and PnL" className="pnl-hud" data-card="pnl" data-hud={hud}
      style={{ ...(card.hidden ? { display: "none" } : null), transform: card.transform, position: "fixed", ...(hud === "pro" ? { top: 212 } : { bottom: 16 }), left: "calc(var(--ap-rail-w, 64px) + 20px)", zIndex: 31, width: 300, padding: "14px 16px",
        borderRadius: HUD.radius, background: HUD.glass, backdropFilter: "blur(6px)",
        border: `1px solid ${HUD.border}`, color: HUD.text, font: `13px/1.4 ${HUD.ui}`, boxSizing: "border-box" }}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} style={{ all: "unset", cursor: "pointer", ...row, width: "100%" }}>
        <span data-testid="pnl-title" style={hudLabel}>{t("pnl.yourBag")} <span style={{ color: modeLabel ? "#8fd8ff" : wallet ? HUD.up : HUD.champagne }}>· {modeLabel || (wallet ? t("pnl.live") : t("pnl.paper"))}</span></span>
        <Num value={v.pnlPct} fmt={pct} style={{ font: `700 16px ${HUD.game}`, color: col(v.pnlPct) }} />
      </button>

      {/* hero: what the bag is worth now + unrealized PnL. % = uPnL ÷ cost basis = MCAP ÷ AVG ENTRY MC − 1 (fees in the basis): it
          depends on how far the mcap moved since YOUR entry, not on the share of supply held; see docs in lib/pnl.ts. */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, margin: "4px 0 8px" }} title={t("pnl.pctTitle")}>
        <Num value={v.valueUsd} fmt={fmtMoney} style={{ font: `800 38px/1 ${HUD.game}`, color: HUD.text }} />
        <Num value={v.uPnl} fmt={usd} style={{ font: `700 20px/1 ${HUD.game}`, color: col(v.uPnl) }} />
      </div>
      {holding ? <>
        <div aria-hidden="true" style={{ display: "flex", height: 8, borderRadius: 999, overflow: "hidden", background: "rgba(255,255,255,.1)" }}>
          <div style={{ flex: 1, background: lossShare > 0 ? "rgba(243,223,168,.35)" : "rgba(243,223,168,.55)" }} />
          {gainShare > 0 && <div style={{ width: `${gainShare * 100}%`, background: HUD.up }} />}
          {lossShare > 0 && <div style={{ width: `${lossShare * 100}%`, background: HUD.down }} />}
        </div>
        <div style={{ ...row, marginTop: 6, fontSize: 12, color: HUD.dim }}>
          <span>{t("pnl.putIn")} {tracked ? fmtMoney(putIn) : "—"}</span>
          <span>{t("pnl.banked")} <Num value={v.realized} fmt={usd} style={{ color: col(v.realized) }} /></span>
        </div>
        {feeNote > 0 && <div data-testid="pnl-buy-fees" style={{ fontSize: 11, color: HUD.dim, marginTop: 2 }}>{t("pnl.inclBuyFees", { fee: fmtMoney(feeNote) })}</div>}
        <div style={{ ...row, marginTop: 10, paddingTop: 8, borderTop: "1px solid rgba(46,50,58,.9)" }} title="about what selling it all pays back after the 1% fee (price move not included)">
          <span style={label}>{t("pnl.dumpAll")}</span>
          <span data-testid="pnl-dump-all" style={{ font: `700 18px ${HUD.game}` }}>≈ {fmtMoney(dumpAll)} <span style={{ font: `600 13px ${HUD.game}`, color: HUD.dim }}>{t("pnl.afterFees")}</span></span>
        </div>
      </> : <div style={{ fontSize: 12, color: HUD.dim }}>{v.realized !== 0 ? <>{t("pnl.banked")} <Num value={v.realized} fmt={usd} style={{ color: col(v.realized) }} /></> : t("pnl.noBag")}</div>}

      {proRows && (
        <div style={{ marginTop: 8 }}>
          {/* HOLDINGS = token amount + share of supply (live: the wallet's real balance = exactly what DUMP 100% sells) */}
          {holding && <><div style={line}><span style={label}>{t("pnl.holdings")}</span>
            <span data-testid="pnl-holdings" style={big}><span data-testid="pnl-holdings-tokens">{fmtTokens(v.size)}</span>{supplyPct > 0 && <span style={{ color: HUD.dim }}> · {supplyPct < 0.01 ? "<0.01" : supplyPct.toFixed(2)}%</span>}<span style={{ display: "none" }}><Num value={v.valueUsd} fmt={fmtMoney} /></span></span></div>
          <div style={line}><span style={label}>{t("pnl.boardedAt")}</span><span style={big}>{tracked ? `${fmtUsd(v.entryMcap)} altitude` : "—"}</span></div></>}
          {capBps != null && <div style={line} title="the most of the supply one wallet may hold right now (this rocket's difficulty)"><span style={label}>{t("pnl.holdLimit")}{rules ? ` (${rules === "TRENCH" ? "Expert" : rules.charAt(0) + rules.slice(1).toLowerCase()})` : ""}</span><span style={{ ...big, color: HUD.hard }}>{(capBps / 100).toFixed(2)}% of supply</span></div>}
          {cash != null && <div style={line}><span style={label}>{t("pnl.cash")}</span><span style={big}>{fmtMoney(cash)}</span></div>}
          {v.fees > 0 && <div style={line} title="exit fee (kept out of realized so realized = closed uPnL)"><span style={label}>{t("pnl.exitFees")}</span><span style={{ ...big, opacity: 0.75 }}>{usd(-v.fees)}</span></div>}

          {/* POINTS (off by default: lib/features POINTS_ENABLED, lee Oct 30) — off-chain points multiplier only (lib/config HOLD_BONUS, a proposal) — grows with
              unrealized PnL + hold time. Never money: it scales season points, not payouts or fees. */}
          {POINTS_ENABLED && <div title={`Off-chain points multiplier: grows with unrealized PnL and hold time, up to ×${maxMult.toFixed(2)}. Points only, never money.`} style={{ marginTop: 6 }}>
            <div style={{ ...row, color: v.bonus > 1 ? "#ffd98a" : "rgba(220,228,255,.6)", fontWeight: 700 }}>
              <span>{t("pnl.points")}</span><span>×{v.bonus.toFixed(2)} <span style={{ opacity: 0.55, fontWeight: 400 }}>/ ×{maxMult.toFixed(2)}</span></span>
            </div>
            <div style={{ height: 5, borderRadius: 3, background: "rgba(255,255,255,.08)", overflow: "hidden", marginTop: 3 }}>
              <div style={{ width: `${Math.max(3, share * 100)}%`, height: "100%", borderRadius: 3, transition: "width .5s ease-out",
                background: "linear-gradient(90deg,#ffd98a,#9ff3c8)", boxShadow: v.uPnl > 0 ? "0 0 8px rgba(255,217,138,.6)" : "none" }} />
            </div>
            <div style={{ fontSize: 10, marginTop: 3, color: v.uPnl > 0 ? "#ffe7a3" : "rgba(220,228,255,.5)" }}>
              {v.uPnl > 0 ? t("pnl.hintUp") : t("pnl.hintFlat")}
            </div>
          </div>}
        </div>
      )}
      <style jsx>{`
        @media (max-width: 760px) {
          .pnl-hud { left: 8px !important; top: auto !important; bottom: calc(60px + var(--ap-safe-bottom)); width: 210px !important; }
        }
      `}</style>
    </aside>
  );
}
