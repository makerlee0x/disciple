"use client";

import type React from "react";
import { useEffect, useRef, useState } from "react";
import { WALLET_CTA_CLICK_EVENT, WALLET_CTA_EVENT, walletCtaLabel } from "@/lib/walletCta";

/**
 * Phone trade bar v2 (html.ap-phone; approved board "Phone v2 · 1 Flying", maker 2026-11-13). Layout only: every action is
 * TradeBridge's own.
 *   BOOST side (wider): amount chips $10 · $25 · $50 · $100 over one big gold "BOOST $25" button.
 *   DUMP side: two chips (your % pick and ALL) over the pink "DUMP 25%" button, whose second line is what it's worth ("≈ $6.10")
 *   or "no bag yet".
 * Pick an amount, then fire: a chip only SETS the amount, it never trades. A boost chip that's over the wallet cap's room is
 * dashed (still tappable: the wallet-limit card then offers Boost max).
 * While the Holders · Chart sheet is open (html.ap-phone[data-ph-sheet] set) the chips fold away and the buttons get a bit
 * shorter, so BOOST and DUMP stay usable under the sheet (board "Phone v2 · 2").
 * Price-move warnings show as one line above the bar for the side being touched; nothing is ever blocked for price impact.
 */
export type PhoneTradeBarProps = {
  buyLabel: string; sellLabel: string;
  onBoost: () => void; onDump: () => void;
  /** the selected DUMP size sells the whole bag: on a phone it needs a short hold (HOLD_MS) so a stray tap can't empty it */
  dumpAll?: boolean;
  /** DUMP button's second line: "≈ $6.10" with a bag, "no bag yet" without */
  dumpSub?: string;
  boostDisabled: boolean; dumpDisabled: boolean; boostTitle: string; dumpTitle: string;
  /** rapid tap: 3 trades in flight — both buttons look greyed and read "3 IN FLIGHT" but stay tappable, so an extra tap
   *  reaches the engine's '3 IN FLIGHT' pulse instead of being swallowed by a disabled button */
  inFlightFull?: boolean;
  buyOpts: string[]; buySel: number; onPickBuy: (i: number) => void;
  /** per boost chip: over the wallet cap's room (dashed) */
  buyOver?: boolean[];
  sellOpts: string[]; sellFracs: number[]; sellSel: number; onPickSell: (i: number) => void;
  hint: string;
  /** per-option price-move tags (lib/flight/tradeGate chipTag); "" = none. Warning only. */
  buyWarn?: string[]; sellWarn?: string[];
  /** the active amount's warning line ("BOOST: Big move: price +38%"); shown under any blocking hint */
  warn?: string; warnOver?: boolean;
  /** the side the user is touching (button, chip) → TradeBridge shows only that side's warning */
  onSide?: (side: "buy" | "sell") => void;
  keyGuard: { onKeyDown: (e: React.KeyboardEvent) => void; onKeyUp: (e: React.KeyboardEvent) => void };
  /** the simulator plays without an account: never swap in SIGN IN TO PLAY there */
  noSignIn?: boolean;
};
/** chip money: $10 · $2.50 · $1.20K (whole dollars drop the cents) */
export const chipUsd = (v: number) => (!(v > 0) ? "$0" : v >= 1000 ? (v >= 1e6 ? `$${+(v / 1e6).toFixed(2)}M` : `$${+(v / 1e3).toFixed(2)}K`) : Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`);

/** DUMP ALL hold (maker, 2026-11-13): ~0.4s with a filling ring; 10% / 25% / half stay one tap. */
export const HOLD_MS = 400;

/** The DUMP side's two chips: [your % pick, ALL]. The % chip shows the selected partial preset (or the last one you used);
 *  tapping it again while it's selected steps to the next partial preset (10% → 25% → half → 10%). Pure, tested. */
export function dumpChips(fracs: number[], sel: number, lastPart: number) {
  const all = fracs.findIndex((f) => f >= 0.999), parts = fracs.map((_, i) => i).filter((i) => i !== all);
  const part = parts.includes(sel) ? sel : parts.includes(lastPart) ? lastPart : parts[0] ?? -1;
  const next = parts.length ? parts[(parts.indexOf(part) + 1) % parts.length] : -1;
  return { part, all, next };
}

export default function PhoneTradeBar(p: PhoneTradeBarProps) {
  // Fire on finger DOWN (same frame as the press), not on release. The click that follows is swallowed; a keyboard
  // click (detail 0) still trades. DUMP ALL: finger down starts the hold ring, lifting early cancels.
  const firedByPointer = useRef(false);
  const holdT = useRef<number | null>(null);
  const [holding, setHolding] = useState(false);
  const [holdHint, setHoldHint] = useState(false);
  const lastPart = useRef(-1);
  // signed out (maker 2026-11-13, "Sign in on the trade bar"): the bar is ONE gold SIGN IN TO PLAY button (the wallet's own
  // login, lib/walletCta); the amount chips and DUMP come back once you're in
  const [cta, setCta] = useState<string | null>(null);
  useEffect(() => { setCta(walletCtaLabel()); const c = (e: Event) => setCta((e as CustomEvent<{ label: string | null }>).detail?.label ?? null);
    addEventListener(WALLET_CTA_EVENT, c); return () => removeEventListener(WALLET_CTA_EVENT, c); }, []);
  const endHold = () => { if (holdT.current != null) { clearTimeout(holdT.current); holdT.current = null; } setHolding(false); };
  useEffect(() => () => endHold(), []);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!holdHint) return; const t = setTimeout(() => setHoldHint(false), 1600); return () => clearTimeout(t); }, [holdHint]);
  const press = (side: "buy" | "sell", e: React.PointerEvent<HTMLButtonElement>) => {
    const b = side === "buy";
    if (e.button !== 0 || (b ? p.boostDisabled : p.dumpDisabled)) return;
    firedByPointer.current = true;
    if (!b && p.dumpAll) {
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* old WebView */ }
      setHolding(true); setHoldHint(false);
      holdT.current = window.setTimeout(() => {
        holdT.current = null; setHolding(false); p.onDump();
        dispatchEvent(new CustomEvent("disciple:haptic", { detail: { k: "dump" } }));
      }, HOLD_MS);
      return;
    }
    (b ? p.onBoost : p.onDump)();
  };
  const release = () => { if (holdT.current != null) { endHold(); setHoldHint(true); } };
  const dc = dumpChips(p.sellFracs, p.sellSel, lastPart.current);
  if (dc.part >= 0) lastPart.current = dc.part;
  const full = !!p.inFlightFull;
  const fire = (side: "buy" | "sell") => {
    const b = side === "buy", dis = b ? p.boostDisabled : p.dumpDisabled, greyed = dis || (full && !dis);
    return (
      <button type="button" className={`ph-fire ${b ? "ph-boost" : "ph-dump"}`} data-testid={b ? "buy-btn" : "sell-btn"} aria-label={b ? `boost ${p.buyLabel}` : `dump ${p.sellLabel}`}
        title={b ? p.boostTitle : p.dumpTitle} aria-disabled={greyed} disabled={dis} data-disabled={greyed ? "1" : "0"} {...p.keyGuard}
        data-haptic={!b && p.dumpAll ? "hold" : b ? "boost" : "dump"} data-holding={!b && holding ? "1" : undefined}
        onPointerDown={(e) => { p.onSide?.(side); press(side, e); }} onPointerUp={b ? undefined : release} onPointerCancel={b ? undefined : () => endHold()}
        onFocus={() => p.onSide?.(side)} onContextMenu={(e) => e.preventDefault()}
        onClick={(e) => { if (firedByPointer.current || e.detail > 0) { firedByPointer.current = false; return; } (b ? p.onBoost : p.onDump)(); }}>
        {!b && p.dumpAll && <span className="ph-hold" aria-hidden />}
        <span className="ph-lbl">{full && !dis ? "3 IN FLIGHT" : `${b ? "BOOST" : "DUMP"} ${b ? p.buyLabel : p.sellLabel}`}</span>
        {!b && p.dumpSub && !(full && !dis) && <span className="ph-sub" data-testid="dump-sub">{p.dumpSub}</span>}
      </button>);
  };
  const chip = (o: { label: string; sel: boolean; over?: boolean; dump?: boolean; tag?: string; testid: string; onTap: () => void; aria: string }) =>
    <button key={o.testid} type="button" data-haptic="select" data-testid={o.testid} aria-pressed={o.sel} aria-label={o.aria} {...p.keyGuard}
      className={`ph-chip${o.sel ? " sel" : ""}${o.dump ? " dump" : ""}${o.over && !o.sel ? " over" : ""}`} data-over={o.over ? "1" : undefined}
      onClick={o.onTap}>{o.label}{o.tag ? <i className={`ph-chip-tag${o.tag.endsWith("!") ? " over" : ""}`} aria-hidden /> : null}</button>;
  const bw = p.buyWarn || [], sw = p.sellWarn || [];
  if (cta && !p.noSignIn) return (
    <div aria-label="trade bar" data-testid="trade-bar" data-signed-out="1" className="ph-bar">
      <button type="button" className="ph-fire ph-boost ph-signin" data-testid="phone-signin" data-haptic="boost" onClick={() => dispatchEvent(new Event(WALLET_CTA_CLICK_EVENT))}>
        <span className="ph-lbl">SIGN IN TO PLAY</span></button>
      <style jsx global>{`
        .ph-bar { position: fixed; left: 12px; right: 12px; bottom: var(--ph-bar-bottom, 24px); z-index: 40; display: flex; }
        .ph-signin { flex: 1 1 0; all: unset; box-sizing: border-box; flex: 1 1 0; height: 64px; border-radius: 16px; display: flex; align-items: center; justify-content: center; cursor: pointer;
          background: #F2C14E; color: #121327; -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
        .ph-signin:active { transform: scale(.97); filter: brightness(1.1); }
        .ph-signin:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        .ph-signin .ph-lbl { font: 800 26px/1 var(--dsc-font-game, var(--font-barlow-condensed), 'Barlow Condensed', 'Arial Narrow', sans-serif); letter-spacing: 1px; }
      `}</style>
    </div>);
  return (
    <div aria-label="trade bar" data-testid="trade-bar" className="ph-bar">
      {holdHint ? <div data-testid="hold-hint" className="ph-hint">Hold to dump all</div>
        : p.hint ? <div data-testid="trade-hint" className="ph-hint">{p.hint}</div>
        : p.warn ? <div data-testid="trade-warn" className={`ph-hint ph-warn${p.warnOver ? " over" : ""}`}>{p.warn}</div> : null}
      <div className="ph-col ph-col-boost" onPointerDown={() => p.onSide?.("buy")}>
        <div className="ph-chips" data-testid="boost-chips">
          {p.buyOpts.slice(0, 4).map((o, i) => chip({ label: o, sel: i === p.buySel, over: !!p.buyOver?.[i], tag: bw[i], testid: `amt-opt-${i}`,
            aria: `Boost amount ${o}${p.buyOver?.[i] ? ", over your wallet limit" : ""}`, onTap: () => p.onPickBuy(i) }))}
        </div>
        {fire("buy")}
      </div>
      <div className="ph-col ph-col-dump" onPointerDown={() => p.onSide?.("sell")}>
        <div className="ph-chips" data-testid="dump-chips">
          {dc.part >= 0 && chip({ label: p.sellOpts[dc.part], sel: p.sellSel === dc.part, dump: true, tag: sw[dc.part], testid: "dump-chip-part",
            aria: `Dump amount ${p.sellOpts[dc.part]}${p.sellSel === dc.part ? " (tap again for the next size)" : ""}`,
            onTap: () => p.onPickSell(p.sellSel === dc.part ? dc.next : dc.part) })}
          {dc.all >= 0 && chip({ label: "ALL", sel: p.sellSel === dc.all, dump: true, tag: sw[dc.all], testid: "dump-chip-all", aria: "Dump all (hold the button)", onTap: () => p.onPickSell(dc.all) })}
        </div>
        {fire("sell")}
      </div>
      <style jsx global>{`
        .ph-bar { position: fixed; left: 12px; right: 12px; bottom: var(--ph-bar-bottom, 24px); z-index: 40; display: flex; gap: 8px; align-items: flex-end;
          font-family: var(--dsc-font-ui, var(--font-geist), system-ui, sans-serif); }
        .ph-col { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
        .ph-col-boost { flex: 1.6 1 0; } .ph-col-dump { flex: 1 1 0; }
        .ph-chips { display: flex; gap: 4px; }
        html.ap-phone:not([data-ph-sheet=""]) .ph-chips { display: none; }
        .ph-chip { all: unset; box-sizing: border-box; position: relative; flex: 1 1 0; min-width: 0; min-height: 36px; padding: 0 4px; border-radius: 10px; display: flex; align-items: center; justify-content: center;
          border: 1px solid #2E323A; background: rgba(11,12,14,.6); color: #F2F3F7; cursor: pointer; white-space: nowrap; -webkit-tap-highlight-color: transparent; touch-action: manipulation;
          font: 700 16px/1 var(--dsc-font-game, var(--font-barlow-condensed), 'Barlow Condensed', 'Arial Narrow', sans-serif); }
        .ph-chip.sel { border: 0; background: #F2F3F7; color: #121327; }
        .ph-chip.over { border: 1px dashed rgba(243,223,168,.6); color: rgba(243,223,168,.75); }
        .ph-chip.dump.sel { border: 1px solid #F0307F; background: rgba(240,48,127,.22); color: #FFC2DA; }
        .ph-chip-tag { position: absolute; top: 4px; right: 4px; width: 6px; height: 6px; border-radius: 50%; background: #FFE7A3; }
        .ph-chip-tag.over { background: #FF9CC4; }
        .ph-chip:focus-visible, .ph-fire:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        .ph-fire { all: unset; box-sizing: border-box; position: relative; overflow: hidden; height: 64px; border-radius: 16px; display: flex; flex-direction: column; align-items: center; justify-content: center;
          cursor: pointer; -webkit-tap-highlight-color: transparent; touch-action: manipulation; -webkit-touch-callout: none; user-select: none; -webkit-user-select: none;
          transform-origin: 50% 60%; transition: height .2s; }
        html.ap-phone:not([data-ph-sheet=""]) .ph-fire { height: 60px; }
        .ph-boost { background: #F2C14E; color: #121327; }
        .ph-dump { background: rgba(240,48,127,.14); border: 1px solid #F0307F; color: #F0307F; }
        .ph-fire[data-disabled="1"] { opacity: .55; }
        .ph-dump[data-disabled="1"] { opacity: 1; background: rgba(240,48,127,.08); border-color: rgba(240,48,127,.45); color: rgba(240,48,127,.6); }
        .ph-fire:disabled { cursor: not-allowed; }
        .ph-fire:active:not(:disabled) { transform: scale(.96); filter: brightness(1.12); transition: transform .04s, filter .04s; }
        .ph-lbl { position: relative; font: 800 26px/1 var(--dsc-font-game, var(--font-barlow-condensed), 'Barlow Condensed', 'Arial Narrow', sans-serif); letter-spacing: 1px; white-space: nowrap; }
        .ph-dump .ph-lbl { font-size: 22px; letter-spacing: 0; }
        .ph-sub { position: relative; margin-top: 3px; font: 600 13px/1 var(--dsc-font-game, var(--font-barlow-condensed), 'Barlow Condensed', 'Arial Narrow', sans-serif); color: #FF9CC4; white-space: nowrap; }
        .ph-dump[data-disabled="1"] .ph-sub { color: inherit; }
        /* DUMP ALL hold ring: fills left to right over HOLD_MS while the finger stays down */
        .ph-hold { position: absolute; inset: 0; border-radius: inherit; pointer-events: none; overflow: hidden; }
        .ph-hold::before { content: ""; position: absolute; inset: 0; background: rgba(240,48,127,.42); transform: scaleX(0); transform-origin: left center; }
        .ph-fire[data-holding="1"] .ph-hold::before { transform: scaleX(1); transition: transform ${HOLD_MS}ms linear; }
        .ph-hint { position: absolute; left: 0; right: 0; bottom: calc(100% + 10px); margin: 0 auto; width: max-content; max-width: 100%; box-sizing: border-box; padding: 6px 12px; border-radius: 12px;
          font-size: 12px; color: #FFB0C8; background: rgba(18,19,39,.9); border: 1px solid rgba(240,48,127,.35); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .ph-warn { color: #FFE7A3; border-color: rgba(255,231,163,.35); }
        .ph-warn.over { color: #FFB0C8; border-color: rgba(255,61,127,.3); }
        @media (max-width: 374px) {   /* 360-class phones */
          .ph-lbl { font-size: 22px; } .ph-dump .ph-lbl { font-size: 19px; }
          .ph-chip { font-size: 14px; }
        }
      `}</style>
    </div>
  );
}
