"use client";

import type React from "react";
import { useEffect, useState } from "react";

/**
 * Phone trade bar v3 (html.ap-phone; mockups phone-v3 frame1 + frame2). Layout only — every action is TradeBridge's own:
 *   BOOST [$10 ⌄]  DUMP [25% ⌄]   tap the button body = trade (TradeBridge shoot / dumpRef), tap the amount chip = amount sheet.
 * Amount sheet: 2×2 presets (BUY $ = the engine's ammo tiers, DUMP = the SELL % presets) + Custom field / SET. A tap SETS the
 * amount and closes the sheet; the sheet never trades.
 * GAME graduation fix (lee 7:09 PM CT): options carry a price-move tag ("+38%", "!" = over the live limit) and the bar shows
 * the active amount's warning line; nothing is ever greyed or blocked for price impact. Post-grad fix 3: the line is only the
 * side being tapped / previewed — onSide reports the side whose button or amount chip was touched (TradeBridge activeWarning).
 */
export type PhoneTradeBarProps = {
  buyLabel: string; sellLabel: string;
  onBoost: () => void; onDump: () => void;
  boostDisabled: boolean; dumpDisabled: boolean; boostTitle: string; dumpTitle: string;
  /** rapid tap: 3 trades in flight — both buttons look greyed and read "3 IN FLIGHT" but stay tappable, so an extra tap
   *  reaches the engine's '3 IN FLIGHT' pulse instead of being swallowed by a disabled button */
  inFlightFull?: boolean;
  buyOpts: string[]; buySel: number; onPickBuy: (i: number) => void; onSetBuy: (v: string) => void;
  sellOpts: string[]; sellSel: number; onPickSell: (i: number) => void; onSetSell: (v: string) => void;
  hint: string;
  /** per-option price-move tags (lib/flight/tradeGate chipTag); "" = none. Warning only. */
  buyWarn?: string[]; sellWarn?: string[];
  /** the active amount's warning line ("BOOST: Big move: price +38%"); shown under any blocking hint */
  warn?: string; warnOver?: boolean;
  /** the side the user is touching (button, amount chip, sheet pick) → TradeBridge shows only that side's warning */
  onSide?: (side: "buy" | "sell") => void;
  keyGuard: { onKeyDown: (e: React.KeyboardEvent) => void; onKeyUp: (e: React.KeyboardEvent) => void };
};
/** chip / sheet money: $10 · $2.50 · $1.20K (whole dollars drop the cents) */
export const chipUsd = (v: number) => (!(v > 0) ? "$0" : v >= 1000 ? (v >= 1e6 ? `$${+(v / 1e6).toFixed(2)}M` : `$${+(v / 1e3).toFixed(2)}K`) : Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`);

const Chevron = ({ c }: { c: string }) => <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden style={{ opacity: 0.75 }}><path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke={c} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const Xicon = () => <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="#D8DEF0" strokeWidth="2.2" strokeLinecap="round" /></svg>;

export default function PhoneTradeBar(p: PhoneTradeBarProps) {
  const [sheet, setSheet] = useState<null | "buy" | "sell">(null);
  const [val, setVal] = useState("");
  useEffect(() => { setVal(""); }, [sheet]);
  useEffect(() => { if (!sheet) return; const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setSheet(null); } };
    addEventListener("keydown", k, true); return () => removeEventListener("keydown", k, true); }, [sheet]);
  const buy = sheet === "buy";
  const opts = buy ? p.buyOpts : p.sellOpts, sel = buy ? p.buySel : p.sellSel, tags = (buy ? p.buyWarn : p.sellWarn) || [];
  const n = +val > 0 ? +val : 0;
  const apply = () => { if (!n) return; p.onSide?.(buy ? "buy" : "sell"); (buy ? p.onSetBuy : p.onSetSell)(String(buy ? n : Math.min(100, n))); setSheet(null); };
  const tb = (side: "buy" | "sell") => {
    const b = side === "buy", dis = b ? p.boostDisabled : p.dumpDisabled, full = !!p.inFlightFull && !dis;
    return (
      <div className={`ph-tb ${b ? "ph-boost" : "ph-dump"}`} data-disabled={dis || full ? "1" : "0"} data-inflight={full ? "1" : "0"} onPointerDown={() => p.onSide?.(side)} onFocusCapture={() => p.onSide?.(side)}>
        <button type="button" className="ph-tb-body" data-testid={b ? "buy-btn" : "sell-btn"} aria-label={b ? `buy ${p.buyLabel}` : `sell ${p.sellLabel}`}
          title={b ? p.boostTitle : p.dumpTitle} aria-disabled={dis || full} disabled={dis} {...p.keyGuard} onClick={b ? p.onBoost : p.onDump}>
          <span className="ph-lbl">{full ? "3 IN FLIGHT" : b ? "BOOST" : "DUMP"}</span></button>
        <button type="button" className="ph-amt" data-testid={b ? "phone-amt-buy" : "phone-amt-sell"} aria-haspopup="dialog" aria-label={`${b ? "BOOST" : "DUMP"} amount: ${b ? p.buyLabel : p.sellLabel} (change)`}
          {...p.keyGuard} onClick={() => setSheet(side)}>{b ? p.buyLabel : p.sellLabel}<Chevron c={b ? "#04281A" : "#fff"} /></button>
      </div>);
  };
  return (
    <>
      <div aria-label="trade bar" data-testid="trade-bar" className="ph-bar">
        {p.hint ? <div data-testid="trade-hint" className="ph-hint">{p.hint}</div>
          : p.warn ? <div data-testid="trade-warn" className={`ph-hint ph-warn${p.warnOver ? " over" : ""}`}>{p.warn}</div> : null}
        <div className="ph-btns">{tb("buy")}{tb("sell")}</div>
      </div>
      {sheet && <>
        <div className="ph-dim" data-testid="amt-sheet-dim" onPointerDown={(e) => { e.preventDefault(); setSheet(null); }} />
        <div role="dialog" aria-modal="true" aria-label={buy ? "BOOST amount" : "DUMP amount"} data-testid="amt-sheet" className="ph-sheet">
          <div className="ph-sh-grab"><i /></div>
          <div className="ph-sh-head"><div className="ph-sh-title"><span style={{ color: buy ? "#2FD98A" : "#FF3D7F" }}>{buy ? "▲" : "▼"}</span> {buy ? "BOOST" : "DUMP"} AMOUNT</div>
            <button type="button" className="ph-sh-x" data-testid="amt-sheet-close" aria-label="Close" onClick={() => setSheet(null)}><Xicon /></button></div>
          <div className="ph-grid">
            {opts.slice(0, 4).map((o, i) => <button key={i} type="button" data-testid={`amt-opt-${i}`} className={`ph-opt${i === sel ? " sel" : ""}${buy ? "" : " dump"}`} aria-pressed={i === sel}
              onClick={() => { p.onSide?.(buy ? "buy" : "sell"); (buy ? p.onPickBuy : p.onPickSell)(i); setSheet(null); }}>{o}{tags[i] ? <span className={`ph-opt-warn${tags[i].endsWith("!") ? " over" : ""}`} data-testid={`amt-opt-warn-${i}`}>{tags[i].endsWith("!") ? "too big" : "big move"} {tags[i].replace(/!$/, "")}</span> : null}</button>)}
          </div>
          <form className="ph-custom" onSubmit={(e) => { e.preventDefault(); apply(); }}>
            <span className="ph-cl">Custom</span>
            <label className="ph-field">{buy && <span className="ph-cur">$</span>}
              <input data-testid="amt-custom" aria-label={buy ? "custom BOOST amount in dollars" : "custom DUMP percent of holdings"} inputMode="decimal" placeholder={buy ? "0.00" : "0"} value={val}
                onChange={(e) => setVal(e.target.value.replace(/[^\d.]/g, ""))} onKeyDown={(e) => e.stopPropagation()} />
              {!buy && <span className="ph-cur dump">%</span>}</label>
            <button type="submit" className={`ph-set${buy ? "" : " dump"}`} data-testid="amt-set" disabled={!n}>SET</button>
          </form>
          <div className="ph-sh-hint">Tap an amount to set it</div>
        </div>
      </>}
      <style jsx global>{`
        .ph-bar { position: fixed; left: 16px; right: 16px; bottom: 22px; z-index: 40; font-family: ui-monospace, Menlo, "DejaVu Sans Mono", monospace; }
        .ph-btns { display: flex; gap: 12px; }
        .ph-tb { flex: 1 1 0; min-width: 0; height: 68px; border-radius: 22px; position: relative; display: flex; align-items: center; justify-content: flex-end; padding: 0 8px; box-sizing: border-box; transition: height .2s, opacity .2s; }
        html.ap-phone:not([data-ph-sheet=""]) .ph-tb { height: 60px; border-radius: 20px; }
        html.ap-phone:not([data-ph-sheet=""]) .ph-amt { height: 44px; }
        .ph-tb[data-disabled="1"] .ph-tb-body, .ph-tb[data-disabled="1"] .ph-lbl { opacity: .5; }
        .ph-tb[data-disabled="1"] { filter: saturate(.55); }
        .ph-boost { background: linear-gradient(180deg, #36E595, #17B56C); color: #04281A; box-shadow: 0 12px 28px -10px rgba(47,217,138,.65), inset 0 1px 0 rgba(255,255,255,.35); }
        .ph-dump { background: linear-gradient(180deg, #FF5A93, #E3216A); color: #fff; box-shadow: 0 12px 28px -10px rgba(255,61,127,.6), inset 0 1px 0 rgba(255,255,255,.3); }
        .ph-tb-body { all: unset; position: absolute; inset: 0; border-radius: inherit; cursor: pointer; display: flex; align-items: center; padding-left: 18px; -webkit-tap-highlight-color: transparent; }
        .ph-tb-body:disabled { cursor: not-allowed; }
        .ph-tb-body:active:not(:disabled) { background: rgba(255,255,255,.12); }
        .ph-tb-body:focus-visible, .ph-amt:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        .ph-lbl { font-size: 19px; font-weight: 800; letter-spacing: .08em; }
        .ph-amt { all: unset; position: relative; z-index: 1; box-sizing: border-box; height: 48px; min-width: 72px; padding: 0 10px 0 14px; border-radius: 15px; display: flex; align-items: center; justify-content: center; gap: 6px;
          font-size: 16px; font-weight: 700; cursor: pointer; white-space: nowrap; -webkit-tap-highlight-color: transparent; transition: height .2s; }
        .ph-boost .ph-amt { background: rgba(3,40,24,.18); color: #04281A; }
        .ph-dump .ph-amt { background: rgba(60,0,22,.22); color: #fff; }
        .ph-hint { position: absolute; left: 0; right: 0; bottom: calc(100% + 10px); margin: 0 auto; width: max-content; max-width: 100%; box-sizing: border-box; padding: 6px 12px; border-radius: 12px;
          font-size: 11.5px; color: #FFB0C8; background: rgba(16,18,34,.85); border: 1px solid rgba(255,61,127,.3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .ph-warn { color: #FFE7A3; border-color: rgba(255,231,163,.35); }
        .ph-warn.over { color: #FFB0C8; border-color: rgba(255,61,127,.3); }
        .ph-opt-warn { position: absolute; left: 0; right: 0; bottom: 6px; text-align: center; font-size: 10.5px; font-weight: 700; letter-spacing: .04em; color: #FFE7A3; }
        .ph-opt-warn.over { color: #FFB0C8; }
        .ph-dim { position: fixed; inset: 0; z-index: 60; background: rgba(5,6,14,.5); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); }
        .ph-sheet { position: fixed; left: 8px; right: 8px; bottom: 8px; z-index: 61; border-radius: 30px; padding: 0 18px 20px; box-sizing: border-box; color: #EEF1FA;
          font-family: ui-monospace, Menlo, "DejaVu Sans Mono", monospace; background: rgba(18,20,38,.78); -webkit-backdrop-filter: blur(28px) saturate(1.3); backdrop-filter: blur(28px) saturate(1.3);
          border: 1px solid rgba(255,255,255,.10); box-shadow: 0 -10px 50px -10px rgba(0,0,0,.7), inset 0 1px 0 rgba(255,255,255,.08); }
        .ph-sh-grab { height: 26px; display: grid; place-items: center; }
        .ph-sh-grab i { width: 40px; height: 5px; border-radius: 3px; background: rgba(255,255,255,.38); }
        .ph-sh-head { display: flex; align-items: center; justify-content: space-between; height: 48px; margin-bottom: 10px; }
        .ph-sh-title { font-size: 15px; font-weight: 800; letter-spacing: .12em; }
        .ph-sh-x { all: unset; width: 48px; height: 48px; border-radius: 16px; display: grid; place-items: center; background: rgba(255,255,255,.06); margin-right: -6px; cursor: pointer; }
        .ph-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .ph-opt { all: unset; box-sizing: border-box; position: relative; height: 72px; border-radius: 20px; display: grid; place-items: center; font-size: 24px; font-weight: 800; letter-spacing: .03em; cursor: pointer;
          background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08); color: #EEF1FA; }
        .ph-opt.sel { background: rgba(47,217,138,.14); border: 1.5px solid #2FD98A; color: #9FF5C8; box-shadow: 0 0 24px -8px rgba(47,217,138,.7); }
        .ph-opt.dump.sel { background: rgba(255,61,127,.14); border-color: #FF3D7F; color: #FFB3CC; box-shadow: 0 0 24px -8px rgba(255,61,127,.7); }
        .ph-custom { margin: 10px 0 0; height: 64px; border-radius: 20px; display: flex; align-items: center; gap: 12px; padding: 0 8px 0 18px; box-sizing: border-box;
          background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08); }
        .ph-cl { font-size: 15px; font-weight: 700; color: rgba(214,222,245,.56); letter-spacing: .06em; flex: 1; }
        .ph-field { width: 128px; height: 48px; border-radius: 14px; box-sizing: border-box; background: rgba(0,0,0,.32); border: 1px solid rgba(255,255,255,.12); display: flex; align-items: center; padding: 0 14px; gap: 6px; font-size: 18px; font-weight: 700; }
        .ph-field input { all: unset; min-width: 0; flex: 1; font: inherit; color: #EEF1FA; caret-color: #2FD98A; }
        .ph-field input::placeholder { color: rgba(214,222,245,.32); }
        .ph-cur { color: #2FD98A; } .ph-cur.dump { color: #FF3D7F; }
        .ph-set { all: unset; width: 64px; height: 48px; border-radius: 14px; display: grid; place-items: center; font-size: 14px; font-weight: 800; letter-spacing: .1em; cursor: pointer;
          background: rgba(47,217,138,.16); color: #9FF5C8; border: 1px solid rgba(47,217,138,.35); box-sizing: border-box; }
        .ph-set.dump { background: rgba(255,61,127,.16); color: #FFB3CC; border-color: rgba(255,61,127,.35); }
        .ph-set:disabled { opacity: .5; cursor: default; }
        @media (max-width: 374px) {   /* 360-class phones: label + chip must fit a 158px button */
          .ph-lbl { font-size: 17px; letter-spacing: .05em; }
          .ph-tb-body { padding-left: 14px; }
          .ph-amt { min-width: 62px; padding: 0 8px 0 10px; gap: 4px; font-size: 15px; }
        }
        .ph-sh-hint { margin-top: 14px; text-align: center; font-size: 12px; letter-spacing: .06em; color: rgba(214,222,245,.42); }
      `}</style>
    </>
  );
}
