"use client";
/**
 * DISCIPLE Turbo — the live trade screen (hidden /turbo; not in the public nav).
 *
 * Layout follows Nova's own terminal (app.nova.markets, lee's trade-panel-hype-usd.png): market + price on top, the big
 * view on the left (here: the current-main flight engine instead of a candle chart), the ticket docked right, positions
 * under it. Controls follow DISCIPLE's existing buy / sell setup (components/flight/PhoneTradeBar.tsx +
 * TradeBridge.tsx): four dollar chips plus a custom field, market orders only, one-tap close at 25 / 50 / 100 percent.
 * No take-profit, stop-loss or limit orders (lee, Nov 12 2026). Long / Short are BOOST / DUMP.
 *
 * Every number comes from the adapter (getTurboAdapter): quote() before the tap, the fill and events after it.
 * Visuals never gate a tap: BOOST / DUMP / CLOSE call the adapter first, then poke the flight.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTurbo } from "@/lib/turbo/useTurbo";
import type { ClosePct, Market, MarketInfo, Position, Side, TurboEvent } from "@/lib/turbo";
import { TURBO_COPY as C } from "@/lib/turbo/copy";
import { chipUsd, lev as fmtLev, liqWithDistance, price as fmtPrice, signedUsd, usd } from "@/lib/turbo/format";
import { CLOSE_PCTS, DEFAULT_PREFS, FUEL_PRESETS, LEVERAGE_PRESETS, fuelOf, leverageOf, loadPrefs, savePrefs, type TurboPrefs } from "@/lib/turbo/prefs";
import { dangerLevel, dangerOf, isBigWin, jetstreamL, liqAltOf, pnlToAlt, FLIGHT_BASE_ALT } from "@/lib/turbo/flight";
import TurboFlight, { type TurboFlightHandle } from "./TurboFlight";
import TurboFundingSheet from "./TurboFundingSheet";
import TurboHowItWorks from "./TurboHowItWorks";
import TurboShareCard, { type TurboShare } from "./TurboShareCard";
import TurboSupernova from "./TurboSupernova";
import s from "./turbo.module.css";

const MARKETS: Market[] = ["BTC", "ETH"];
const sideWord = (side: Side) => (side === "long" ? C.boost : C.dump);

/* ---------- chip row: four presets + custom, like today's buy bar ---------- */
function ChipRow({ label, opts, fmt, sel, custom, onPick, onCustom, disabledReason, testid, unit }: {
  label: string; opts: readonly number[]; fmt: (v: number) => string; sel: number; custom: number;
  onPick: (i: number) => void; onCustom: (v: number) => void; disabledReason?: (v: number) => string | null; testid: string; unit: "$" | "×";
}) {
  const [val, setVal] = useState(custom > 0 && sel < 0 ? String(custom) : "");
  useEffect(() => { if (sel >= 0) setVal(""); }, [sel]);
  return (
    <div className={s.chipBlock}>
      <div className={s.k}>{label}</div>
      <div className={s.chips}>
        {opts.map((o, i) => { const why = disabledReason?.(o) ?? null; return (
          <button key={o} type="button" className={`${s.chip} ${i === sel ? s.chipSel : ""}`} aria-pressed={i === sel} disabled={!!why} title={why ?? undefined}
            data-testid={`${testid}-${i}`} onClick={() => onPick(i)}>{fmt(o)}{why && <span className={s.chipWhy}>{why}</span>}</button>); })}
      </div>
      <form className={s.customRow} onSubmit={(e) => { e.preventDefault(); const n = +val; if (n > 0) onCustom(n); }}>
        <span className={s.k}>{C.custom}</span>
        <label className={`${s.field} ${sel < 0 ? s.fieldOn : ""}`}>{unit === "$" && <span>$</span>}
          <input inputMode="decimal" aria-label={`${C.custom} ${label.toLowerCase()}`} data-testid={`${testid}-custom`} placeholder={unit === "$" ? "0.00" : "0"} value={val}
            onChange={(e) => setVal(e.target.value.replace(/[^0-9.]/g, ""))} onBlur={() => { const n = +val; if (n > 0) onCustom(n); }} />
          {unit === "×" && <span>×</span>}</label>
        <button type="submit" className={s.setBtn} disabled={!(+val > 0)}>{C.set}</button>
      </form>
    </div>
  );
}

/* ---------- rows ---------- */
const Row = ({ k, v, tone, testid }: { k: string; v: string; tone?: "up" | "down" | "liq"; testid?: string }) => (
  <div className={s.row} data-testid={testid}><span className={s.k}>{k}</span><span className={`${s.v} ${tone ? s[tone] : ""}`}>{v}</span></div>
);

function PositionCard({ p, onClose, busy }: { p: Position; onClose: (pct: ClosePct) => void; busy: boolean }) {
  const mark = p.markPrice ?? p.entry, pending = p.status === "pending";
  return (
    <div className={s.card} data-testid="turbo-position-card" data-status={p.status}>
      <div className={s.cardHead}>
        <span className={p.side === "long" ? s.up : s.down}>{sideWord(p.side)} {p.market}</span>
        <span className={s.levTag}>{fmtLev(p.leverage)}</span>
      </div>
      {pending ? <div className={s.pendingBig}>{C.waitingFill}</div> : <>
        <div className={s.k}>{C.pnlAfter}</div>
        <div className={`${s.bigPnl} ${p.pnlAfterFeesUsd >= 0 ? s.up : s.down}`} data-testid="turbo-pnl-after">{signedUsd(p.pnlAfterFeesUsd)}</div>
      </>}
      <Row k={C.size} v={usd(p.sizeUsd)} />
      <Row k={C.fuelIn} v={usd(p.collateralUsd)} />
      <Row k={pending ? C.entryEst : C.entry} v={fmtPrice(p.entry)} />
      <Row k={C.now} v={fmtPrice(mark)} />
      <Row k={C.liq} v={liqWithDistance(p.liqPrice, mark)} tone="liq" testid="turbo-card-liq" />
      {!pending && <>
        <Row k={C.funding} v={p.fundingUsd === 0 ? C.fundingOff : signedUsd(p.fundingUsd)} />
        <Row k={C.feesPaid} v={usd(p.openFeeUsd)} />
        <Row k={C.closeFee} v={usd(p.closeFeeUsdEst)} />
        <Row k={C.loseIfLiq} v={usd(p.collateralUsd)} />
        <Row k={C.pnlBefore} v={signedUsd(p.pnlUsd)} />
      </>}
      <div className={s.closeRow}>
        {CLOSE_PCTS.map((pct) => <button key={pct} type="button" className={s.closeBtn} disabled={pending || busy} data-testid={`turbo-card-close-${pct}`} onClick={() => onClose(pct)}>{pct}%</button>)}
      </div>
    </div>
  );
}

/* ---------- picker sheet (chip on BOOST / DUMP): two rows, fuel $ and leverage × ---------- */
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
  const [sheet, setSheet] = useState<null | "fund" | "how" | { pick: Side }>(null);
  const [share, setShare] = useState<TurboShare | null>(null);
  const [nova, setNova] = useState<null | { short: boolean; label: string; share: TurboShare }>(null);
  const flight = useRef<TurboFlightHandle>(null);
  const fuelAtOpen = useRef<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const [pageOpenedAt] = useState(() => Date.now());

  /* ---- taps: adapter first, visuals after (never awaited) ---- */
  const open = async (side: Side) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = adapter.open({ market, side, collateralUsd: fuelUsd, leverage });
      flight.current?.ignite();   // rocket ignites at the tap; numbers wait for the fill
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

  /* ---- events → toasts, SUPERNOVA, share cards ---- */
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
      if (isBigWin(profit, fuelIn)) setShare({ ...base, kind: "win", profitUsd: profit });
    }
  }, [lastEvent, flash]);

  /* ---- flight feed: altitude = PnL after fees; fx from the live position ---- */
  const danger = active && active.status === "open" ? dangerOf(active) : 0;
  const level = dangerLevel(danger);
  useEffect(() => {
    const f = flight.current; if (!f) return;
    const live = active && active.status === "open";
    const ppa = f.pxPerAlt();
    const alt = live ? pnlToAlt(active.side, active.pnlAfterFeesUsd, active.collateralUsd, ppa) : FLIGHT_BASE_ALT;
    f.setAlt(alt);
    const liqMcap = active ? f.altToMcap(liqAltOf(active, ppa)) ?? undefined : undefined;
    f.setFx({ open: !!live, pending: active?.status === "pending", side: active?.side ?? null, lev: active?.leverage ?? leverage, danger,
      dive: active?.side === "short", liqMcap, liqLabel: active ? `${C.liqShort.toUpperCase()} ${fmtPrice(active.liqPrice)}` : undefined });
  }, [active, danger, leverage, px]);

  const pendingLong = active?.status === "pending" && active.openedAt != null && now - active.openedAt > 60_000;
  const waitingPrice = !hasPx && now - pageOpenedAt > 3000;
  const L = jetstreamL(active?.leverage ?? leverage);
  const showClose = !!active && !adding;
  const chipLabel = `${chipUsd(fuelUsd)} · ${fmtLev(leverage)}`;

  const tradeBar = (
    <div className={s.bar} data-testid="turbo-trade-bar">
      {showClose ? <>
        <div className={s.closeBar}>
          <span className={s.closeLbl}>{C.close}</span>
          {CLOSE_PCTS.map((pct) => <button key={pct} type="button" className={s.barClose} disabled={busy || active!.status !== "open"} data-testid={`turbo-close-${pct}`} onClick={() => close(active!, pct)}>{pct}%</button>)}
        </div>
        <button type="button" className={s.addBtn} data-testid="turbo-add" onClick={() => setAdding(true)}>{C.add}</button>
      </> : (["long", "short"] as Side[]).map((side) => (
        <div key={side} className={`${s.tb} ${side === "long" ? s.tbBoost : s.tbDump}`}>
          <button type="button" className={s.tbBody} data-testid={side === "long" ? "turbo-boost" : "turbo-dump"} disabled={busy || !hasPx} title={side === "long" ? C.boostHint : C.dumpHint}
            onClick={() => open(side)}>{side === "long" ? "▲ " : "▼ "}{sideWord(side)}</button>
          <button type="button" className={s.tbChip} data-testid={side === "long" ? "turbo-chip-boost" : "turbo-chip-dump"} aria-haspopup="dialog" onClick={() => setSheet({ pick: side })}>{chipLabel} ⌄</button>
        </div>))}
      {adding && active && <button type="button" className={s.addBtn} onClick={() => setAdding(false)}>{C.backToClose}</button>}
    </div>
  );

  return (
    <div className={s.page} data-testid="turbo-screen" data-adapter={adapter.kind}>
      {/* top bar: market picker, price, Turbo fuel, Add fuel */}
      <header className={s.top}>
        <div className={s.markets} role="tablist" aria-label="Market">
          {MARKETS.map((m) => <button key={m} role="tab" type="button" aria-selected={m === market} className={`${s.mkt} ${m === market ? s.mktSel : ""}`} data-testid={`turbo-market-${m}`}
            onClick={() => setPrefs({ ...prefs, market: m })}><b>{m}</b><span>{fmtPrice(prices[m] ?? NaN)}</span></button>)}
        </div>
        <div className={s.fuelBox}>
          <span className={s.k}>{C.fuel}</span>
          <b data-testid="turbo-fuel">{fuel == null ? "—" : usd(fuel)}</b>
          <button type="button" className={s.addFuel} data-testid="turbo-add-fuel" onClick={() => setSheet("fund")}>{C.addFuel}</button>
        </div>
        <button type="button" className={s.howLink} onClick={() => setSheet("how")}>{C.howItWorks}</button>
      </header>
      {standIn && <div className={s.notice} data-testid="turbo-standin-notice">{C.notConnected}</div>}

      <div className={s.main}>
        <section className={s.stage}>
          <TurboFlight ref={flight} className={`${s.flight} ${active?.status === "open" && active.leverage >= 1000 ? s.shimmer : ""}`} />
          {/* HUD over the flight (phone v3 order: price pill, danger gauge, PnL line) */}
          <div className={`${s.hud} ${s["danger_" + level]}`} style={{ ["--L" as string]: L.toFixed(3) }}>
            <div className={s.pricePill} data-testid="turbo-price">{market} {hasPx ? fmtPrice(px!) : C.waitingPrice}</div>
            {active && active.status === "open" && <div className={s.gauge} aria-label="How close the price is to liquidation"><i style={{ width: `${Math.round(danger * 100)}%` }} /></div>}
            {level === "hot" && <div className={s.dangerTxt}>{C.runningHot}</div>}
            {(level === "shudder" || level === "blow") && <div className={`${s.dangerTxt} ${s.dangerRed}`}>{level === "blow" ? C.aboutToBlow : C.runningHot}</div>}
            {active && <div className={s.hudPnl}>
              {active.status === "pending" ? (pendingLong ? C.waitingPrice : C.waitingFill)
                : <><span className={active.pnlAfterFeesUsd >= 0 ? s.up : s.down}>{signedUsd(active.pnlAfterFeesUsd)}</span> <small>{C.pnlAfter.toLowerCase()}</small></>}
              <div className={s.hudLiq} data-testid="turbo-hud-liq">{C.liqShort} {liqWithDistance(active.liqPrice, active.markPrice ?? active.entry)}</div>
            </div>}
            {!active && qLong && qShort && <div className={s.hudLiq} data-testid="turbo-hud-liq-preview">
              {C.liqShort} if you BOOST {liqWithDistance(qLong.liqPrice, qLong.entryEst)} · if you DUMP {liqWithDistance(qShort.liqPrice, qShort.entryEst)}</div>}
            {waitingPrice && <div className={s.hudPnl}>{C.waitingPrice}</div>}
          </div>
          {tradeBar}
        </section>

        <aside className={s.side}>
          {active ? <PositionCard p={active} busy={busy} onClose={(pct) => close(active, pct)} /> : null}
          {(!active || adding) && <div className={s.card} data-testid="turbo-ticket">
            <ChipRow label={C.fuelLabel} unit="$" testid="turbo-fuel-chip" opts={FUEL_PRESETS} fmt={chipUsd} sel={prefs.fuelIdx} custom={prefs.fuelCustom}
              onPick={(i) => setPrefs({ ...prefs, fuelIdx: i })} onCustom={(v) => setPrefs({ ...prefs, fuelIdx: -1, fuelCustom: v })} />
            <ChipRow label={C.leverageLabel} unit="×" testid="turbo-lev-chip" opts={LEVERAGE_PRESETS} fmt={(v) => `${v}×`} sel={prefs.levIdx} custom={prefs.levCustom} disabledReason={levWhy}
              onPick={(i) => setPrefs({ ...prefs, levIdx: i })} onCustom={(v) => setPrefs({ ...prefs, levIdx: -1, levCustom: v })} />
            <div className={s.rows}>
              <Row k={C.size} v={qLong ? usd(qLong.sizeUsd) : "—"} />
              <Row k={C.fuelIn} v={usd(fuelUsd)} />
              <Row k={C.entryEst} v={qLong ? fmtPrice(qLong.entryEst) : C.waitingPrice} />
              <Row k={C.openFee} v={qLong ? usd(qLong.openFeeUsd) : "—"} />
              <Row k={C.closeFee} v={qLong ? usd(qLong.closeFeeUsd) : "—"} />
              <Row k={`${C.liqShort} if you BOOST`} v={qLong ? liqWithDistance(qLong.liqPrice, qLong.entryEst) : "—"} tone="liq" testid="turbo-liq-boost" />
              <Row k={`${C.liqShort} if you DUMP`} v={qShort ? liqWithDistance(qShort.liqPrice, qShort.entryEst) : "—"} tone="liq" testid="turbo-liq-dump" />
            </div>
          </div>}
        </aside>
      </div>

      <section className={s.positions} data-testid="turbo-positions">
        <div className={s.k}>{C.positions} ({positions.length})</div>
        {positions.length === 0 ? <p className={s.muted}>{C.noPositions}</p> : (
          <table className={s.table}><thead><tr><th>Market</th><th>{C.size}</th><th>{C.fuelIn}</th><th>{C.entry}</th><th>{C.now}</th><th>{C.liq}</th><th>{C.pnlAfter}</th><th>{C.close}</th></tr></thead>
            <tbody>{positions.map((p) => <tr key={p.id} data-status={p.status}>
              <td><span className={p.side === "long" ? s.up : s.down}>{sideWord(p.side)}</span> {p.market} {fmtLev(p.leverage)}</td>
              <td>{usd(p.sizeUsd)}</td><td>{usd(p.collateralUsd)}</td><td>{fmtPrice(p.entry)}</td><td>{fmtPrice(p.markPrice ?? p.entry)}</td>
              <td className={s.liq}>{fmtPrice(p.liqPrice)}</td>
              <td className={p.pnlAfterFeesUsd >= 0 ? s.up : s.down}>{p.status === "pending" ? C.waitingFill : signedUsd(p.pnlAfterFeesUsd)}</td>
              <td>{CLOSE_PCTS.map((pct) => <button key={pct} type="button" className={s.miniClose} disabled={busy || p.status !== "open"} onClick={() => close(p, pct)}>{pct}%</button>)}</td>
            </tr>)}</tbody></table>)}
      </section>

      {toast && <div className={`${s.toast} ${toast.tone ? s[toast.tone] : ""}`} role="status" data-testid="turbo-toast">{toast.txt}</div>}
      {sheet === "fund" && <TurboFundingSheet adapter={adapter} onClose={() => setSheet(null)} />}
      {sheet === "how" && <TurboHowItWorks onClose={() => setSheet(null)} />}
      {sheet && typeof sheet === "object" && <Picker side={sheet.pick} prefs={prefs} setPrefs={setPrefs} levWhy={levWhy} onClose={() => setSheet(null)} />}
      {nova && <TurboSupernova short={nova.short} label={nova.label} onDone={() => { setShare(nova.share); setNova(null); }} />}
      {share && <TurboShareCard data={share} onClose={() => setShare(null)} />}
    </div>
  );
}
