"use client";
/**
 * TURBO lab screen (GAME). Hidden page /turbo-lab renders this. All trading goes through SITE's adapter
 * (getTurboAdapter() from lib/turbo): mock prices, practice fuel, no real money, no network.
 *   BOOST = long, DUMP = short (Dive run). Bet chips $ + leverage presets (editable, persisted). One-tap close 25/50/100%.
 *   Optional TP/SL behind a toggle. Danger zone: wipeout line, heat, rocket-only shake, beeps at 20/10/5%.
 *   Wipeout → SUPERNOVA + share card; big wins → share card. One-time 1000× heads-up. Phone layout under 740 px.
 * Every string is in lib/turbo/copy.ts (BRAND placeholder).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getTurboAdapter, type Market, type Position, type Side, type TurboEvent } from "@/lib/turbo";
import { pnlBreakdown } from "@/lib/turbo/math";
import { useTurboFuel } from "@/lib/turbo/useTurboFuel";
import TurboFuelPanel from "@/components/turbo/TurboFuelPanel";
import { T } from "@/lib/turbo/copy";
import { chip, pct as fpct, price as fp, signedUsd, usd } from "@/lib/turbo/format";
import { heatOf, isBigWin, nextBeep, tpSlProblem, wipeoutDistance, wipeoutPctAway } from "@/lib/turbo/gameFx";
import { DEFAULT_PREFS, loadPrefs, needsHeadsUp, savePrefs, setBetPreset, setLevPreset, type TurboPrefs } from "@/lib/turbo/prefs";
import { beep, ignite, setTurboMuted, supernova } from "@/lib/turbo/sound";
import { TurboScene } from "./turboScene";
import TurboPositionCard from "./TurboPositionCard";
import TurboShareCard, { type TurboShareData } from "./TurboShareCard";

const PHONE_W = 740;   // = components/flight/PhoneHud PHONE_W
const MARKETS: Market[] = ["BTC", "ETH"];
type Track = { bet0: number; back: number; side: Side; lev: number; market: Market };

export default function TurboScreen() {
  const a = useMemo(() => getTurboAdapter(), []);
  const fuel = useTurboFuel();
  const [prefs, setPrefsS] = useState<TurboPrefs>(DEFAULT_PREFS);
  const [ready, setReady] = useState(false);
  const [px, setPx] = useState<Record<Market, number>>({ BTC: 0, ETH: 0 });
  const [positions, setPositions] = useState<Position[]>([]);
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "bad" | "info" } | null>(null);
  const [share, setShare] = useState<TurboShareData | null>(null);
  const [headsUp, setHeadsUp] = useState<null | { lev: number; i: number; then?: Side }>(null);
  const [sheet, setSheet] = useState(false);
  const [editLev, setEditLev] = useState(false);
  const [fuelOpen, setFuelOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const [tp, setTp] = useState(""); const [sl, setSl] = useState("");
  const [phone, setPhone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [boom, setBoom] = useState(false);
  const cvRef = useRef<HTMLCanvasElement>(null);
  const scene = useRef<TurboScene | null>(null);
  const track = useRef(new Map<string, Track>());
  const armed = useRef(0); const lastBeep = useRef(0); const pendingShare = useRef<TurboShareData | null>(null);
  const toastT = useRef<ReturnType<typeof setTimeout> | null>(null);

  const say = useCallback((msg: string, kind: "ok" | "bad" | "info" = "info", ms = 2600) => {
    setToast({ msg, kind }); if (toastT.current) clearTimeout(toastT.current); toastT.current = setTimeout(() => setToast(null), ms);
  }, []);
  const setPrefs = useCallback((f: (p: TurboPrefs) => TurboPrefs) => setPrefsS((p) => { const n = f(p); savePrefs(localStorage, n); return n; }), []);

  // prefs + layout
  useEffect(() => { const p = loadPrefs(localStorage); setPrefsS(p); setTurboMuted(p.muted); setReady(true);
    const r = () => setPhone(innerWidth < PHONE_W); r(); addEventListener("resize", r); return () => removeEventListener("resize", r); }, []);
  useEffect(() => { setTurboMuted(prefs.muted); }, [prefs.muted]);
  const market = prefs.market, price = px[market];

  // prices
  useEffect(() => { const offs = MARKETS.map((m) => a.subscribePrice(m, ({ price }) => setPx((o) => (o[m] === price ? o : { ...o, [m]: price })))); return () => offs.forEach((f) => f()); }, [a]);
  // positions: events + light poll (funding / mark)
  const refresh = useCallback(() => { a.getPositions().then(setPositions).catch(() => {}); }, [a]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 1000); return () => clearInterval(t); }, [refresh]);
  useEffect(() => a.onEvent((e: TurboEvent) => {
    const p = e.position, tr = track.current.get(p.id);
    if (e.type === "pending") { track.current.set(p.id, { bet0: p.collateralUsd, back: 0, side: p.side, lev: p.leverage, market: p.market }); ignite(); scene.current?.ignite(); }
    if (e.type === "failed") { track.current.delete(p.id); say(e.reason && e.reason.length > 12 ? e.reason : T.failed, "bad", 3200); }
    if (e.type === "partial-closed") { const back = e.returnedUsd ?? 0; if (tr) tr.back += back; say(T.closedPartial(e.pct ?? 0, usd(back)), "ok"); }
    if (e.type === "closed" && tr) {
      tr.back += e.returnedUsd ?? Math.max(0, p.collateralUsd + p.pnlAfterFeesUsd);
      const pnl = tr.back - tr.bet0; track.current.delete(p.id);
      say(e.reason === "tp" ? `${T.closedTp} · ${signedUsd(pnl)}` : e.reason === "sl" ? `${T.closedSl} · ${signedUsd(pnl)}` : T.closedWin(signedUsd(pnl)), pnl >= 0 ? "ok" : "bad", 3200);
      if (isBigWin(pnl, tr.bet0)) setShare({ kind: "win", pnlUsd: pnl, betUsd: tr.bet0, leverage: tr.lev, market: tr.market, side: tr.side, at: Date.now() });
    }
    if (e.type === "liquidated") {
      const bet0 = tr?.bet0 ?? p.collateralUsd, pnl = (tr?.back ?? 0) + (e.returnedUsd ?? 0) - bet0; track.current.delete(p.id);
      pendingShare.current = { kind: "wipeout", pnlUsd: pnl, betUsd: bet0, leverage: p.leverage, market: p.market, side: p.side, at: Date.now() };
      supernova(); say(T.wipedOut(usd(bet0)), "bad", 4200);
      if (scene.current) { setBoom(true); scene.current.supernova(); } else setShare(pendingShare.current);
    }
    refresh();
  }), [a, refresh, say]);

  // scene
  useEffect(() => {
    if (!cvRef.current) return; const s = new TurboScene(cvRef.current); scene.current = s;
    s.onSupernovaCard = () => { setBoom(false); if (pendingShare.current) { setShare(pendingShare.current); pendingShare.current = null; } };
    const r = () => s.resize(); addEventListener("resize", r);
    const w = window as unknown as { __turboLab?: unknown };
    w.__turboLab = { adapter: a, scene: s };   // hidden lab only: screenshots / console (practice adapter controls)
    return () => { removeEventListener("resize", r); s.destroy(); scene.current = null; delete w.__turboLab; };
  }, [a, ready]);

  // the active position on this market, with live numbers
  const raw = positions.find((p) => p.market === market && (p.status === "pending" || p.status === "open")) || null;
  const pos = useMemo(() => {
    if (!raw || !(price > 0) || raw.status !== "open") return raw;
    const feeBps = raw.sizeUsd > 0 ? (raw.openFeeUsd / raw.sizeUsd) * 1e4 : 0;
    const b = pnlBreakdown({ side: raw.side, sizeUsd: raw.sizeUsd, entry: raw.entry, price, openFeeUsd: raw.openFeeUsd, fundingUsd: raw.fundingUsd, feeBps });
    return { ...raw, ...b };
  }, [raw, price]);
  const open = pos && pos.status === "open" ? pos : null;
  const dist = open ? wipeoutDistance(open.entry, open.liqPrice, price) : 1;
  const heat = open ? heatOf(dist) : 0;
  const lev = prefs.lev[prefs.levSel], bet = prefs.bets[prefs.betSel];
  const markets = useMemo(() => a.getMarkets?.() ?? MARKETS.map((m) => ({ market: m, maxLeverage: 1000 })), [a]);
  const maxLev = markets.find((m) => m.market === market)?.maxLeverage ?? 1000;
  const q = useMemo(() => (price > 0 ? a.quote({ market, side: "long", collateralUsd: bet, leverage: Math.min(lev, maxLev) }) : null), [a, market, bet, lev, maxLev, price]);

  // beeps at 20 / 10 / 5 % of the entry → wipeout distance (re-armed with hysteresis), repeating fast at ≤5%
  useEffect(() => {
    if (!open) { armed.current = 0; return; }
    const r = nextBeep(armed.current, dist); armed.current = r.armed; const now = performance.now();
    if (r.beep) { beep(r.beep); lastBeep.current = now; } else if (r.armed >= 3 && now - lastBeep.current > 700) { beep(3); lastBeep.current = now; }
  }, [open, dist]);

  // feed the scene
  useEffect(() => {
    const s = scene.current; if (!s || !(price > 0)) return;
    const w = typeof window !== "undefined" ? innerWidth : 1200;
    s.set({ price, lev, heat, roiPct: open ? (open.pnlAfterFeesUsd / Math.max(1e-9, open.collateralUsd)) * 100 : 0,
      pos: pos ? { side: pos.side, entry: pos.entry, liq: pos.liqPrice, lev: pos.leverage, tp: pos.tpPrice, sl: pos.slPrice, pending: pos.status === "pending" } : null,
      xFrac: phone ? 0.5 : Math.max(0.3, (w - 360) / 2 / w), topPad: phone ? 230 : 96, bottomPad: phone ? 200 : 210, fmtPrice: fp });
  }, [pos, open, price, lev, heat, phone]);

  // actions
  const doOpen = useCallback(async (side: Side, levOverride?: number) => {
    const L = levOverride ?? lev;
    if (busy) return; if ((fuel.usd ?? 0) < bet) { say(T.notEnoughFuel, "bad"); setFuelOpen(true); return; }
    const tpN = prefs.tpsl ? +tp || undefined : undefined, slN = prefs.tpsl ? +sl || undefined : undefined;
    if (prefs.tpsl && (tpN || slN)) { const qq = a.quote({ market, side, collateralUsd: bet, leverage: L }); const bad = tpSlProblem(side, price, qq.liqPrice, tpN, slN); if (bad) { say(T.tpslBad[bad], "bad"); return; } }
    setBusy(true);
    try { await a.open({ market, side, collateralUsd: bet, leverage: L, tpPrice: tpN, slPrice: slN }); }
    catch (e) { say(e instanceof Error ? e.message : T.failed, "bad", 3400); }
    finally { setBusy(false); }
  }, [a, busy, fuel.usd, bet, lev, market, price, prefs.tpsl, tp, sl, say]);
  const trade = (side: Side) => { if (needsHeadsUp(prefs, lev)) { setHeadsUp({ lev, i: prefs.levSel, then: side }); return; } void doOpen(side); };
  const close = async (p: 25 | 50 | 100) => { if (!open) return; try { await a.close(open.id, p); } catch (e) { say(e instanceof Error ? e.message : T.failed, "bad"); } };
  const pickLev = (i: number) => { const L = prefs.lev[i]; if (needsHeadsUp(prefs, L)) { setHeadsUp({ lev: L, i }); return; } setPrefs((p) => ({ ...p, levSel: i })); };
  const ackHeadsUp = () => { const h = headsUp; if (!h) return; setPrefs((p) => ({ ...p, seen1000: true, levSel: h.i })); setHeadsUp(null); if (h.then) void doOpen(h.then, h.lev); };
  const applyTpSl = async () => {
    if (!open) return; const tpN = +tp || undefined, slN = +sl || undefined; const bad = tpSlProblem(open.side, price, open.liqPrice, tpN, slN);
    if (bad) { say(T.tpslBad[bad], "bad"); return; }
    try { await a.setTpSl(open.id, { tpPrice: tpN, slPrice: slN }); refresh(); say(T.tpslSet, "ok", 1200); } catch (e) { say(e instanceof Error ? e.message : T.failed, "bad"); }
  };
  const again = () => { setShare(null); };

  const hu = headsUp && price > 0 ? a.quote({ market, side: "long", collateralUsd: bet, leverage: headsUp.lev }) : null;
  const danger = open ? (heat > 0.9 ? T.dangerBlow : heat > 0.5 ? T.dangerHot : "") : "";
  const levChips = (
    <div className="tb-chips" role="group" aria-label={T.leverage} data-testid="turbo-lev">
      {prefs.lev.map((L, i) => editLev
        ? <input key={i} className="tb-chip tb-chip-in" aria-label={`${T.leverage} preset ${i + 1}`} inputMode="numeric" defaultValue={L}
            onBlur={(e) => setPrefs((p) => setLevPreset(p, i, e.target.value))} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        : <button key={i} type="button" className={`tb-chip${i === prefs.levSel ? " sel" : ""}${L >= 1000 ? " hot" : ""}`} aria-pressed={i === prefs.levSel} disabled={L > maxLev}
            title={L > maxLev ? T.maxLev(maxLev) : undefined} data-testid={`turbo-lev-${i}`} onClick={() => pickLev(i)}>{L}×</button>)}
      <button type="button" className="tb-edit" data-testid="turbo-lev-edit" onClick={() => setEditLev((v) => !v)}>{editLev ? T.donePresets : T.editPresets}</button>
    </div>);
  const betChips = (
    <div className="tb-chips" role="group" aria-label={T.bet} data-testid="turbo-bets">
      {prefs.bets.map((b, i) => editLev
        ? <input key={i} className="tb-chip tb-chip-in" aria-label={`${T.bet} preset ${i + 1}`} inputMode="decimal" defaultValue={b}
            onBlur={(e) => setPrefs((p) => setBetPreset(p, i, e.target.value))} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        : <button key={i} type="button" className={`tb-chip${i === prefs.betSel ? " sel" : ""}`} aria-pressed={i === prefs.betSel} data-testid={`turbo-bet-${i}`} onClick={() => setPrefs((p) => ({ ...p, betSel: i }))}>{chip(b)}</button>)}
    </div>);
  const tpsl = (
    <div className="tb-tpsl">
      <label className="tb-toggle"><input type="checkbox" checked={prefs.tpsl} data-testid="turbo-tpsl-toggle" onChange={(e) => setPrefs((p) => ({ ...p, tpsl: e.target.checked }))} /><span>{T.tpsl}</span></label>
      {prefs.tpsl && <div className="tb-tpsl-row">
        <label>{T.tp}<span className="tb-field">$<input inputMode="decimal" value={tp} placeholder={open?.tpPrice ? String(Math.round(open.tpPrice)) : "—"} onChange={(e) => setTp(e.target.value.replace(/[^\d.]/g, ""))} /></span></label>
        <label>{T.sl}<span className="tb-field">$<input inputMode="decimal" value={sl} placeholder={open?.slPrice ? String(Math.round(open.slPrice)) : "—"} onChange={(e) => setSl(e.target.value.replace(/[^\d.]/g, ""))} /></span></label>
        {open && <button type="button" className="tb-edit" onClick={applyTpSl}>{T.tpslSet}</button>}
      </div>}
    </div>);
  const closeRow = (
    <div className="tb-closerow" data-testid="turbo-close-row">
      {([25, 50, 100] as const).map((c) => <button key={c} type="button" className={`tb-close${c === 100 ? " all" : ""}`} data-testid={`turbo-close-${c}`} disabled={!open} onClick={() => close(c)}>{pos?.status === "pending" ? T.pending : T.closePct(c)}</button>)}
    </div>);
  const tradeBtns = (
    <div className="tb-btns">
      <button type="button" className="tb-go tb-boost" data-testid="turbo-boost" disabled={busy || !(price > 0)} onClick={() => trade("long")}>
        <span className="tb-go-l">{T.boost}</span><span className="tb-go-s">{T.boostSub}</span></button>
      <button type="button" className="tb-go tb-dump" data-testid="turbo-dump" disabled={busy || !(price > 0)} onClick={() => trade("short")}>
        <span className="tb-go-l">{T.dump}</span><span className="tb-go-s">{T.dumpSub}</span></button>
    </div>);
  const preview = q && (
    <div className="tb-card tb-preview" data-testid="turbo-preview">
      <div className="tb-card-head"><span className="tb-side">{T.preview}</span></div>
      <div className="tb-rows">
        <div className="tb-row"><span>{T.card.bet}</span><b>{usd(bet)}</b></div>
        <div className="tb-row"><span>{T.card.size}</span><b>{usd(q.sizeUsd, 0)}</b></div>
        <div className="tb-row danger"><span>{T.previewWipe}</span><b>{fpct(wipeoutPctAway("long", q.entryEst, q.liqPrice), 3)}</b></div>
        <div className="tb-row"><span>{T.card.openFee}</span><b>{usd(q.openFeeUsd)}</b></div>
        <div className="tb-row"><span>{T.card.closeFee}</span><b>{usd(q.closeFeeUsd)}</b></div>
      </div>
    </div>);

  return (
    <div className={`tb-root${phone ? " phone" : ""}${boom ? " boom" : ""}`} data-testid="turbo-root" data-heat={heat.toFixed(2)}>
      <canvas ref={cvRef} className="tb-cv" aria-hidden />
      {/* top bar */}
      <div className="tb-top">
        <div className="tb-brand">{T.title}<span className="tb-sim" title={T.simTitle} data-testid="turbo-sim">{T.simTag}</span></div>
        <div className="tb-mkts" role="tablist" aria-label="market">
          {MARKETS.map((m) => <button key={m} role="tab" type="button" aria-selected={m === market} className={`tb-mkt${m === market ? " sel" : ""}`} data-testid={`turbo-mkt-${m}`}
            onClick={() => setPrefs((p) => ({ ...p, market: m }))}><b>{m}</b><span>{px[m] > 0 ? fp(px[m]) : "…"}</span></button>)}
        </div>
        <div className="tb-fuel" data-testid="turbo-fuel">
          <span className="tb-fuel-k">{T.fuel}{fuel.practice && <i> · {T.fuelPractice}</i>}</span>
          <b>{fuel.loading ? "…" : usd(fuel.usd ?? 0)}</b>
          <button type="button" className="tb-add" data-testid="turbo-addfuel" onClick={() => setFuelOpen((v) => !v)}>{T.addFuel}</button>
        </div>
        <button type="button" className="tb-mute" data-testid="turbo-mute" aria-label={prefs.muted ? T.unmute : T.mute} aria-pressed={prefs.muted} onClick={() => setPrefs((p) => ({ ...p, muted: !p.muted }))}>{prefs.muted ? "🔇" : "🔊"}{!phone && " " + (prefs.muted ? T.unmute : T.mute)}</button>
      </div>
      {fuelOpen && <div className="tb-fuelpop" data-testid="turbo-fuelpop">
        <button type="button" className="tb-add big" onClick={() => { void fuel.addFuel(100); }}>{T.addFuelMock}</button>
        <TurboFuelPanel className="tb-fuelpanel" />
        <button type="button" className="tb-edit" onClick={() => setFuelOpen(false)}>{T.hide}</button>
      </div>}
      {/* danger + live PnL */}
      <div className="tb-center">
        {pos && <div className={`tb-hudpnl ${pos.status === "pending" ? "" : pos.pnlAfterFeesUsd >= 0 ? "up" : "down"}`} data-testid="turbo-hudpnl">
          {pos.status === "pending" ? T.pending : signedUsd(pos.pnlAfterFeesUsd)}<small>{pos.status === "pending" ? T.pendingSub : T.card.pnl}</small></div>}
        {open && <div className="tb-gauge" aria-label="distance to wipeout"><i style={{ width: `${Math.round(dist * 100)}%`, background: heat > 0.8 ? "#FF3D7F" : heat > 0.5 ? "#FFB45C" : "#5FF0A0" }} /></div>}
        {open && <div className={`tb-danger${heat > 0.5 ? " on" : ""}${heat > 0.9 ? " blow" : ""}`} data-testid="turbo-danger">{danger || T.dangerLeft(fpct(wipeoutPctAway(open.side, price, open.liqPrice), 3))}</div>}
        {!pos && <div className="tb-idle">{(fuel.usd ?? 0) < bet ? T.needFuel : T.idle}</div>}
      </div>
      {/* desktop dock */}
      {!phone && <div className="tb-dock">{pos ? <TurboPositionCard p={pos} price={price} /> : preview}</div>}
      {/* controls */}
      <div className="tb-ctrl">
        {!phone && !pos && <>{betChips}{levChips}{tpsl}</>}
        {!phone && pos && tpsl}
        {phone && pos && <button type="button" className="tb-ph-card" data-testid="turbo-phone-card" onClick={() => setCardOpen((v) => !v)}>{T.phonePosition} {cardOpen ? "⌄" : "⌃"} <b>{pos.leverage}× {pos.side === "long" ? "▲" : "▼"}</b></button>}
        {phone && pos && cardOpen && <div className="tb-ph-drawer"><TurboPositionCard p={pos} price={price} compact />{tpsl}</div>}
        {phone && !pos && <button type="button" className="tb-ph-pick" data-testid="turbo-phone-pick" onClick={() => setSheet(true)}>{T.bet} <b>{chip(bet)}</b> · {T.leverage} <b className={lev >= 1000 ? "hot" : ""}>{lev}×</b> ⌄</button>}
        {pos ? closeRow : tradeBtns}
      </div>
      {toast && <div className={`tb-toast ${toast.kind}`} role="status" data-testid="turbo-toast">{toast.msg}</div>}
      {/* phone picker sheet */}
      {sheet && <>
        <div className="ph-dim" onPointerDown={(e) => { e.preventDefault(); setSheet(false); }} />
        <div role="dialog" aria-modal="true" aria-label={T.pickerTitle} className="tb-sheet" data-testid="turbo-sheet">
          <div className="tb-sh-head"><b>{T.pickerTitle}</b><button type="button" className="tb-edit" onClick={() => setSheet(false)}>✕</button></div>
          <div className="tb-sh-k">{T.bet}</div>{betChips}
          <div className="tb-sh-k">{T.leverage}</div>{levChips}
          {tpsl}
          <div className="tb-sh-hint">{T.pickerHint}</div>
        </div></>}
      {headsUp && <div className="tb-modal-wrap" data-testid="turbo-headsup" role="dialog" aria-modal="true" aria-label={T.headsUp.title}>
        <div className="tb-modal">
          <div className="tb-modal-t">⚠ {T.headsUp.title}</div>
          <p>{T.headsUp.body}</p>
          {hu && <p className="tb-modal-live">{T.headsUp.live(fpct(wipeoutPctAway("long", hu.entryEst, hu.liqPrice), 3), usd(hu.openFeeUsd))}</p>}
          <div className="tb-modal-row">
            <button type="button" className="tb-sbtn" onClick={() => setHeadsUp(null)}>{T.headsUp.cancel}</button>
            <button type="button" className="tb-sbtn tb-primary" data-testid="turbo-headsup-ok" onClick={ackHeadsUp}>{T.headsUp.ok}</button>
          </div>
        </div></div>}
      {share && <TurboShareCard data={share} onClose={() => setShare(null)} onAgain={again} />}
      <style jsx global>{`
        .tb-root { position: fixed; inset: 0; z-index: 70; background: #070814; color: #EEF1FA; overflow: hidden; font-family: ui-monospace, Menlo, "DejaVu Sans Mono", monospace; }
        .tb-cv { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
        .tb-top { position: absolute; left: 16px; right: 16px; top: 14px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; z-index: 2; }
        .tb-brand { font-family: var(--font-geist), system-ui, sans-serif; font-weight: 900; letter-spacing: .14em; font-size: 20px; display: flex; align-items: center; gap: 8px; text-shadow: 0 0 18px rgba(255,120,170,.55); }
        .tb-sim { font-family: ui-monospace, monospace; font-size: 10px; font-weight: 700; letter-spacing: .08em; padding: 2px 6px; border-radius: 6px; background: rgba(255,231,163,.14); color: #ffe7a3; text-shadow: none; }
        .glass, .tb-mkts, .tb-fuel, .tb-mute, .tb-card, .tb-fuelpop, .tb-modal, .tb-sheet { background: rgba(18,20,38,.72); -webkit-backdrop-filter: blur(18px) saturate(1.2); backdrop-filter: blur(18px) saturate(1.2); border: 1px solid rgba(255,255,255,.10); box-shadow: 0 10px 40px -12px rgba(0,0,0,.7), inset 0 1px 0 rgba(255,255,255,.06); }
        .tb-mkts { display: flex; border-radius: 14px; padding: 3px; gap: 3px; }
        .tb-mkt { all: unset; cursor: pointer; padding: 6px 12px; border-radius: 11px; display: flex; gap: 8px; align-items: baseline; font-size: 13px; color: rgba(214,222,245,.7); }
        .tb-mkt b { color: #EEF1FA; letter-spacing: .06em; } .tb-mkt.sel { background: rgba(255,255,255,.09); color: #EEF1FA; box-shadow: inset 0 0 0 1px rgba(255,255,255,.14); }
        .tb-fuel { display: flex; align-items: center; gap: 10px; border-radius: 14px; padding: 5px 6px 5px 12px; font-size: 13px; }
        .tb-fuel-k { color: rgba(214,222,245,.62); } .tb-fuel-k i { font-style: normal; color: #ffe7a3; } .tb-fuel b { font-size: 15px; }
        .tb-add { all: unset; cursor: pointer; padding: 6px 10px; border-radius: 10px; background: rgba(47,217,138,.16); color: #9FF5C8; border: 1px solid rgba(47,217,138,.35); font-weight: 700; font-size: 12px; letter-spacing: .04em; }
        .tb-add.big { padding: 10px 14px; text-align: center; }
        .tb-mute { all: unset; cursor: pointer; margin-left: auto; padding: 7px 11px; border-radius: 12px; font-size: 12px; }
        .tb-fuelpop { position: absolute; top: 64px; left: 16px; z-index: 5; border-radius: 18px; padding: 12px; display: grid; gap: 10px; width: 290px; }
        .tb-fuelpanel { font-size: 13px; } .tb-fuelpanel button { all: unset; cursor: pointer; padding: 5px 9px; border-radius: 9px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.12); font-size: 12px; }
        .tb-fuelpanel button[aria-pressed="true"] { border-color: #2FD98A; color: #9FF5C8; } .tb-fuelpanel button:disabled { opacity: .45; }
        .tb-fuelpanel input { all: unset; padding: 4px 8px; border-radius: 8px; background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.12); }
        .tb-fuelpanel .tag { font-size: 10px; padding: 1px 6px; border-radius: 6px; background: rgba(255,231,163,.14); color: #ffe7a3; } .tb-fuelpanel .muted { color: rgba(214,222,245,.55); font-size: 11px; }
        .tb-center { position: absolute; left: 0; right: 360px; top: 74px; display: grid; justify-items: center; gap: 8px; pointer-events: none; z-index: 1; }
        .tb-root.phone .tb-center { right: 0; top: 128px; }
        .tb-hudpnl { font-family: var(--font-geist), system-ui, sans-serif; font-weight: 900; font-size: 44px; line-height: 1; text-align: center; text-shadow: 0 0 24px rgba(0,0,0,.6); display: grid; gap: 4px; }
        .tb-hudpnl small { font-family: ui-monospace, monospace; font-size: 11px; font-weight: 600; letter-spacing: .08em; color: rgba(214,222,245,.65); }
        .tb-hudpnl.up { color: #5FF0A0; text-shadow: 0 0 28px rgba(95,240,160,.55); } .tb-hudpnl.down { color: #FF5A93; text-shadow: 0 0 28px rgba(240,48,127,.55); }
        .tb-root.phone .tb-hudpnl { font-size: 34px; }
        .tb-gauge { width: 220px; height: 5px; border-radius: 3px; background: rgba(255,255,255,.12); overflow: hidden; } .tb-gauge i { display: block; height: 100%; border-radius: 3px; transition: width .2s; }
        .tb-danger { font-size: 12px; letter-spacing: .08em; color: rgba(214,222,245,.7); padding: 4px 10px; border-radius: 10px; background: rgba(10,10,24,.55); }
        .tb-danger.on { color: #FFB45C; font-weight: 800; } .tb-danger.blow { color: #fff; background: rgba(240,48,127,.75); animation: tbpulse .35s infinite alternate; font-size: 15px; }
        @keyframes tbpulse { from { transform: scale(1); } to { transform: scale(1.08); } }
        .tb-idle { font-size: 13px; color: rgba(214,222,245,.7); background: rgba(10,10,24,.5); padding: 6px 12px; border-radius: 12px; }
        .tb-dock { position: absolute; right: 16px; top: 74px; width: 330px; z-index: 2; }
        .tb-card { border-radius: 20px; padding: 14px 16px; font-size: 12.5px; }
        .tb-card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
        .tb-side { font-weight: 800; letter-spacing: .08em; font-size: 12px; color: rgba(214,222,245,.8); } .tb-side.long { color: #5FF0A0; } .tb-side.short { color: #FF7FA8; }
        .tb-pend { font-size: 11px; color: #ffe7a3; animation: tbpulse .6s infinite alternate; }
        .tb-big { font-family: var(--font-geist), system-ui, sans-serif; font-weight: 900; font-size: 38px; line-height: 1.05; } .tb-big.up { color: #5FF0A0; } .tb-big.down { color: #FF5A93; }
        .tb-big-sub { font-size: 11px; color: rgba(214,222,245,.55); margin-bottom: 8px; }
        .tb-rows { display: grid; gap: 3px; } .tb-row { display: flex; justify-content: space-between; gap: 10px; padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,.05); }
        .tb-row span { color: rgba(214,222,245,.6); } .tb-row b { font-weight: 700; text-align: right; } .tb-row.danger b { color: #FF8FB0; }
        .tb-card-foot { margin-top: 8px; font-size: 11px; color: rgba(214,222,245,.5); }
        .tb-card.compact { padding: 10px 12px; } .tb-card.compact .tb-big { font-size: 26px; }
        .tb-ctrl { position: absolute; left: 0; right: 360px; bottom: 22px; display: grid; justify-items: center; gap: 10px; z-index: 3; padding: 0 16px; }
        .tb-root.phone .tb-ctrl { right: 0; }
        .tb-chips { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: center; }
        .tb-chip { all: unset; box-sizing: border-box; cursor: pointer; min-width: 66px; height: 40px; padding: 0 12px; border-radius: 13px; display: grid; place-items: center; font-weight: 800; font-size: 15px;
          background: rgba(18,20,38,.72); border: 1px solid rgba(255,255,255,.12); color: #EEF1FA; -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); }
        .tb-chip.sel { background: rgba(47,217,138,.16); border: 1.5px solid #2FD98A; color: #9FF5C8; box-shadow: 0 0 22px -8px rgba(47,217,138,.8); }
        .tb-chip.hot.sel { background: rgba(255,61,127,.18); border-color: #FF3D7F; color: #FFB3CC; box-shadow: 0 0 22px -6px rgba(255,61,127,.9); }
        .tb-chip:disabled { opacity: .4; cursor: not-allowed; } .tb-chip-in { width: 66px; text-align: center; cursor: text; }
        .tb-edit { all: unset; cursor: pointer; font-size: 11px; letter-spacing: .08em; padding: 6px 10px; border-radius: 10px; color: rgba(214,222,245,.75); background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1); }
        .tb-tpsl { display: grid; gap: 6px; justify-items: center; font-size: 11.5px; color: rgba(214,222,245,.7); }
        .tb-toggle { display: flex; gap: 6px; align-items: center; cursor: pointer; } .tb-toggle input { accent-color: #2FD98A; }
        .tb-tpsl-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: center; } .tb-tpsl-row label { display: flex; gap: 6px; align-items: center; }
        .tb-field { display: inline-flex; gap: 2px; padding: 4px 8px; border-radius: 9px; background: rgba(0,0,0,.4); border: 1px solid rgba(255,255,255,.12); color: #2FD98A; }
        .tb-field input { all: unset; width: 82px; color: #EEF1FA; }
        .tb-btns, .tb-closerow { display: flex; gap: 12px; width: min(620px, 100%); }
        .tb-go { all: unset; box-sizing: border-box; cursor: pointer; flex: 1 1 0; height: 76px; border-radius: 22px; display: grid; align-content: center; justify-items: start; padding: 0 22px; position: relative; -webkit-tap-highlight-color: transparent; }
        .tb-go:disabled { opacity: .5; cursor: not-allowed; }
        .tb-boost { background: linear-gradient(180deg, #36E595, #17B56C); color: #04281A; box-shadow: 0 12px 28px -10px rgba(47,217,138,.65), inset 0 1px 0 rgba(255,255,255,.35); }
        .tb-dump { background: linear-gradient(180deg, #FF5A93, #E3216A); color: #fff; box-shadow: 0 12px 28px -10px rgba(255,61,127,.6), inset 0 1px 0 rgba(255,255,255,.3); }
        .tb-go:active:not(:disabled) { filter: brightness(1.1); transform: translateY(1px); }
        .tb-go-l { font-size: 22px; font-weight: 800; letter-spacing: .08em; } .tb-go-s { font-size: 11.5px; font-weight: 700; opacity: .8; }
        .tb-close { all: unset; box-sizing: border-box; cursor: pointer; flex: 1 1 0; height: 64px; border-radius: 20px; display: grid; place-items: center; font-weight: 800; letter-spacing: .06em; font-size: 15px;
          background: rgba(18,20,38,.8); border: 1.5px solid rgba(255,255,255,.18); color: #EEF1FA; -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); }
        .tb-close.all { flex: 1.4 1 0; background: linear-gradient(180deg, #F4F6FF, #C9D0E6); color: #0B0C18; border: none; }
        .tb-close:disabled { opacity: .55; cursor: wait; }
        .tb-toast { position: absolute; left: 50%; transform: translateX(-50%); bottom: 190px; z-index: 6; padding: 8px 14px; border-radius: 12px; font-size: 13px; background: rgba(16,18,34,.9); border: 1px solid rgba(255,255,255,.14); max-width: calc(100% - 32px); }
        .tb-toast.bad { color: #FFB0C8; border-color: rgba(255,61,127,.4); } .tb-toast.ok { color: #9FF5C8; border-color: rgba(47,217,138,.4); }
        .tb-modal-wrap, .tb-share-wrap { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; background: rgba(5,6,14,.55); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); padding: 16px; }
        .tb-modal { width: min(420px, 100%); border-radius: 24px; padding: 20px; font-size: 14px; line-height: 1.45; }
        .tb-modal-t { font-family: var(--font-geist), system-ui, sans-serif; font-weight: 900; font-size: 22px; color: #FFB3CC; margin-bottom: 8px; }
        .tb-modal-live { color: #ffe7a3; font-size: 13px; } .tb-modal-row { display: flex; gap: 10px; margin-top: 14px; }
        .tb-sbtn { all: unset; box-sizing: border-box; cursor: pointer; flex: 1; text-align: center; padding: 12px 14px; border-radius: 14px; font-weight: 800; font-size: 13px; letter-spacing: .04em; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.14); color: #EEF1FA; }
        .tb-sbtn.tb-primary { background: linear-gradient(180deg, #36E595, #17B56C); color: #04281A; border: none; }
        .tb-share { width: min(720px, 100%); display: grid; gap: 10px; animation: tbup .45s cubic-bezier(.2,.9,.3,1.2); }
        @keyframes tbup { from { transform: translateY(60px); opacity: 0; } to { transform: none; opacity: 1; } }
        .tb-share-cv { width: 100%; height: auto; aspect-ratio: 1200/630; border-radius: 18px; box-shadow: 0 30px 80px -20px rgba(0,0,0,.8); border: 1px solid rgba(255,255,255,.12); }
        .tb-share-row { display: flex; gap: 10px; }
        .tb-ph-card { all: unset; cursor: pointer; font-size: 12px; letter-spacing: .06em; padding: 6px 12px; border-radius: 12px; background: rgba(18,20,38,.75); border: 1px solid rgba(255,255,255,.12); }
        .tb-ph-drawer { width: 100%; display: grid; gap: 8px; }
        .tb-sheet { position: fixed; left: 8px; right: 8px; bottom: 8px; z-index: 61; border-radius: 30px; padding: 14px 18px 20px; display: grid; gap: 10px; }
        .tb-sh-head { display: flex; justify-content: space-between; align-items: center; font-size: 15px; letter-spacing: .1em; }
        .tb-sh-k { font-size: 11px; letter-spacing: .1em; color: rgba(214,222,245,.55); }
        .tb-sh-hint { text-align: center; font-size: 11.5px; color: rgba(214,222,245,.45); }
        .tb-root .ph-dim { position: fixed; inset: 0; z-index: 60; background: rgba(5,6,14,.5); }
        .tb-root.phone .tb-top { gap: 8px; top: 10px; left: 12px; right: 12px; }
        .tb-root.phone .tb-brand { font-size: 16px; }
        .tb-root.phone .tb-mkts { order: 5; flex: 1 1 0; } .tb-root.phone .tb-mkt { flex: 1; justify-content: center; }
        .tb-root.phone .tb-fuel { font-size: 12px; margin-left: auto; } .tb-root.phone .tb-mute { order: 6; margin-left: 0; padding: 0 12px; align-self: stretch; display: grid; place-items: center; border-radius: 14px; }
        .tb-root.phone .tb-fuel-k { display: none; }
        .tb-root.phone .tb-go { height: 68px; padding: 0 14px; } .tb-root.phone .tb-go-l { font-size: 18px; } .tb-root.phone .tb-go-s { display: none; }
        .tb-root.phone .tb-close { height: 60px; font-size: 13px; }
        .tb-root.phone .tb-toast { bottom: 110px; }
        .tb-root.phone .tb-fuelpop { left: 12px; right: 12px; width: auto; top: 108px; }
        .tb-sheet .tb-chip { flex: 1; height: 52px; font-size: 17px; }
        .tb-root.boom .tb-ctrl, .tb-root.boom .tb-center, .tb-root.boom .tb-dock { opacity: 0; pointer-events: none; transition: opacity .2s; }
        .tb-ph-pick { all: unset; cursor: pointer; font-size: 13px; padding: 9px 14px; border-radius: 14px; background: rgba(18,20,38,.78); border: 1px solid rgba(255,255,255,.14); color: rgba(214,222,245,.75); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); }
        .tb-ph-pick b { color: #EEF1FA; margin-left: 2px; } .tb-ph-pick b.hot { color: #FFB3CC; }
        .tb-root:not(.phone) .tb-center { left: 16px; right: auto; top: 70px; justify-items: start; }
        .tb-root:not(.phone) .tb-hudpnl { text-align: left; font-size: 40px; }
      `}</style>
    </div>
  );
}
