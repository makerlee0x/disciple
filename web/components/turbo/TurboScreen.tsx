"use client";
/**
 * DISCIPLE Turbo — live trade screen (hidden /turbo; not in the public nav).
 *
 * Layout is the existing DISCIPLE game interface (AppShell + collapsed rail + full-bleed flight + ticket + trade bar),
 * not a Nova terminal. Altitude is the live BTC/ETH market cap (lee, Nov 12 2026 10:40 AM CT), never profit.
 * Live buys/sells from the trade stream become engine boosts and bombs. The engine never places trades.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTurbo } from "@/lib/turbo/useTurbo";
import type { ClosePct, Market, MarketInfo, MarketTrade, Position, Side, TurboEvent } from "@/lib/turbo";
import { TURBO_COPY as C } from "@/lib/turbo/copy";
import { chipUsd, lev as fmtLev, liqWithDistance, price as fmtPrice, signedUsd, usd } from "@/lib/turbo/format";
import { CLOSE_PCTS, DEFAULT_PREFS, FUEL_PRESETS, LEVERAGE_PRESETS, fuelOf, leverageOf, loadPrefs, savePrefs, type TurboPrefs } from "@/lib/turbo/prefs";
import { dangerLevel, dangerOf, isBigWin, marketCapUsd } from "@/lib/turbo/flight";
import { SETTINGS_OPEN_EVENT } from "@/lib/walletCta";
import TurboFlight, { type TurboFlightHandle } from "./TurboFlight";
import TurboFundingSheet from "./TurboFundingSheet";
import TurboHowItWorks from "./TurboHowItWorks";
import TurboShareCard, { type TurboShare } from "./TurboShareCard";
import TurboHBomb from "./TurboHBomb";
import s from "./turbo.module.css";

const MARKETS: Market[] = ["BTC", "ETH"];
const sideWord = (side: Side) => (side === "long" ? C.boost : C.dump);

function ChipRow({ label, opts, fmt, sel, custom, onPick, onCustom, disabledReason, testid, unit, extra }: {
  label: string; opts: readonly number[]; fmt: (v: number) => string; sel: number; custom: number;
  onPick: (i: number) => void; onCustom: (v: number) => void; disabledReason?: (v: number) => string | null; testid: string; unit: "$" | "×";
  extra?: ReactNode;
}) {
  const [val, setVal] = useState(custom > 0 && sel < 0 ? String(custom) : "");
  useEffect(() => { if (sel >= 0) setVal(""); }, [sel]);
  return (
    <div className={s.chipBlock}>
      <div className={s.fuelHead}><div className={s.k}>{label}</div>{extra}</div>
      <div className={s.chips}>
        {opts.map((o, i) => { const why = disabledReason?.(o) ?? null; return (
          <button key={o} type="button" className={`${s.chip} ${i === sel ? s.chipSel : ""}`} aria-pressed={i === sel} disabled={!!why} title={why ?? undefined}
            data-testid={`${testid}-${i}`} onClick={() => onPick(i)}>{fmt(o)}{why && <span className={s.chipWhy}>{why}</span>}</button>); })}
        <form className={s.customRow} onSubmit={(e) => { e.preventDefault(); const n = +val; if (n > 0) onCustom(n); }}>
          <label className={`${s.field} ${sel < 0 ? s.fieldOn : ""}`}>{unit === "$" && <span>$</span>}
            <input inputMode="decimal" aria-label={`${C.custom} ${label.toLowerCase()}`} data-testid={`${testid}-custom`} placeholder={C.custom} value={val}
              onChange={(e) => setVal(e.target.value.replace(/[^0-9.]/g, ""))} onBlur={() => { const n = +val; if (n > 0) onCustom(n); }} />
            {unit === "×" && <span>×</span>}</label>
        </form>
      </div>
    </div>
  );
}

const Row = ({ k, v, tone, testid }: { k: string; v: string; tone?: "up" | "down" | "liq"; testid?: string }) => (
  <div className={s.row} data-testid={testid}><span className={s.k}>{k}</span><span className={`${s.v} ${tone ? s[tone] : ""}`}>{v}</span></div>
);

function fundingLine(p: Position): string {
  if (p.fundingUsd === 0) return C.fundingOffMarket;
  const v = signedUsd(p.fundingUsd);
  return p.fundingUsd < 0 ? C.fundingPaid(v) : C.fundingReceived(v);
}

function PositionCard({ p }: { p: Position }) {
  const mark = p.markPrice ?? p.entry, pending = p.status === "pending";
  const afterLabel = p.pnlAfterFeesUsd >= 0 ? C.pnlAfter : C.lossAfter;
  return (
    <div className={s.card} data-testid="turbo-position-card" data-status={p.status}>
      <div className={s.cardHead}>
        <span className={p.side === "long" ? s.up : s.down}>{sideWord(p.side)} · {p.market} · {fmtLev(p.leverage)}</span>
        <span className={s.levTag}>{C.positions.replace(/s$/, "")}</span>
      </div>
      {pending ? <div className={s.pendingBig}>{C.waitingFill}</div> : <>
        <div className={s.k}>{afterLabel}</div>
        <div className={`${s.bigPnl} ${p.pnlAfterFeesUsd >= 0 ? s.up : s.down}`} data-testid="turbo-pnl-after">{signedUsd(p.pnlAfterFeesUsd)}</div>
        <div className={s.winLine}>{p.side === "long" ? C.youWinLong : C.youWinShort}</div>
      </>}
      <Row k={C.size} v={usd(p.sizeUsd)} />
      <Row k={C.fuelIn} v={usd(p.collateralUsd)} />
      <Row k={pending ? C.entryEst : C.entry} v={fmtPrice(p.entry)} />
      <Row k={C.now} v={fmtPrice(mark)} />
      <Row k={C.liq} v={liqWithDistance(p.liqPrice, mark)} tone="liq" testid="turbo-card-liq" />
      {!pending && <>
        <Row k={C.funding} v={fundingLine(p)} />
        <Row k={C.feesPaid} v={usd(p.openFeeUsd)} />
        <Row k={C.closeFee} v={usd(p.closeFeeUsdEst)} />
        <Row k={C.loseIfLiq} v={usd(p.collateralUsd)} />
        <Row k={p.pnlUsd >= 0 ? C.pnlBefore : "Loss before fees"} v={signedUsd(p.pnlUsd)} />
      </>}
    </div>
  );
}

function Picker({ side, prefs, setPrefs, levWhy, onClose }: { side: Side; prefs: TurboPrefs; setPrefs: (p: TurboPrefs) => void; levWhy: (v: number) => string | null; onClose: () => void }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);
  return (
    <div className={s.dim} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={`${sideWord(side)} fuel and leverage`} className={`${s.sheet} ${s.pickSheet}`} data-testid="turbo-picker">
        <button type="button" className={s.x} aria-label="Close" onClick={onClose}>×</button>
        <div className={s.sheetTitle}><span className={side === "long" ? s.up : s.down}>{side === "long" ? "▲" : "▼"}</span> {sideWord(side)}</div>
        <ChipRow label={C.fuelLabel} unit="$" testid="pick-fuel" opts={FUEL_PRESETS} fmt={chipUsd} sel={prefs.fuelIdx} custom={prefs.fuelCustom}
          onPick={(i) => setPrefs({ ...prefs, fuelIdx: i })} onCustom={(v) => setPrefs({ ...prefs, fuelIdx: -1, fuelCustom: v })} />
        <ChipRow label={C.leverageLabel} unit="×" testid="pick-lev" opts={LEVERAGE_PRESETS} fmt={(v) => `${v}×`} sel={prefs.levIdx} custom={prefs.levCustom} disabledReason={levWhy}
          onPick={(i) => setPrefs({ ...prefs, levIdx: i })} onCustom={(v) => setPrefs({ ...prefs, levIdx: -1, levCustom: v })} />
        <button type="button" className={s.doneBtn} onClick={onClose}>Done</button>
        <p className={s.pickFooter}>{C.pickerFooter}</p>
      </div>
    </div>
  );
}

export default function TurboScreen() {
  const { adapter, prices, fuel, positions, lastEvent, standIn } = useTurbo();
  const [prefs, setPrefsState] = useState<TurboPrefs>(DEFAULT_PREFS);
  useEffect(() => { setPrefsState(loadPrefs()); }, []);
  const setPrefs = useCallback((p: TurboPrefs) => { setPrefsState(p); savePrefs(p); }, []);
  const market = prefs.market;
  const markets: MarketInfo[] = useMemo(() => adapter.getMarkets?.() ?? MARKETS.map((m) => ({ market: m, maxLeverage: 1000 })), [adapter]);
  const info = markets.find((m) => m.market === market);
  const levWhy = useCallback((v: number) => (info && v > info.maxLeverage ? (info.leverageNote ?? C.leverageMax(info.maxLeverage, market)) : null), [info, market]);

  const fuelUsd = fuelOf(prefs), leverage = leverageOf(prefs);
  const px = prices[market];
  const hasPx = !!px && px > 0;
  const qLong = hasPx ? adapter.quote({ market, side: "long", collateralUsd: fuelUsd, leverage }) : null;
  const qShort = hasPx ? adapter.quote({ market, side: "short", collateralUsd: fuelUsd, leverage }) : null;

  const mine = positions.filter((p) => p.market === market);
  const active = mine[mine.length - 1] ?? null;
  const [adding, setAdding] = useState(false);
  useEffect(() => { if (!active) setAdding(false); }, [active]);

  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ txt: string; tone?: "up" | "down" } | null>(null);
  const flash = useCallback((txt: string, tone?: "up" | "down") => { setToast({ txt, tone }); setTimeout(() => setToast((t) => (t?.txt === txt ? null : t)), 3200); }, []);
  const [sheet, setSheet] = useState<null | "fund" | "how" | "position" | { pick: Side }>(null);
  const [share, setShare] = useState<TurboShare | null>(null);
  const [nova, setNova] = useState<null | { short: boolean; label: string; share: TurboShare }>(null);
  const flight = useRef<TurboFlightHandle>(null);
  const fuelAtOpen = useRef<Record<string, number>>({});
  const lastMid = useRef<Partial<Record<Market, number>>>({});
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const [pageOpenedAt] = useState(() => Date.now());

  useEffect(() => { document.body.classList.add("turbo-game"); return () => document.body.classList.remove("turbo-game"); }, []);

  /* ---- taps: adapter first, visuals after (never awaited) ---- */
  const open = async (side: Side) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = adapter.open({ market, side, collateralUsd: fuelUsd, leverage });
      flight.current?.ignite();
      await r;
      setAdding(false);
    } catch (e) { flash(e instanceof Error ? e.message : C.failed, "down"); }
    finally { setBusy(false); }
  };
  const close = async (p: Position, pct: ClosePct) => {
    if (busy) return;
    setBusy(true);
    try { await adapter.close(p.id, pct); } catch (e) { flash(e instanceof Error ? e.message : C.failed, "down"); } finally { setBusy(false); }
  };

  /* ---- events → toasts, H-BOMB, share cards ---- */
  const seen = useRef<TurboEvent | null>(null);
  useEffect(() => {
    const e = lastEvent; if (!e || e === seen.current) return; seen.current = e;
    const p = e.position;
    if (e.type === "pending" || e.type === "filled") { if (!(p.id in fuelAtOpen.current)) fuelAtOpen.current[p.id] = p.collateralUsd; return; }
    if (e.type === "failed") { flash(C.failed, "down"); return; }
    if (e.type === "partial-closed") { flash(C.partialToast(e.pct ?? 0, usd(e.returnedUsd ?? 0)), "up"); return; }
    const fuelIn = fuelAtOpen.current[p.id] ?? p.collateralUsd;
    const base = { market: p.market, side: p.side, leverage: p.leverage, fuelUsd: fuelIn, entry: p.entry, exit: p.markPrice ?? p.entry };
    if (e.type === "liquidated") {
      const bombs = (() => { try { return localStorage.getItem("disciple.bombs") !== "off"; } catch { return true; } })();
      flight.current?.supernova(bombs);
      setNova({ short: !bombs, label: C.liquidatedToast(fmtLev(p.leverage)), share: { ...base, kind: "liquidated", profitUsd: (p.realizedUsd ?? 0) - fuelIn } });
      return;
    }
    if (e.type === "closed") {
      const profit = (p.realizedUsd ?? 0) - fuelIn;
      flash(C.closedToast(usd(e.returnedUsd ?? 0)), profit >= 0 ? "up" : "down");
      if (isBigWin(profit)) setShare({ ...base, kind: "win", profitUsd: profit });
    }
  }, [lastEvent, flash]);

  /* ---- live mid → market-cap altitude; ticket/HUD numbers move with the same ticks ---- */
  const danger = active && active.status === "open" ? dangerOf(active) : 0;
  const level = dangerLevel(danger);
  useEffect(() => {
    const f = flight.current;
    if (hasPx) {
      lastMid.current[market] = px!;
      f?.mark(marketCapUsd(market, px!));
    }
    const live = !!(active && (active.status === "open" || active.status === "pending"));
    const liqMcap = active ? marketCapUsd(market, active.liqPrice) : undefined;
    const entryMcap = active ? marketCapUsd(market, active.entry) : 0;
    (window as unknown as { __entryMcap?: number }).__entryMcap = entryMcap > 0 ? entryMcap : 0;
    f?.setFx({
      open: !!active && active.status === "open", pending: active?.status === "pending",
      side: active?.side ?? null, lev: active?.leverage ?? leverage, danger,
      dive: false,
      liqMcap: live && liqMcap && liqMcap > 0 ? liqMcap : undefined,
      liqLabel: active ? `LIQUIDATION · ${fmtPrice(active.liqPrice)}` : undefined,
    });
  }, [active, danger, leverage, px, hasPx, market]);

  /* ---- live trades → existing engine boosts / bombs (completed fills only, not the book) ---- */
  useEffect(() => {
    if (!adapter.subscribeTrades) return;
    return adapter.subscribeTrades(market, (t: MarketTrade) => {
      const pre = t.prePrice ?? lastMid.current[t.market];
      lastMid.current[t.market] = t.price;
      flight.current?.swap({ side: t.side, usd: t.usd, mcap: marketCapUsd(t.market, t.price), price: t.price, prePrice: pre, ts: t.ts });
    });
  }, [adapter, market]);

  const pendingLong = active?.status === "pending" && active.openedAt != null && now - active.openedAt > 60_000;
  const waitingPrice = !hasPx && now - pageOpenedAt > 3000;
  const showClose = !!active && !adding;
  const chipLabel = `${chipUsd(fuelUsd)} · ${fmtLev(leverage)}`;
  const afterLabel = active && active.pnlAfterFeesUsd < 0 ? C.lossAfter : C.pnlAfter;

  const tradeBar = (
    <div className={s.bar} data-testid="turbo-trade-bar">
      {showClose ? <>
        <div className={s.closeBar}>
          {CLOSE_PCTS.map((pct) => <button key={pct} type="button" className={s.barClose} disabled={busy || active!.status !== "open"} data-testid={`turbo-close-${pct}`} onClick={() => close(active!, pct)}>{C.close} {pct}%</button>)}
        </div>
        <button type="button" className={s.addBtn} data-testid="turbo-add" onClick={() => setAdding(true)}>{C.add}</button>
      </> : (["long", "short"] as Side[]).map((side) => (
        <div key={side} className={`${s.tb} ${side === "long" ? s.tbBoost : s.tbDump}`}>
          <button type="button" className={s.tbBody} data-testid={side === "long" ? "turbo-boost" : "turbo-dump"} disabled={busy || !hasPx} title={side === "long" ? C.boostHint : C.dumpHint}
            onClick={() => open(side)}>{sideWord(side)}<span className={s.tbHint}>{side === "long" ? C.boostHint : C.dumpHint}</span></button>
          <button type="button" className={s.tbChip} data-testid={side === "long" ? "turbo-chip-boost" : "turbo-chip-dump"} aria-haspopup="dialog" onClick={() => setSheet({ pick: side })}>{chipLabel} ⌄</button>
        </div>))}
      {adding && active && <button type="button" className={s.addBtn} onClick={() => setAdding(false)}>{C.backToClose}</button>}
    </div>
  );

  const ticketBody = active && !adding ? (
    <>
      <PositionCard p={active} />
      <p className={s.feeFooter}>{C.feeFooter}</p>
      <button type="button" className={s.howLink} onClick={() => setSheet("how")}>{C.howItWorks}</button>
    </>
  ) : (
    <>
      <div className={s.ticketHead}>
        <h2>{C.newPosition}</h2>
        <button type="button" className={s.howLink} onClick={() => setSheet("how")}>{C.howItWorks}</button>
      </div>
      <ChipRow label={C.fuelLabel} unit="$" testid="turbo-fuel-chip" opts={FUEL_PRESETS} fmt={chipUsd} sel={prefs.fuelIdx} custom={prefs.fuelCustom}
        extra={<span className={s.k}>{C.fuel} {fuel == null ? "—" : usd(fuel)}</span>}
        onPick={(i) => setPrefs({ ...prefs, fuelIdx: i })} onCustom={(v) => setPrefs({ ...prefs, fuelIdx: -1, fuelCustom: v })} />
      <ChipRow label={C.leverageLabel} unit="×" testid="turbo-lev-chip" opts={LEVERAGE_PRESETS} fmt={(v) => `${v}×`} sel={prefs.levIdx} custom={prefs.levCustom} disabledReason={levWhy}
        onPick={(i) => setPrefs({ ...prefs, levIdx: i })} onCustom={(v) => setPrefs({ ...prefs, levIdx: -1, levCustom: v })} />
      <div className={s.rows}>
        <Row k={C.size} v={qLong ? usd(qLong.sizeUsd) : "—"} />
        <div className={s.sizeHint}>{C.sizeHint}</div>
        <Row k={C.openFee} v={qLong ? usd(qLong.openFeeUsd) : "—"} />
      </div>
      <div className={s.liqBox}>
        <div className={s.k}>{C.estLiq}</div>
        <div className={s.liqLine} data-testid="turbo-liq-boost"><span className={s.up}>{C.boost}</span><span>{qLong ? liqWithDistance(qLong.liqPrice, qLong.entryEst) : "—"}</span></div>
        <div className={s.liqLine} data-testid="turbo-liq-dump"><span className={s.down}>{C.dump}</span><span>{qShort ? liqWithDistance(qShort.liqPrice, qShort.entryEst) : "—"}</span></div>
      </div>
      <p className={s.emptyLine}>{C.noPositions}</p>
    </>
  );

  return (
    <div className={`${s.page} ${s["danger_" + level]}`} data-testid="turbo-screen" data-adapter={adapter.kind}>
      <TurboFlight ref={flight} ticker={market} />

      <header className={s.top}>
        <h1 className={s.wordmark}>{C.title}</h1>
        <div className={s.markets} role="tablist" aria-label="Market">
          {MARKETS.map((m) => <button key={m} role="tab" type="button" aria-selected={m === market} className={`${s.mkt} ${m === market ? s.mktSel : ""}`} data-testid={`turbo-market-${m}`}
            onClick={() => setPrefs({ ...prefs, market: m })}><b>{m}</b><span>{fmtPrice(prices[m] ?? NaN)}</span></button>)}
        </div>
        <div className={s.fuelBox}>
          <span className={s.k}>{C.fuel}</span>
          <b data-testid="turbo-fuel">{fuel == null ? "—" : usd(fuel)}</b>
          <button type="button" className={s.addFuel} data-testid="turbo-add-fuel" onClick={() => setSheet("fund")}>+ {C.addFuel}</button>
        </div>
        <button type="button" className={s.gear} aria-label="Settings" onClick={() => dispatchEvent(new Event(SETTINGS_OPEN_EVENT))}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>
        </button>
      </header>

      <button type="button" className={s.phonePill} data-testid="turbo-price" onClick={() => setPrefs({ ...prefs, market: market === "BTC" ? "ETH" : "BTC" })}>
        {market} {hasPx ? fmtPrice(px!) : C.waitingPrice} ⌄
      </button>

      {standIn && <div className={s.notice} data-testid="turbo-standin-notice">{C.notConnected}</div>}

      {active && <div className={s.hudPnl} data-testid="turbo-hud">
        {active.status === "pending" ? (pendingLong ? C.waitingPrice : C.waitingFill) : <>
          <div className={s.hudK}>{afterLabel}</div>
          <div className={`${s.hudVal} ${active.pnlAfterFeesUsd >= 0 ? s.up : s.down}`}>{signedUsd(active.pnlAfterFeesUsd)}</div>
        </>}
        {level === "hot" && <div className={s.dangerTxt}>{C.runningHot}</div>}
        {(level === "shudder" || level === "blow") && <div className={`${s.dangerTxt} ${s.dangerRed}`}>{level === "blow" ? C.aboutToBlow : C.runningHot}</div>}
      </div>}
      {waitingPrice && <div className={s.hudPnl}>{C.waitingPrice}</div>}

      {!active && <div className={s.phoneEmpty}>
        {C.noPositions}
        <button type="button" className={s.howLink} onClick={() => setSheet("how")}>{C.howItWorks}</button>
      </div>}

      {active && <button type="button" className={s.drawerHandle} data-testid="turbo-position-tab" onClick={() => setSheet("position")}><i /><span>{C.positions.replace(/s$/, "")}</span></button>}

      <aside className={s.ticket} data-testid="turbo-ticket">{ticketBody}</aside>

      {sheet === "position" && active && (
        <div className={s.dim} onPointerDown={(e) => { if (e.target === e.currentTarget) setSheet(null); }}>
          <div className={s.phoneDrawer} role="dialog" aria-label="Position" data-testid="turbo-position-drawer">{ticketBody}</div>
        </div>
      )}

      {tradeBar}

      {toast && <div className={`${s.toast} ${toast.tone ? s[toast.tone] : ""}`} role="status" data-testid="turbo-toast">{toast.txt}</div>}
      {sheet === "fund" && <TurboFundingSheet adapter={adapter} onClose={() => setSheet(null)} />}
      {sheet === "how" && <TurboHowItWorks onClose={() => setSheet(null)} />}
      {sheet && typeof sheet === "object" && <Picker side={sheet.pick} prefs={prefs} setPrefs={setPrefs} levWhy={levWhy} onClose={() => setSheet(null)} />}
      {nova && <TurboHBomb short={nova.short} label={nova.label} onDone={() => { setShare(nova.share); setNova(null); }} />}
      {share && <TurboShareCard data={share} onClose={() => setShare(null)} />}
    </div>
  );
}
